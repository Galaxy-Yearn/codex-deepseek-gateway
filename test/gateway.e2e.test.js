import assert from 'node:assert/strict';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createProxyServer } from '../src/server.js';
import { ReasoningCache } from '../src/reasoning-cache.js';
import { DEFAULT_MODEL_ALIASES, loadModelAliases } from '../src/model-map.js';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
}

async function withGateway(upstreamHandler, config, run) {
  const upstream = http.createServer(upstreamHandler);
  const upstreamUrl = await listen(upstream);
  const proxy = createProxyServer({
    config: {
      upstreamBaseUrl: upstreamUrl,
      upstreamApiKey: 'test-key',
      upstreamTimeoutMs: 5000,
      reasoningCacheEnabled: false,
      modelAliases: DEFAULT_MODEL_ALIASES,
      ...config,
    },
    reasoningCache: new ReasoningCache({ persistPath: '' }),
  });
  const proxyUrl = await listen(proxy);
  try {
    await run(proxyUrl);
  } finally {
    await close(proxy);
    await close(upstream);
  }
}

function parseSse(text) {
  return String(text).split(/\r?\n\r?\n/).filter((block) => block.trim()).map((block) => {
    const event = block.split(/\r?\n/).find((line) => line.startsWith('event:'))?.slice(6).trim() || null;
    const data = block.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).replace(/^ /, '')).join('\n');
    return { event, data: data === '[DONE]' ? data : JSON.parse(data) };
  });
}

test('a Codex tool turn completes and resumes through the Chat Completions bridge', async () => {
  const requests = [];
  await withGateway(async (request, response) => {
    const body = await readJsonBody(request);
    requests.push(body);
    response.writeHead(200, { 'content-type': 'application/json' });
    if (requests.length === 1) {
      response.end(JSON.stringify({
        id: 'chatcmpl-tool',
        choices: [{
          message: {
            role: 'assistant',
            content: '',
            reasoning_content: 'inspect first',
            tool_calls: [{ id: 'call_lookup', type: 'function', function: { name: 'lookup', arguments: '{"q":"codex"}' } }],
          },
          finish_reason: 'tool_calls',
        }],
      }));
      return;
    }
    response.end(JSON.stringify({
      id: 'chatcmpl-final',
      choices: [{ message: { role: 'assistant', content: 'The result is ready.' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
    }));
  }, { upstreamModel: 'deepseek-v4-pro', upstreamProvider: 'deepseek' }, async (proxyUrl) => {
    const tools = [{ type: 'function', name: 'lookup', parameters: { type: 'object', properties: { q: { type: 'string' } } } }];
    const first = await fetch(`${proxyUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-v4-pro', input: 'find the repository', tools, store: false }),
    });
    assert.equal(first.status, 200);
    const firstBody = await first.json();
    const call = firstBody.output.find((item) => item.type === 'function_call');
    assert.equal(call.call_id, 'call_lookup');
    assert.equal(call.name, 'lookup');

    const second = await fetch(`${proxyUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-v4-pro',
        input: [
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'find the repository' }] },
          { type: 'function_call', call_id: 'call_lookup', name: 'lookup', arguments: '{"q":"codex"}' },
          { type: 'function_call_output', call_id: 'call_lookup', output: '{"files":["README.md"]}' },
        ],
        tools,
        store: false,
      }),
    });
    assert.equal(second.status, 200);
    const secondBody = await second.json();
    assert.equal(secondBody.output_text, 'The result is ready.');
    assert.deepEqual(requests[1].messages.slice(-2).map((message) => message.role), ['assistant', 'tool']);
    assert.equal(requests[1].messages.at(-2).reasoning_content, 'inspect first');
    assert.equal(requests[1].messages.at(-1).tool_call_id, 'call_lookup');
    assert.equal(requests[0].tools[0].function.name, 'lookup');
  });
});

test('streaming Chat Completions becomes ordered Codex Responses events', async () => {
  await withGateway(async (_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'think first. ' }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'answer' }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } })}\n\n`);
    response.end('data: [DONE]\n\n');
  }, { upstreamModel: 'deepseek-v4-flash', upstreamProvider: 'deepseek' }, async (proxyUrl) => {
    const result = await fetch(`${proxyUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-v4-flash', input: 'answer', reasoning: { effort: 'high' }, stream: true }),
    });
    assert.equal(result.status, 200);
    const frames = parseSse(await result.text());
    const reasoningIndex = frames.findIndex((frame) => frame.event === 'response.reasoning_summary_text.delta');
    const textIndex = frames.findIndex((frame) => frame.event === 'response.output_text.delta');
    assert.ok(reasoningIndex >= 0 && textIndex > reasoningIndex);
    assert.equal(frames[textIndex].data.delta, 'answer');
    const completed = frames.find((frame) => frame.event === 'response.completed');
    assert.equal(completed.data.response.output_text, 'answer');
    assert.equal(completed.data.response.usage.total_tokens, 5);
    assert.equal(frames.at(-1).data, '[DONE]');
  });
});

test('native Responses mode preserves JSON and SSE provider contracts', async () => {
  const requests = [];
  await withGateway(async (request, response) => {
    const body = await readJsonBody(request);
    requests.push({ url: request.url, body });
    if (body.stream) {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end('event: response.created\ndata: {"type":"response.created"}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n');
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ id: 'resp-native', model: body.model, status: 'completed', output: [], output_text: 'native answer' }));
  }, { upstreamModel: 'deepseek-v4-pro', upstreamProvider: 'deepseek', upstreamWireApi: 'responses' }, async (proxyUrl) => {
    const plain = await fetch(`${proxyUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-v4-pro', input: 'native' }),
    });
    assert.equal(plain.status, 200);
    assert.equal((await plain.json()).output_text, 'native answer');

    const stream = await fetch(`${proxyUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-v4-pro', input: 'native stream', stream: true }),
    });
    assert.equal(stream.status, 200);
    const streamText = await stream.text();
    assert.match(streamText, /event: response\.created/);
    assert.match(streamText, /event: response\.completed/);
    assert.equal(requests.every((entry) => entry.url === '/responses'), true);
    assert.equal(requests[0].body.input, 'native');
  });
});

test('OrcaRouter model paths and native vision input work through the same gateway contract', async () => {
  const requests = [];
  const orcaCatalog = loadModelAliases(
    {},
    process.cwd(),
    fileURLToPath(new URL('../config/model-catalog.orcarouter.json', import.meta.url)),
  );
  await withGateway(async (request, response) => {
    const body = await readJsonBody(request);
    requests.push(body);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      id: 'chatcmpl-orca',
      choices: [{ message: { role: 'assistant', content: 'vision received' }, finish_reason: 'stop' }],
    }));
  }, {
    upstreamProvider: 'orcarouter',
    upstreamModel: 'orcarouter/auto',
    modelAliases: {
      ...orcaCatalog,
      'deepseek-v4-flash-vision-exp': { model: 'deepseek-v4-flash-vision-exp' },
    },
  }, async (proxyUrl) => {
    const result = await fetch(`${proxyUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'orcarouter/auto',
        input: [{ role: 'user', content: [
          { type: 'input_text', text: 'describe this' },
          { type: 'input_image', image_url: 'data:image/png;base64,AA==' },
        ] }],
      }),
    });
    assert.equal(result.status, 200);
    assert.equal((await result.json()).output_text, 'vision received');
    assert.equal(requests[0].model, 'orcarouter/auto');
    assert.equal(requests[0].messages[0].content[1].type, 'image_url');
    assert.equal(requests[0].messages[0].content[1].image_url.url, 'data:image/png;base64,AA==');

    const models = await fetch(`${proxyUrl}/v1/models`);
    const modelIds = (await models.json()).data.map((model) => model.id);
    assert.equal(modelIds.includes('orcarouter/auto'), true);
    assert.equal(modelIds.includes('qwen/qwen3.8-27b-free'), true);

    const nativeVision = await fetch(`${proxyUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-v4-flash-vision-exp',
        input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,AA==' }] }],
      }),
    });
    assert.equal(nativeVision.status, 200);
    assert.equal(requests[1].model, 'deepseek-v4-flash-vision-exp');
    assert.equal(requests[1].messages[0].content[0].type, 'image_url');
  });
});
