import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

async function scenario(name, run) {
  try {
    await run();
  } catch (error) {
    error.message = `${name}: ${error.message}`;
    throw error;
  }
}
import { closeServerGracefully, createProxyServer } from '../src/server.js';
import { ReasoningCache } from '../src/reasoning-cache.js';
import { DEFAULT_MODEL_ALIASES } from '../src/model-map.js';
import { createControlServer } from '../src/runtime.js';

const legacyChatModel = ['deepseek', 'chat'].join('-');
const legacyReasoningModel = ['deepseek', 'reasoner'].join('-');

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function postChunks(url, chunks) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const request = http.request({
      host: target.hostname,
      port: target.port,
      path: target.pathname,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    }, (response) => {
      const responseChunks = [];
      response.on('data', (chunk) => responseChunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        body: JSON.parse(Buffer.concat(responseChunks).toString('utf8')),
      }));
    });
    request.on('error', reject);
    for (const chunk of chunks) request.write(chunk);
    request.end();
  });
}

function parseResponsesSse(text) {
  const frames = [];
  for (const block of String(text).split(/\r?\n\r?\n/)) {
    if (!block.trim()) continue;
    let event = null;
    const dataLines = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice('event:'.length).trim();
      if (line.startsWith('data:')) dataLines.push(line.slice('data:'.length).replace(/^ /, ''));
    }
    if (!dataLines.length) continue;
    const rawData = dataLines.join('\n');
    frames.push({ event, data: rawData === '[DONE]' ? rawData : JSON.parse(rawData) });
  }
  return frames;
}

test('health, models, authentication, and request validation', async () => {
  await scenario('exposes configured model aliases on /v1/models', async () => {
  const proxy = createProxyServer({
    config: {
      serverName: 'test',
      upstreamProvider: 'deepseek',
      modelAliases: DEFAULT_MODEL_ALIASES,
    },
    reasoningCache: new ReasoningCache(),
  });
  const proxyUrl = await listen(proxy);

  try {
    const response = await fetch(`${proxyUrl}/v1/models`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.object, 'list');
    assert.equal(body.data.some((model) => model.id === 'deepseek-v4-flash'), true);
    assert.equal(body.data.some((model) => model.id === 'deepseek-v4-pro'), true);
    assert.equal(body.data.some((model) => model.id === legacyChatModel), false);
  } finally {
    await close(proxy);
  }
  });
  await scenario('returns minimal health payload', async () => {
  const proxy = createProxyServer({
    config: {
      serverName: 'test',
      upstreamProvider: 'deepseek',
      modelAliases: DEFAULT_MODEL_ALIASES,
    },
    reasoningCache: new ReasoningCache(),
  });
  const proxyUrl = await listen(proxy);

  try {
    const response = await fetch(`${proxyUrl}/health`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body, { ok: true });
  } finally {
    await close(proxy);
  }
  });
  await scenario('merges upstream models and filters deprecated DeepSeek model names', async () => {
  let upstreamCalls = 0;
  const upstream = http.createServer(async (_req, res) => {
    upstreamCalls += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      object: 'list',
      data: [
        { id: 'deepseek-v4-flash', object: 'model', owned_by: 'deepseek' },
        { id: 'deepseek-v4-pro', object: 'model', owned_by: 'deepseek' },
        { id: 'deepseek-v4-vision', object: 'model', owned_by: 'deepseek' },
        { id: legacyChatModel, object: 'model', owned_by: 'deepseek' },
      ],
    }));
  });
  const upstreamUrl = await listen(upstream);
  const proxy = createProxyServer({
    config: {
      serverName: 'test',
      upstreamBaseUrl: upstreamUrl,
      upstreamApiKey: 'test-key',
      upstreamProvider: 'deepseek',
      modelAliases: DEFAULT_MODEL_ALIASES,
      fetchUpstreamModels: true,
      modelsTimeoutMs: 5000,
      modelsCacheMs: 60000,
    },
    reasoningCache: new ReasoningCache(),
  });
  const proxyUrl = await listen(proxy);

  try {
    const response = await fetch(`${proxyUrl}/v1/models`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.data.some((model) => model.id === 'deepseek-v4-vision'), true);
    assert.equal(body.data.some((model) => model.id === legacyChatModel), false);
    assert.equal(body.data.some((model) => model.id === legacyReasoningModel), false);
    const cachedResponse = await fetch(`${proxyUrl}/v1/models`);
    assert.deepEqual(await cachedResponse.json(), body);
    assert.equal(upstreamCalls, 1);
  } finally {
    await close(proxy);
    await close(upstream);
  }
  });
  await scenario('requires configured proxy API key for v1 routes', async () => {
  const proxy = createProxyServer({
    config: {
      serverName: 'test',
      proxyApiKey: 'local-key',
      modelAliases: DEFAULT_MODEL_ALIASES,
    },
    reasoningCache: new ReasoningCache(),
  });
  const proxyUrl = await listen(proxy);

  try {
    const unauthorized = await fetch(`${proxyUrl}/v1/models`);
    assert.equal(unauthorized.status, 401);

    const authorized = await fetch(`${proxyUrl}/v1/models`, {
      headers: { authorization: 'Bearer local-key' },
    });
    assert.equal(authorized.status, 200);
  } finally {
    await close(proxy);
  }
  });
  await scenario('validates request bodies, required configuration, and unknown routes before upstream', async () => {
  let upstreamCalled = false;
  const upstream = http.createServer((_req, res) => {
    upstreamCalled = true;
    res.writeHead(500).end();
  });
  const upstreamUrl = await listen(upstream);
  const configured = createProxyServer({
    config: {
      upstreamBaseUrl: upstreamUrl,
      upstreamApiKey: 'test-key',
      upstreamProvider: 'deepseek',
      upstreamTimeoutMs: 5000,
    },
    reasoningCache: new ReasoningCache(),
  });
  const missingKey = createProxyServer({
    config: {
      upstreamBaseUrl: upstreamUrl,
      upstreamModel: 'deepseek-v4-flash',
      upstreamProvider: 'deepseek',
      upstreamTimeoutMs: 5000,
    },
    reasoningCache: new ReasoningCache(),
  });
  const configuredUrl = await listen(configured);
  const missingKeyUrl = await listen(missingKey);

  try {
    const invalid = await fetch(`${configuredUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{invalid',
    });
    assert.equal(invalid.status, 400);
    assert.deepEqual(await invalid.json(), { error: { message: 'Invalid JSON body' } });

    const invalidChat = await fetch(`${configuredUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{invalid',
    });
    assert.equal(invalidChat.status, 400);
    assert.deepEqual(await invalidChat.json(), { error: { message: 'Invalid JSON body' } });

    const invalidReasoning = await fetch(`${configuredUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-v4-flash', input: 'hello', reasoning: { effort: 'medium' } }),
    });
    assert.equal(invalidReasoning.status, 400);
    assert.deepEqual(await invalidReasoning.json(), {
      error: {
        code: 'invalid_reasoning_effort',
        message: 'Unsupported DeepSeek reasoning effort "medium". Expected one of: none, low, high, max',
      },
    });

    const missingModel = await fetch(`${configuredUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: 'hello' }),
    });
    assert.equal(missingModel.status, 400);
    assert.deepEqual(await missingModel.json(), { error: { message: 'Missing model' } });

    const noKey = await fetch(`${missingKeyUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-v4-flash', input: 'hello' }),
    });
    assert.equal(noKey.status, 500);
    assert.deepEqual(await noKey.json(), { error: { message: 'Missing UPSTREAM_API_KEY' } });

    const noChatKey = await fetch(`${missingKeyUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-v4-flash', messages: [] }),
    });
    assert.equal(noChatKey.status, 500);
    assert.deepEqual(await noChatKey.json(), { error: { message: 'Missing UPSTREAM_API_KEY' } });

    const notFound = await fetch(`${configuredUrl}/v1/unknown`);
    assert.equal(notFound.status, 404);
    assert.deepEqual(await notFound.json(), { error: { message: 'Not found' } });
    assert.equal(upstreamCalled, false);
  } finally {
    await close(configured);
    await close(missingKey);
    await close(upstream);
  }
  });
  await scenario('rejects oversized Responses and chunked Chat Completions bodies before upstream', async () => {
  let upstreamCalled = false;
  const upstream = http.createServer((_req, res) => {
    upstreamCalled = true;
    res.writeHead(500).end();
  });
  const upstreamUrl = await listen(upstream);
  const proxy = createProxyServer({
    config: {
      upstreamBaseUrl: upstreamUrl,
      upstreamApiKey: 'test-key',
      upstreamProvider: 'deepseek',
      upstreamTimeoutMs: 5000,
      requestBodyMaxBytes: 64,
    },
    reasoningCache: new ReasoningCache(),
  });
  const proxyUrl = await listen(proxy);

  try {
    const responses = await fetch(`${proxyUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-v4-flash', input: 'x'.repeat(128) }),
    });
    assert.equal(responses.status, 413);
    assert.deepEqual(await responses.json(), {
      error: { code: 'request_body_too_large', message: 'Request body exceeds 64 bytes' },
    });

    const chat = await postChunks(`${proxyUrl}/v1/chat/completions`, [
      '{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"',
      'x'.repeat(128),
      '"}]}',
    ]);
    assert.equal(chat.status, 413);
    assert.deepEqual(chat.body, {
      error: { code: 'request_body_too_large', message: 'Request body exceeds 64 bytes' },
    });
    assert.equal(upstreamCalled, false);
  } finally {
    await close(proxy);
    await close(upstream);
  }
  });
  await scenario('passes raw Chat Completions requests and streams through unchanged', async () => {
  const upstreamRequests = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    upstreamRequests.push({ body, authorization: req.headers.authorization });
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'live' }, finish_reason: null }] })}\n\n`);
      res.end('data: [DONE]\n\n');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'plain' }, finish_reason: 'stop' }] }));
  });
  const upstreamUrl = await listen(upstream);
  const proxy = createProxyServer({
    config: {
      upstreamBaseUrl: upstreamUrl,
      upstreamApiKey: 'test-key',
      upstreamTimeoutMs: 5000,
    },
    reasoningCache: new ReasoningCache(),
  });
  const proxyUrl = await listen(proxy);
  const request = { model: 'custom-model', messages: [{ role: 'user', content: 'hello' }], temperature: 0.2 };

  try {
    const plain = await fetch(`${proxyUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    });
    assert.equal(plain.status, 200);
    assert.equal((await plain.json()).choices[0].message.content, 'plain');

    const streamed = await fetch(`${proxyUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...request, stream: true }),
    });
    const streamText = await streamed.text();
    assert.equal(streamed.status, 200);
    assert.match(streamed.headers.get('content-type'), /text\/event-stream/);
    assert.match(streamText, /"content":"live"/);
    assert.match(streamText, /data: \[DONE\]/);
    assert.deepEqual(upstreamRequests.map((entry) => entry.body), [request, { ...request, stream: true }]);
    assert.equal(upstreamRequests.every((entry) => entry.authorization === 'Bearer test-key'), true);
  } finally {
    await close(proxy);
    await close(upstream);
  }
  });
  await scenario('returns a diagnostic 400 before upstream when DeepSeek tool capacity is exceeded', async () => {
  let upstreamCalled = false;
  const upstream = http.createServer((_req, res) => {
    upstreamCalled = true;
    res.writeHead(500).end();
  });
  const upstreamUrl = await listen(upstream);
  const proxy = createProxyServer({
    config: {
      upstreamBaseUrl: upstreamUrl,
      upstreamApiKey: 'test-key',
      upstreamModel: 'deepseek-v4-flash',
      upstreamProvider: 'deepseek',
      upstreamTimeoutMs: 5000,
    },
    reasoningCache: new ReasoningCache(),
  });
  const proxyUrl = await listen(proxy);
  const tools = Array.from({ length: 128 }, (_, index) => ({
    type: 'function',
    name: `tool_${index}`,
    parameters: { type: 'object', properties: {} },
  }));

  try {
    const response = await fetch(`${proxyUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-v4-flash', input: 'hello', tools }),
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.error.code, 'too_many_tools');
    assert.match(body.error.message, /at most 128/);
    assert.equal(upstreamCalled, false);
  } finally {
    await close(proxy);
    await close(upstream);
  }
  });
});

test('native Responses upstream mode', async () => {
  const upstreamRequests = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
    upstreamRequests.push({ url: req.url, body, authorization: req.headers.authorization });
    if (req.url === '/chat/completions') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'chat path' }, finish_reason: 'stop' }] }));
      return;
    }
    if (body?.input === 'provider error') {
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'rate_limit_exceeded', message: 'slow down' } }));
      return;
    }
    if (body?.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
      res.write('event: response.created\ndata: {"type":"response.created"}\n\n');
      res.write('event: response.web_search_call.in_progress\ndata: {"type":"response.web_search_call.in_progress"}\n\n');
      res.end('event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'resp_native', model: body.model, status: 'completed', output: [], output_text: 'native path' }));
  });
  const upstreamUrl = await listen(upstream);
  const proxy = createProxyServer({
    config: {
      upstreamBaseUrl: upstreamUrl,
      upstreamApiKey: 'test-key',
      upstreamProvider: 'deepseek',
      upstreamWireApi: 'responses',
      upstreamTimeoutMs: 5000,
      tavilyWebSearchEnabled: true,
      tavilyApiKey: 'unused-search-key',
      modelAliases: DEFAULT_MODEL_ALIASES,
    },
    reasoningCache: new ReasoningCache(),
  });
  const proxyUrl = await listen(proxy);

  try {
    const request = {
      model: 'deepseek-v4-flash',
      instructions: 'native instructions',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'search this' }] }],
      reasoning: { effort: 'high' },
      tools: [
        { type: 'web_search_preview' },
        { type: 'function', name: 'shell_command', parameters: { type: 'object', properties: {} } },
        { type: 'custom', name: 'apply_patch', description: 'edit' },
        { type: 'tool_search', execution: 'client', parameters: { type: 'object' } },
      ],
    };
    const plain = await fetch(`${proxyUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    });
    assert.equal(plain.status, 200);
    assert.deepEqual(await plain.json(), {
      id: 'resp_native',
      model: 'deepseek-v4-flash',
      status: 'completed',
      output: [],
      output_text: 'native path',
    });

    const stream = await fetch(`${proxyUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...request, stream: true }),
    });
    const streamText = await stream.text();
    assert.equal(stream.status, 200);
    assert.match(streamText, /event: response\.web_search_call\.in_progress/);
    assert.match(streamText, /event: response\.completed/);
    assert.doesNotMatch(streamText, /\[DONE\]/);

    const chat = await fetch(`${proxyUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'hello' }] }),
    });
    assert.equal(chat.status, 200);
    assert.equal((await chat.json()).choices[0].message.content, 'chat path');

    const models = await fetch(`${proxyUrl}/v1/models`);
    assert.equal(models.status, 200);
    assert.deepEqual((await models.json()).data.map((model) => model.id), ['deepseek-v4-flash']);

    const providerError = await fetch(`${proxyUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-v4-flash', input: 'provider error' }),
    });
    assert.equal(providerError.status, 429);
    assert.deepEqual(await providerError.json(), { error: { code: 'rate_limit_exceeded', message: 'slow down' } });

    const unsupported = await fetch(`${proxyUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-v4-flash', input: 'hello', tools: [{ type: 'computer_use' }] }),
    });
    assert.equal(unsupported.status, 200);
    assert.equal((await unsupported.json()).output_text, 'native path');

    assert.deepEqual(upstreamRequests.map((entry) => entry.url), ['/responses', '/responses', '/chat/completions', '/responses', '/responses']);
    assert.equal(upstreamRequests[0].body.instructions, request.instructions);
    assert.deepEqual(upstreamRequests[0].body.input, request.input);
    assert.equal(upstreamRequests[0].body.reasoning.effort, 'high');
    assert.equal(upstreamRequests[0].body.tools[0].type, 'web_search_preview');
    assert.equal(upstreamRequests[0].body.tools[3].type, 'tool_search');
    assert.equal(upstreamRequests.at(-1).body.tools[0].type, 'computer_use');
    assert.equal(upstreamRequests.every((entry) => entry.authorization === 'Bearer test-key'), true);
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('graceful shutdown', async () => {
  await scenario('keeps shutdown control off the public data server', async () => {
  const proxy = createProxyServer({
    config: {
      upstreamBaseUrl: 'http://127.0.0.1:1',
      upstreamApiKey: 'test-key',
      upstreamProvider: 'deepseek',
    },
    reasoningCache: new ReasoningCache(),
  });
  const proxyUrl = await listen(proxy);

  try {
    const response = await fetch(`${proxyUrl}/shutdown`, { method: 'POST' });
    assert.equal(response.status, 404);
  } finally {
    await close(proxy);
  }
  });
  await scenario('stops accepting new connections while allowing an in-flight response to finish', async () => {
  let releaseUpstream;
  let markUpstreamStarted;
  const upstreamRelease = new Promise((resolve) => {
    releaseUpstream = resolve;
  });
  const upstreamStarted = new Promise((resolve) => {
    markUpstreamStarted = resolve;
  });
  const upstream = http.createServer(async (req, res) => {
    for await (const _chunk of req) {
    }
    markUpstreamStarted();
    await upstreamRelease;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'completed' }, finish_reason: 'stop' }] }));
  });
  const upstreamUrl = await listen(upstream);
  const proxy = createProxyServer({
    config: {
      upstreamBaseUrl: upstreamUrl,
      upstreamApiKey: 'test-key',
      upstreamModel: 'deepseek-v4-flash',
      upstreamProvider: 'deepseek',
      upstreamTimeoutMs: 5000,
    },
    reasoningCache: new ReasoningCache(),
  });
  const proxyUrl = await listen(proxy);

  try {
    const responsePromise = fetch(`${proxyUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-v4-flash', input: 'finish this request' }),
    });
    await upstreamStarted;
    let closed = false;
    const closing = closeServerGracefully(proxy, 1000).then(() => {
      closed = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(closed, false);
    releaseUpstream();
    const response = await responsePromise;
    assert.equal(response.status, 200);
    assert.equal((await response.json()).output_text, 'completed');
    await closing;
    assert.equal(closed, true);
  } finally {
    releaseUpstream();
    if (proxy.listening) await close(proxy);
    await close(upstream);
  }
  });
  await scenario('requires the private token before accepting a shutdown request', async () => {
  let control;
  control = createControlServer({
    token: 'private-token',
    instanceId: 'instance-1',
    onShutdown: () => closeServerGracefully(control, 1000),
    status: { packageVersion: '1.2.3', startedAt: 42, dataUrl: 'http://127.0.0.1:3000' },
  });
  const controlUrl = await listen(control);

  try {
    const rejected = await fetch(`${controlUrl}/shutdown`, {
      method: 'POST',
      headers: { 'x-gateway-shutdown-token': 'wrong-token' },
    });
    assert.equal(rejected.status, 404);

    const status = await fetch(`${controlUrl}/status`, {
      headers: { 'x-gateway-shutdown-token': 'private-token' },
    });
    assert.deepEqual(await status.json(), {
      packageVersion: '1.2.3',
      startedAt: 42,
      dataUrl: 'http://127.0.0.1:3000',
      ok: true,
      pid: process.pid,
      instanceId: 'instance-1',
    });

    const closed = once(control, 'close');
    const accepted = await fetch(`${controlUrl}/shutdown`, {
      method: 'POST',
      headers: { 'x-gateway-shutdown-token': 'private-token' },
    });
    assert.equal(accepted.status, 202);
    assert.deepEqual(await accepted.json(), { ok: true });
    await closed;
  } finally {
    if (control.listening) await close(control);
  }
  });
});

test('non-streaming bridge and persistent reasoning recovery', async () => {
  await scenario('proxies non-streaming Responses request to chat completions upstream', async () => {
  let upstreamBody;
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    upstreamBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chatcmpl_upstream',
      object: 'chat.completion',
      created: 123,
      model: upstreamBody.model,
      choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));
  });
  const upstreamUrl = await listen(upstream);

  const proxy = createProxyServer({
    config: {
      serverName: 'test',
      upstreamBaseUrl: upstreamUrl,
      upstreamApiKey: 'test-key',
      upstreamModel: 'deepseek-v4-flash',
      upstreamProvider: 'deepseek',
      upstreamTimeoutMs: 5000,
    },
    reasoningCache: new ReasoningCache(),
  });
  const proxyUrl = await listen(proxy);

  try {
    const response = await fetch(`${proxyUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'codex', instructions: 'rules', input: 'ping', max_output_tokens: 16 }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.object, 'response');
    assert.equal(body.output[0].content[0].text, 'pong');
    assert.equal(body.usage.input_tokens, 1);
    assert.equal(body.usage.output_tokens, 1);
    assert.equal(body.usage.total_tokens, 2);
    assert.deepEqual(upstreamBody.messages, [
      { role: 'system', content: 'rules' },
      { role: 'user', content: 'ping' },
    ]);
    assert.equal(upstreamBody.max_tokens, 16);
    assert.equal(upstreamBody.model, 'deepseek-v4-flash');
  } finally {
    await close(proxy);
    await close(upstream);
  }
  });
  await scenario('restores reasoning_content from the persistent call-id cache after restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gateway-server-reasoning-cache-'));
  const persistPath = join(dir, 'reasoning-cache.jsonl');
  const upstreamBodies = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    upstreamBodies.push(body);
    res.writeHead(200, { 'content-type': 'application/json' });
    const message = upstreamBodies.length === 1
      ? {
          role: 'assistant',
          content: '',
          reasoning_content: 'store-false thinking',
          tool_calls: [
            { id: 'call_store_1', type: 'function', function: { name: 'lookup', arguments: '{"query":"codex"}' } },
          ],
        }
      : { role: 'assistant', content: 'final answer' };
    res.end(JSON.stringify({
      id: `chatcmpl_store_${upstreamBodies.length}`,
      object: 'chat.completion',
      created: 123,
      model: body.model,
      choices: [{ index: 0, message, finish_reason: upstreamBodies.length === 1 ? 'tool_calls' : 'stop' }],
    }));
  });
  const upstreamUrl = await listen(upstream);
  const config = {
    serverName: 'test',
    upstreamBaseUrl: upstreamUrl,
    upstreamApiKey: 'test-key',
    upstreamModel: 'deepseek-v4-flash',
    upstreamProvider: 'deepseek',
    upstreamTimeoutMs: 5000,
    reasoningCacheEnabled: true,
    reasoningCachePath: persistPath,
    reasoningCacheMaxMessages: 10,
  };
  const tools = [{ type: 'function', name: 'lookup', parameters: { type: 'object', properties: {} } }];

  let proxy = null;
  try {
    proxy = createProxyServer({ config });
    let proxyUrl = await listen(proxy);
    const first = await fetch(`${proxyUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'codex', store: false, tools, input: 'first user' }),
    });
    assert.equal(first.status, 200);
    const firstBody = await first.json();
    const functionCall = firstBody.output.find((item) => item.type === 'function_call');
    assert.equal(functionCall.call_id, 'call_store_1');

    const persisted = JSON.parse((await readFile(persistPath, 'utf8')).trim());
    assert.deepEqual(persisted.callIds, ['call_store_1']);
    assert.equal(persisted.message.reasoning_content, 'store-false thinking');

    await close(proxy);
    proxy = null;
    proxy = createProxyServer({ config });
    proxyUrl = await listen(proxy);

    const second = await fetch(`${proxyUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'codex',
        store: false,
        tools,
        input: [
          { type: 'function_call_output', call_id: 'call_store_1', output: 'lookup result' },
        ],
      }),
    });
    assert.equal(second.status, 200);
    await second.json();

    const replayedAssistant = upstreamBodies[1].messages.find(
      (message) => message.role === 'assistant' && Array.isArray(message.tool_calls),
    );
    assert.equal(replayedAssistant.reasoning_content, 'store-false thinking');
    assert.equal(upstreamBodies[1].messages.at(-1).tool_call_id, 'call_store_1');

    assert.equal((await readFile(persistPath, 'utf8')).trim().split('\n').length, 1);
  } finally {
    if (proxy) await close(proxy);
    await close(upstream);
    await rm(dir, { recursive: true, force: true });
  }
  });
  await scenario('restores DeepSeek reasoning_content when Codex sends only tool output on the next turn', async () => {
  const upstreamBodies = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    upstreamBodies.push(body);
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
    });
    if (upstreamBodies.length === 1) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'need context' }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_lookup',
                  type: 'function',
                  function: { name: 'lookup', arguments: '{"q":"repo"}' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'done' }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });
  const upstreamUrl = await listen(upstream);

  const proxy = createProxyServer({
    config: {
      serverName: 'test',
      upstreamBaseUrl: upstreamUrl,
      upstreamApiKey: 'test-key',
      upstreamProvider: 'deepseek',
      upstreamTimeoutMs: 5000,
      modelAliases: DEFAULT_MODEL_ALIASES,
    },
    reasoningCache: new ReasoningCache(),
  });
  const proxyUrl = await listen(proxy);

  try {
    const first = await fetch(`${proxyUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-v4-pro',
        input: 'inspect repo',
        stream: true,
        reasoning: { effort: 'high' },
        tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object', properties: { q: { type: 'string' } } } }],
      }),
    });
    assert.equal(first.status, 200);
    await first.text();

    const second = await fetch(`${proxyUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-v4-pro',
        stream: true,
        reasoning: { effort: 'high' },
        input: [
          {
            type: 'function_call_output',
            call_id: 'call_lookup',
            output: '{"files":["README.md"]}',
          },
        ],
      }),
    });
    assert.equal(second.status, 200);
    await second.text();

    assert.equal(upstreamBodies.length, 2);
    assert.deepEqual(upstreamBodies[1].messages.slice(-2), [
      {
        role: 'assistant',
        content: '',
        reasoning_content: 'need context',
        tool_calls: [
          {
            id: 'call_lookup',
            type: 'function',
            function: { name: 'lookup', arguments: '{"q":"repo"}' },
          },
        ],
      },
      {
        role: 'tool',
        content: '{"files":["README.md"]}',
        tool_call_id: 'call_lookup',
      },
    ]);
  } finally {
    await close(proxy);
    await close(upstream);
  }
  });
  await scenario('restores raw DeepSeek reasoning for replayed tool-call turns via reasoning cache', async () => {
  const upstreamBodies = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    upstreamBodies.push(body);
    res.writeHead(200, { 'content-type': 'application/json' });
    if (upstreamBodies.length === 1) {
      res.end(JSON.stringify({
        created: 1,
        choices: [
          {
            message: {
              role: 'assistant',
              content: '',
              reasoning_content: 'raw tool-turn chain of thought',
              tool_calls: [
                { id: 'call_ds_1', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      }));
      return;
    }
    res.end(JSON.stringify({
      created: 2,
      choices: [{ message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
    }));
  });
  const upstreamUrl = await listen(upstream);
  const proxy = createProxyServer({
    config: {
      serverName: 'test',
      upstreamBaseUrl: upstreamUrl,
      upstreamApiKey: 'test-key',
      upstreamModel: 'deepseek-v4-flash',
      upstreamProvider: 'deepseek',
      upstreamTimeoutMs: 5000,
    },
    reasoningCache: new ReasoningCache(),
  });
  const proxyUrl = await listen(proxy);

  try {
    const tools = [
      { type: 'function', name: 'lookup', parameters: { type: 'object', properties: { q: { type: 'string' } } } },
    ];
    const first = await fetch(`${proxyUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-v4-flash', input: 'find x', tools, reasoning: { effort: 'high' } }),
    });
    assert.equal(first.status, 200);
    const firstBody = await first.json();
    const call = firstBody.output.find((item) => item.type === 'function_call');
    assert.equal(call.call_id, 'call_ds_1');

    const second = await fetch(`${proxyUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-v4-flash',
        reasoning: { effort: 'high' },
        tools,
        input: [
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'find x' }] },
          { type: 'reasoning', summary: [{ type: 'summary_text', text: 'cleaned' }] },
          { type: 'function_call', call_id: 'call_ds_1', name: 'lookup', arguments: '{"q":"x"}' },
          { type: 'function_call_output', call_id: 'call_ds_1', output: '{"ok":true}' },
        ],
      }),
    });
    assert.equal(second.status, 200);
    await second.json();
    assert.equal(upstreamBodies.length, 2);
    const replayedAssistant = upstreamBodies[1].messages.find(
      (message) => message.role === 'assistant' && Array.isArray(message.tool_calls),
    );
    assert.equal(replayedAssistant.tool_calls[0].id, 'call_ds_1');
    assert.equal(replayedAssistant.reasoning_content, 'raw tool-turn chain of thought');
  } finally {
    await close(proxy);
    await close(upstream);
  }
  });
  await scenario('does not persist partial tool calls from failed DeepSeek completions', async () => {
  const upstream = http.createServer(async (req, res) => {
    for await (const _chunk of req) {}
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chatcmpl_resource_failure',
      created: 123,
      choices: [{
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: 'call_partial',
            type: 'function',
            function: { name: 'lookup', arguments: '{"query":"partial"}' },
          }],
        },
        finish_reason: 'insufficient_system_resource',
      }],
    }));
  });
  const upstreamUrl = await listen(upstream);
  const reasoningCache = new ReasoningCache();
  const proxy = createProxyServer({
    config: {
      upstreamBaseUrl: upstreamUrl,
      upstreamApiKey: 'test-key',
      upstreamModel: 'deepseek-v4-flash',
      upstreamProvider: 'deepseek',
      upstreamTimeoutMs: 5000,
    },
    reasoningCache,
  });
  const proxyUrl = await listen(proxy);

  try {
    const response = await fetch(`${proxyUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-v4-flash',
        input: 'lookup',
        store: false,
        tools: [{
          type: 'function',
          name: 'lookup',
          parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
        }],
      }),
    });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.status, 'failed');
    assert.equal(body.error.code, 'server_is_overloaded');
    assert.equal(body.output[0].status, 'failed');
    assert.equal(reasoningCache.getAssistantMessageForToolCall('call_partial'), null);
  } finally {
    await close(proxy);
    await close(upstream);
  }
  });
  await scenario('preserves non-JSON upstream errors on the Responses route', async () => {
  const upstream = http.createServer(async (req, res) => {
    for await (const _chunk of req) {}
    res.writeHead(502, { 'content-type': 'text/plain' });
    res.end('upstream gateway unavailable');
  });
  const upstreamUrl = await listen(upstream);
  const proxy = createProxyServer({
    config: {
      upstreamBaseUrl: upstreamUrl,
      upstreamApiKey: 'test-key',
      upstreamModel: 'deepseek-v4-flash',
      upstreamProvider: 'deepseek',
      upstreamTimeoutMs: 5000,
    },
    reasoningCache: new ReasoningCache(),
  });
  const proxyUrl = await listen(proxy);

  try {
    const response = await fetch(`${proxyUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-v4-flash', input: 'hello' }),
    });
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { raw: 'upstream gateway unavailable' });
  } finally {
    await close(proxy);
    await close(upstream);
  }
  });
});

test('non-streaming web-search orchestration and compatibility', async () => {
  await scenario('emulates Codex web_search with Tavily for non-streaming Responses requests', async () => {
  const upstreamBodies = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    upstreamBodies.push(body);
    res.writeHead(200, { 'content-type': 'application/json' });
    if (upstreamBodies.length === 1) {
      res.end(JSON.stringify({
        id: 'chatcmpl_search',
        object: 'chat.completion',
        created: 123,
        model: body.model,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  id: 'call_search',
                  type: 'function',
                  function: {
                    name: 'web_search',
                    arguments: '{"query":"Codex web search Tavily","max_results":3}',
                  },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 3,
          total_tokens: 13,
          prompt_cache_hit_tokens: 2,
          completion_tokens_details: { reasoning_tokens: 1 },
        },
      }));
      return;
    }
    res.end(JSON.stringify({
      id: 'chatcmpl_final',
      object: 'chat.completion',
      created: 124,
      model: body.model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: 'Tavily can provide live search results for Codex [1].',
          },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: 20,
        completion_tokens: 7,
        total_tokens: 27,
        prompt_tokens_details: { cached_tokens: 5 },
        completion_tokens_details: { reasoning_tokens: 2 },
      },
    }));
  });
  const tavily = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    assert.equal(req.headers.authorization, 'Bearer tvly-test');
    assert.equal(body.include_raw_content, false);
    assert.equal(body.query, 'Codex web search Tavily');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      answer: 'Tavily is a search API.',
      results: [
        {
          title: 'Tavily Search API',
          url: 'https://docs.tavily.com/search',
          content: 'Search endpoint returns concise web results.',
          raw_content: 'RAW CONTENT SHOULD NOT REACH MODEL',
        },
      ],
    }));
  });
  const upstreamUrl = await listen(upstream);
  const tavilyUrl = await listen(tavily);

  const proxy = createProxyServer({
    config: {
      serverName: 'test',
      upstreamBaseUrl: upstreamUrl,
      upstreamApiKey: 'test-key',
      upstreamModel: 'deepseek-v4-flash',
      upstreamProvider: 'deepseek',
      upstreamTimeoutMs: 5000,
      tavilyApiKey: 'tvly-test',
      tavilyBaseUrl: tavilyUrl,
      tavilyWebSearchEnabled: true,
      tavilyTimeoutMs: 5000,
      webSearchMaxRounds: 2,
      tavilyMaxResults: 5,
      tavilySearchDepth: 'basic',
    },
    reasoningCache: new ReasoningCache(),
  });
  const proxyUrl = await listen(proxy);

  try {
    const response = await fetch(`${proxyUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'codex',
        input: 'Search the web',
        tools: [{ type: 'web_search' }],
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.output[0].type, 'web_search_call');
    assert.equal(body.output[0].status, 'completed');
    assert.equal(body.output[0].action.query, 'Codex web search Tavily');
    assert.equal('sources' in body.output[0].action, false);
    assert.equal(body.output[1].type, 'message');
    assert.equal(body.output[1].content[0].text, 'Tavily can provide live search results for Codex [1].');
    assert.deepEqual(body.output[1].content[0].annotations, [
      {
        type: 'url_citation',
        start_index: 49,
        end_index: 52,
        url: 'https://docs.tavily.com/search',
        title: 'Tavily Search API',
      },
    ]);
    assert.equal(body.usage.input_tokens, 20);
    assert.equal(body.usage.output_tokens, 7);
    assert.equal(body.usage.total_tokens, 27);
    assert.equal(body.usage.input_tokens_details.cached_tokens, 5);
    assert.equal(body.usage.output_tokens_details.reasoning_tokens, 2);
    assert.equal(upstreamBodies.length, 2);
    assert.equal(upstreamBodies[0].tools.some((tool) => tool.function?.name === 'web_search'), true);
    assert.equal(upstreamBodies[0].stream, false);
    assert.equal(upstreamBodies[1].messages.at(-1).role, 'tool');
    assert.match(upstreamBodies[1].messages.at(-1).content, /Web search results for: Codex web search Tavily/);
    assert.match(upstreamBodies[1].messages.at(-1).content, /Source 1: Tavily Search API/);
    assert.match(upstreamBodies[1].messages.at(-1).content, /URL: https:\/\/docs\.tavily\.com\/search/);
    assert.doesNotMatch(upstreamBodies[1].messages.at(-1).content, /cite them as \[1\].*Do not write Markdown links or raw source URLs/);
    assert.doesNotMatch(upstreamBodies[1].messages.at(-1).content, /RAW CONTENT SHOULD NOT REACH MODEL|raw_content/);
  } finally {
    await close(proxy);
    await close(upstream);
    await close(tavily);
  }
  });
  await scenario('uses the last available web-search usage when the final round omits usage', async () => {
  let upstreamCalls = 0;
  const upstream = http.createServer(async (_req, res) => {
    upstreamCalls += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    if (upstreamCalls === 1) {
      res.end(JSON.stringify({
        choices: [{
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{ id: 'call_search', type: 'function', function: { name: 'web_search', arguments: '{"query":"fallback usage"}' } }],
          },
          finish_reason: 'tool_calls',
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }));
      return;
    }
    res.end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'Final answer.' }, finish_reason: 'stop' }],
    }));
  });
  const tavily = http.createServer(async (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      results: [{ title: 'Fallback', url: 'https://example.com/fallback', content: 'Fallback result.' }],
    }));
  });
  const upstreamUrl = await listen(upstream);
  const tavilyUrl = await listen(tavily);
  const proxy = createProxyServer({
    config: {
      upstreamBaseUrl: upstreamUrl,
      upstreamApiKey: 'test-key',
      upstreamModel: 'deepseek-v4-flash',
      upstreamProvider: 'deepseek',
      upstreamTimeoutMs: 5000,
      tavilyApiKey: 'tvly-test',
      tavilyBaseUrl: tavilyUrl,
      tavilyWebSearchEnabled: true,
      tavilyTimeoutMs: 5000,
    },
    reasoningCache: new ReasoningCache(),
  });
  const proxyUrl = await listen(proxy);

  try {
    const response = await fetch(`${proxyUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'codex', input: 'Search', tools: [{ type: 'web_search' }] }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.usage.input_tokens, 10);
    assert.equal(body.usage.output_tokens, 5);
    assert.equal(body.usage.total_tokens, 15);
  } finally {
    await close(proxy);
    await close(upstream);
    await close(tavily);
  }
  });
  await scenario('adds Firecrawl opened page excerpts to Tavily-backed web_search', async () => {
  const upstreamBodies = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    upstreamBodies.push(body);
    res.writeHead(200, { 'content-type': 'application/json' });
    if (upstreamBodies.length === 1) {
      res.end(JSON.stringify({
        choices: [
          {
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  id: 'call_search',
                  type: 'function',
                  function: { name: 'web_search', arguments: '{"query":"firecrawl integration","max_results":1}' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      }));
      return;
    }
    res.end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'Firecrawl can open pages after search [1].' }, finish_reason: 'stop' }],
    }));
  });
  const tavily = http.createServer(async (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      results: [{ title: 'Firecrawl Source', url: 'https://example.com/firecrawl', content: 'Search snippet.' }],
    }));
  });
  let firecrawlBody;
  const firecrawl = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    firecrawlBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    assert.equal(req.headers.authorization, 'Bearer fc-test');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      data: {
        markdown: '# Firecrawl\n\nOpened page text for DeepSeek with firecrawl integration details. '.repeat(12),
        links: [{ title: 'Nested Link', url: 'https://example.com/nested' }],
        metadata: { title: 'Opened Firecrawl Page', sourceURL: 'https://example.com/firecrawl' },
      },
    }));
  });
  const upstreamUrl = await listen(upstream);
  const tavilyUrl = await listen(tavily);
  const firecrawlUrl = await listen(firecrawl);
  const proxy = createProxyServer({
    config: {
      upstreamBaseUrl: upstreamUrl,
      upstreamApiKey: 'test-key',
      upstreamModel: 'deepseek-v4-flash',
      upstreamProvider: 'deepseek',
      upstreamTimeoutMs: 5000,
      tavilyApiKey: 'tvly-test',
      tavilyBaseUrl: tavilyUrl,
      tavilyWebSearchEnabled: true,
      tavilyTimeoutMs: 5000,
      firecrawlApiKey: 'fc-test',
      firecrawlBaseUrl: firecrawlUrl,
      firecrawlWebFetchEnabled: true,
      firecrawlAutoScrapeTopResults: 1,
      firecrawlTimeoutMs: 5000,
      firecrawlPageMaxChars: 4000,
    },
    reasoningCache: new ReasoningCache(),
  });
  const proxyUrl = await listen(proxy);

  try {
    const response = await fetch(`${proxyUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'codex',
        input: 'Search and read',
        tools: [{ type: 'web_search' }],
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(firecrawlBody.url, 'https://example.com/firecrawl');
    assert.deepEqual(firecrawlBody.formats, ['markdown']);
    assert.equal(upstreamBodies[0].tools.some((tool) => tool.function?.name === 'web_open_page'), true);
    const toolContent = upstreamBodies[1].messages.at(-1).content;
    assert.match(toolContent, /Opened page matches:/);
    assert.doesNotMatch(toolContent, /Opened page excerpt:/);
    assert.match(toolContent, /Opened page text for DeepSeek/);
    assert.doesNotMatch(toolContent, /Nested Link/);
    assert.equal(body.output[0].type, 'web_search_call');
    assert.deepEqual(body.output[1].content[0].annotations, [
      {
        type: 'url_citation',
        start_index: 38,
        end_index: 41,
        url: 'https://example.com/firecrawl',
        title: 'Firecrawl Source',
      },
    ]);
  } finally {
    await close(proxy);
    await close(upstream);
    await close(tavily);
    await close(firecrawl);
  }
  });
  await scenario('accepts Codex state that replays prior web_search_call items', async () => {
  const upstreamBodies = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    upstreamBodies.push(body);
    if (upstreamBodies.length === 1) {
      assert.equal(body.messages.some((message) => Array.isArray(message.tool_calls) && message.tool_calls.length), false);
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    if (!body.messages.some((message) => message.role === 'tool')) {
      res.end(JSON.stringify({
        choices: [
          {
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  id: 'call_oil',
                  type: 'function',
                  function: { name: 'tavily_search', arguments: '{"query":"oil price today"}' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      }));
      return;
    }
    res.end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'Oil moved [1].' }, finish_reason: 'stop' }],
    }));
  });
  const tavily = http.createServer(async (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      results: [{ title: 'Oil source', url: 'https://example.com/oil', content: 'Oil price update.' }],
    }));
  });
  const upstreamUrl = await listen(upstream);
  const tavilyUrl = await listen(tavily);
  const proxy = createProxyServer({
    config: {
      upstreamBaseUrl: upstreamUrl,
      upstreamApiKey: 'test-key',
      upstreamModel: 'deepseek-v4-flash',
      upstreamProvider: 'deepseek',
      upstreamTimeoutMs: 5000,
      tavilyApiKey: 'tvly-test',
      tavilyBaseUrl: tavilyUrl,
      tavilyWebSearchEnabled: true,
      tavilyTimeoutMs: 5000,
    },
    reasoningCache: new ReasoningCache(),
  });
  const proxyUrl = await listen(proxy);

  try {
    const response = await fetch(`${proxyUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'codex',
        input: [
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'search gold' }] },
          {
            type: 'web_search_call',
            status: 'completed',
            action: { type: 'search', query: 'gold price', sources: [{ type: 'url', title: 'Gold', url: 'https://example.com/gold' }] },
          },
          { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Gold moved [1].' }] },
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'search oil now' }] },
        ],
        tools: [{ type: 'web_search' }],
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.output[0].type, 'web_search_call');
    assert.equal(upstreamBodies.length, 2);
    assert.equal(upstreamBodies[0].messages.some((message) => Array.isArray(message.tool_calls)), false);
    assert.equal(upstreamBodies[1].messages.at(-1).role, 'tool');
  } finally {
    await close(proxy);
    await close(upstream);
    await close(tavily);
  }
  });
  await scenario('routes forced hosted web_search tool_choice to the internal search tool', async () => {
  let upstreamBody;
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    upstreamBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'No search needed.' }, finish_reason: 'stop' }],
    }));
  });
  const upstreamUrl = await listen(upstream);
  const proxy = createProxyServer({
    config: {
      upstreamBaseUrl: upstreamUrl,
      upstreamApiKey: 'test-key',
      upstreamModel: 'deepseek-v4-flash',
      upstreamProvider: 'deepseek',
      upstreamTimeoutMs: 5000,
      tavilyApiKey: 'tvly-test',
      tavilyBaseUrl: 'https://tavily.invalid',
      tavilyWebSearchEnabled: true,
      tavilyTimeoutMs: 5000,
    },
    reasoningCache: new ReasoningCache(),
  });
  const proxyUrl = await listen(proxy);

  try {
    const response = await fetch(`${proxyUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'codex',
        input: 'Search',
        tools: [{ type: 'web_search' }],
        tool_choice: { type: 'web_search' },
      }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(upstreamBody.tool_choice, {
      type: 'function',
      function: { name: 'web_search' },
    });
    assert.deepEqual(upstreamBody.thinking, { type: 'disabled' });
    assert.equal(upstreamBody.tools.some((tool) => tool.function?.name === 'web_search'), true);
  } finally {
    await close(proxy);
    await close(upstream);
  }
  });
  await scenario('does not pass required web_search tool_choice to DeepSeek', async () => {
  let upstreamBody;
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    upstreamBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    }));
  });
  const upstreamUrl = await listen(upstream);
  const proxy = createProxyServer({
    config: {
      upstreamBaseUrl: upstreamUrl,
      upstreamApiKey: 'test-key',
      upstreamModel: 'deepseek-v4-flash',
      upstreamProvider: 'deepseek',
      upstreamTimeoutMs: 5000,
      tavilyApiKey: 'tvly-test',
      tavilyBaseUrl: 'https://tavily.invalid',
      tavilyWebSearchEnabled: true,
    },
    reasoningCache: new ReasoningCache(),
  });
  const proxyUrl = await listen(proxy);

  try {
    const response = await fetch(`${proxyUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'codex',
        input: 'Search',
        tools: [{ type: 'web_search' }],
        tool_choice: { type: 'allowed_tools', mode: 'required' },
      }),
    });
    assert.equal(response.status, 200);
    assert.equal(upstreamBody.tool_choice, undefined);
  } finally {
    await close(proxy);
    await close(upstream);
  }
  });
  await scenario('passes through real external tool calls while web search emulation is enabled', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'gateway-debug-'));
  const debugPath = join(tempDir, 'gateway.debug.log');
  const upstreamBodies = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    upstreamBodies.push(body);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'I will delegate first.',
            tool_calls: [
              {
                id: 'call_search',
                type: 'function',
                function: {
                  name: 'tavily_search',
                  arguments: '{"query":"OpenAI news"}',
                },
              },
              {
                id: 'call_spawn',
                type: 'function',
                function: {
                  name: 'multi_agent_v1__spawn_agent',
                  arguments: '{"message":"Find two current OpenAI news items."}',
                },
              },
              {
                id: 'call_unknown',
                type: 'function',
                function: {
                  name: 'unknown_local_tool',
                  arguments: '{"q":"ignored"}',
                },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    }));
  });
  const upstreamUrl = await listen(upstream);
  const proxy = createProxyServer({
    config: {
      upstreamBaseUrl: upstreamUrl,
      upstreamApiKey: 'test-key',
      upstreamModel: 'deepseek-v4-flash',
      upstreamProvider: 'deepseek',
      upstreamTimeoutMs: 5000,
      tavilyApiKey: 'tvly-test',
      tavilyBaseUrl: 'https://tavily.invalid',
      tavilyWebSearchEnabled: true,
      debugPayload: true,
      debugPayloadLogPath: debugPath,
    },
    reasoningCache: new ReasoningCache(),
  });
  const proxyUrl = await listen(proxy);

  try {
    const response = await fetch(`${proxyUrl}/v1/responses`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-codex-turn-metadata': JSON.stringify({ request_kind: 'turn' }),
      },
      body: JSON.stringify({
        model: 'codex',
        input: 'Assign this to a sub-agent and use web if needed.',
        previous_response_id: 'resp_previous',
        prompt_cache_key: 'cache_debug',
        client_metadata: {
          session_id: 'session_debug',
          thread_id: 'thread_debug',
          turn_id: 'turn_debug',
          'x-codex-window-id': 'window_debug',
        },
        tools: [
          { type: 'web_search' },
          {
            type: 'namespace',
            name: 'multi_agent_v1',
            tools: [
              {
                type: 'function',
                name: 'spawn_agent',
                description: 'Spawn a sub-agent for delegated work.',
                parameters: {
                  type: 'object',
                  properties: { message: { type: 'string' } },
                  required: ['message'],
                  additionalProperties: false,
                },
              },
            ],
          },
        ],
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(upstreamBodies.length, 1);
    assert.equal(upstreamBodies[0].tools.some((tool) => tool.function?.name === 'web_search'), true);
    assert.equal(upstreamBodies[0].tools.some((tool) => tool.function?.name === 'multi_agent_v1__spawn_agent'), true);
    assert.match(upstreamBodies[0].messages[0].content, /real callable functions available now/);
    const commentaryMessage = body.output.find((item) => item.type === 'message');
    assert.equal(commentaryMessage.phase, 'commentary');
    assert.equal(body.output_text, '');
    const toolCall = body.output.find((item) => item.type === 'function_call');
    assert.equal(toolCall.namespace, 'multi_agent_v1');
    assert.equal(toolCall.name, 'spawn_agent');
    assert.equal(body.output.some((item) => item.type === 'function_call' && item.name === 'tavily_search'), false);
    assert.equal(body.output.some((item) => item.type === 'function_call' && item.name === 'unknown_local_tool'), false);
    const debugLines = (await readFile(debugPath, 'utf8')).trim().split(/\r?\n/);
    const debugEntries = debugLines.map((line) => JSON.parse(line.replace(/^\[codex-deepseek-gateway\] upstream request /, '')));
    const round = debugEntries.find((entry) => entry.stage === 'web_search_round_0');
    assert.ok(round);
    assert.equal(round.session_id, 'session_debug');
    assert.equal(round.thread_id, 'thread_debug');
    assert.equal(round.turn_id, 'turn_debug');
    assert.equal(round.window_id, 'window_debug');
    assert.equal(round.request_kind, 'turn');
    assert.equal(round.previous_response_id, 'resp_previous');
    assert.equal(round.prompt_cache_key, 'cache_debug');
    assert.equal(round.codex_tools.some((tool) => tool.type === 'web_search'), true);
    assert.equal(round.codex_tools.some((tool) => tool.type === 'namespace' && tool.name === 'multi_agent_v1'), true);
    assert.equal(round.chat_tools.some((tool) => tool.name === 'multi_agent_v1__spawn_agent'), true);
    assert.equal(round.upstream_tools.some((tool) => tool.name === 'web_search'), true);
    assert.equal(round.upstream_tools.some((tool) => tool.name === 'multi_agent_v1__spawn_agent'), true);
  } finally {
    await close(proxy);
    await close(upstream);
    await rm(tempDir, { recursive: true, force: true });
  }
  });
  await scenario('does not leak internal search function calls when search loop reaches max rounds', async () => {
  const upstreamBodies = [];
  const upstream = http.createServer(async (_req, res) => {
    const chunks = [];
    for await (const chunk of _req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    upstreamBodies.push(body);
    res.writeHead(200, { 'content-type': 'application/json' });
    if (upstreamBodies.length === 3) {
      assert.equal(body.tool_choice, undefined);
      assert.equal(body.tools, undefined);
      assert.equal(body.messages.some((message) => String(message.content || '').includes('Use web_search when current web facts are needed')), false);
      assert.equal(body.messages.at(-1).role, 'user');
      assert.match(body.messages.at(-1).content, /No more web searches or page reads can be run in this turn/);
      assert.equal(body.messages.some((message) => message.role === 'tool'), true);
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'Final answer from the completed search [1].' }, finish_reason: 'stop' }],
      }));
      return;
    }
    res.end(JSON.stringify({
      choices: [
        {
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'call_search',
                type: 'function',
                function: { name: 'tavily_search', arguments: '{"query":"repeat"}' },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    }));
  });
  const tavily = http.createServer(async (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      results: [{ title: 'Source', url: 'https://example.com/source', content: 'Snippet' }],
    }));
  });
  const upstreamUrl = await listen(upstream);
  const tavilyUrl = await listen(tavily);
  const proxy = createProxyServer({
    config: {
      upstreamBaseUrl: upstreamUrl,
      upstreamApiKey: 'test-key',
      upstreamModel: 'deepseek-v4-flash',
      upstreamProvider: 'deepseek',
      upstreamTimeoutMs: 5000,
      tavilyApiKey: 'tvly-test',
      tavilyBaseUrl: tavilyUrl,
      tavilyWebSearchEnabled: true,
      webSearchMaxRounds: 1,
    },
    reasoningCache: new ReasoningCache(),
  });
  const proxyUrl = await listen(proxy);

  try {
    const response = await fetch(`${proxyUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'codex',
        input: 'search',
        tools: [{ type: 'web_search' }],
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(upstreamBodies.length, 3);
    assert.equal(body.output[0].type, 'web_search_call');
    assert.equal(body.output[1].type, 'message');
    assert.equal(body.output[1].content[0].text, 'Final answer from the completed search [1].');
    assert.equal(body.output.some((item) => item.type === 'function_call' && item.name === 'tavily_search'), false);
  } finally {
    await close(proxy);
    await close(upstream);
    await close(tavily);
  }
  });
  await scenario('completes with a visible gateway explanation when final answer turn writes pseudo tool calls', async () => {
  const upstreamBodies = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    upstreamBodies.push(body);
    res.writeHead(200, { 'content-type': 'application/json' });
    if (upstreamBodies.length === 3) {
      assert.equal(body.tool_choice, undefined);
      assert.equal(body.tools, undefined);
      assert.match(body.messages.at(-1).content, /without tool calls or tool-call markup/);
      res.end(JSON.stringify({
        choices: [
          {
            message: {
              role: 'assistant',
              reasoning_content: 'I need another search, but tools are disabled.',
              content: [
                '<｜｜DSML｜｜tool_calls>',
                '<｜｜DSML｜｜invoke name="tavily_search">',
                '{"query":"repeat"}',
                '</｜｜DSML｜｜invoke>',
              ].join('\n'),
            },
            finish_reason: 'stop',
          },
        ],
      }));
      return;
    }
    res.end(JSON.stringify({
      choices: [
        {
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'call_search',
                type: 'function',
                function: { name: 'tavily_search', arguments: '{"query":"repeat"}' },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    }));
  });
  const tavily = http.createServer(async (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      results: [{ title: 'Source', url: 'https://example.com/source', content: 'Snippet' }],
    }));
  });
  const upstreamUrl = await listen(upstream);
  const tavilyUrl = await listen(tavily);
  const proxy = createProxyServer({
    config: {
      upstreamBaseUrl: upstreamUrl,
      upstreamApiKey: 'test-key',
      upstreamModel: 'deepseek-v4-flash',
      upstreamProvider: 'deepseek',
      upstreamTimeoutMs: 5000,
      tavilyApiKey: 'tvly-test',
      tavilyBaseUrl: tavilyUrl,
      tavilyWebSearchEnabled: true,
      webSearchMaxRounds: 1,
    },
    reasoningCache: new ReasoningCache(),
  });
  const proxyUrl = await listen(proxy);

  try {
    const response = await fetch(`${proxyUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'codex',
        input: 'search',
        tools: [{ type: 'web_search' }],
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(upstreamBodies.length, 3);
    assert.equal(body.status, 'completed');
    assert.equal(body.incomplete_details, null);
    assert.match(body.output_text, /Incomplete response/);
    assert.equal(body.output_text.includes('DSML'), false);
    assert.equal(body.output_text.includes('tavily_search'), false);
  } finally {
    await close(proxy);
    await close(upstream);
    await close(tavily);
  }
  });
  await scenario('keeps non-web tools available after web tools are disabled', async () => {
  const upstreamBodies = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    upstreamBodies.push(body);
    const toolNames = (body.tools || []).map((tool) => tool.function?.name).filter(Boolean);
    res.writeHead(200, { 'content-type': 'application/json' });
    if (toolNames.includes('web_search')) {
      assert.equal(toolNames.includes('apply_patch'), true);
      res.end(JSON.stringify({
        choices: [{
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{ id: 'call_search', type: 'function', function: { name: 'web_search', arguments: '{"query":"latest"}' } }],
          },
          finish_reason: 'tool_calls',
        }],
      }));
      return;
    }
    assert.equal(toolNames.includes('web_search'), false);
    assert.equal(toolNames.includes('web_open_page'), false);
    assert.equal(toolNames.includes('web_find_in_page'), false);
    assert.equal(toolNames.includes('apply_patch'), true);
    assert.match(body.messages.at(-1).content, /Continue the task using completed web results/);
    assert.doesNotMatch(body.messages.at(-1).content, /Answer now using only completed tool results/);
    res.end(JSON.stringify({
      choices: [{
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: 'call_patch',
            type: 'function',
            function: {
              name: 'apply_patch',
              arguments: JSON.stringify({
                edits: [{ type: 'replace_text', file: 'notes.md', old: 'old text', new: 'new text' }],
              }),
            },
          }],
        },
        finish_reason: 'tool_calls',
      }],
    }));
  });
  const upstreamUrl = await listen(upstream);
  const proxy = createProxyServer({
    config: {
      upstreamBaseUrl: upstreamUrl,
      upstreamApiKey: 'test-key',
      upstreamModel: 'deepseek-v4-flash',
      upstreamProvider: 'deepseek',
      upstreamTimeoutMs: 5000,
      tavilyApiKey: 'tvly-test',
      tavilyBaseUrl: 'http://127.0.0.1:9',
      tavilyWebSearchEnabled: true,
      tavilyTimeoutMs: 5000,
      webSearchMaxRounds: 0,
    },
    reasoningCache: new ReasoningCache(),
  });
  const proxyUrl = await listen(proxy);

  try {
    const response = await fetch(`${proxyUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'codex',
        input: 'search then edit',
        tools: [
          { type: 'web_search_preview' },
          {
            type: 'custom',
            name: 'apply_patch',
            description: 'Edit files.',
            format: { type: 'grammar', syntax: 'lark', definition: 'start: begin_patch hunk+ end_patch' },
          },
        ],
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(upstreamBodies.length, 2);
    assert.equal(body.output_text, '');
    assert.equal(body.output.some((item) => item.type === 'web_search_call'), false);
    const patch = body.output.find((item) => item.type === 'custom_tool_call' && item.name === 'apply_patch');
    assert.equal(patch.call_id, 'call_patch');
    assert.match(patch.input, /\*\*\* Begin Patch/);
    assert.match(patch.input, /\*\*\* Update File: notes\.md/);
    assert.match(patch.input, /-old text/);
    assert.match(patch.input, /\+new text/);
    assert.doesNotMatch(body.output_text, /Incomplete response/);
  } finally {
    await close(proxy);
    await close(upstream);
  }
  });
  await scenario('allows model-driven multi-round web search before final answer', async () => {
  const upstreamBodies = [];
  const searchQueries = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    upstreamBodies.push(body);
    res.writeHead(200, { 'content-type': 'application/json' });
    if (upstreamBodies.length <= 4) {
      res.end(JSON.stringify({
        choices: [
          {
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  id: `call_search_${upstreamBodies.length}`,
                  type: 'function',
                  function: {
                    name: 'tavily_search',
                    arguments: JSON.stringify({ query: `search round ${upstreamBodies.length}` }),
                  },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      }));
      return;
    }
    res.end(JSON.stringify({
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'Final answer after four searches [1].',
          },
          finish_reason: 'stop',
        },
      ],
    }));
  });
  const tavily = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    searchQueries.push(body.query);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      results: [{ title: body.query, url: `https://example.com/${searchQueries.length}`, content: `Snippet ${searchQueries.length}` }],
    }));
  });
  const upstreamUrl = await listen(upstream);
  const tavilyUrl = await listen(tavily);
  const proxy = createProxyServer({
    config: {
      upstreamBaseUrl: upstreamUrl,
      upstreamApiKey: 'test-key',
      upstreamModel: 'deepseek-v4-flash',
      upstreamProvider: 'deepseek',
      upstreamTimeoutMs: 5000,
      tavilyApiKey: 'tvly-test',
      tavilyBaseUrl: tavilyUrl,
      tavilyWebSearchEnabled: true,
      webSearchMaxRounds: 8,
    },
    reasoningCache: new ReasoningCache(),
  });
  const proxyUrl = await listen(proxy);

  try {
    const response = await fetch(`${proxyUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'codex',
        input: 'search until you have enough context',
        tools: [{ type: 'web_search' }],
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(upstreamBodies.length, 5);
    assert.deepEqual(searchQueries, ['search round 1', 'search round 2', 'search round 3', 'search round 4']);
    assert.equal(body.output.filter((item) => item.type === 'web_search_call').length, 4);
    assert.equal(body.output.at(-1).content[0].text, 'Final answer after four searches [1].');
    assert.notEqual(upstreamBodies.at(-1).tool_choice, 'none');
    assert.equal(upstreamBodies.at(-1).tools.some((tool) => tool.function?.name === 'web_search'), true);
  } finally {
    await close(proxy);
    await close(upstream);
    await close(tavily);
  }
  });
  await scenario('completes with a visible gateway explanation when final answer turn has no visible content', async () => {
  const upstreamBodies = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    upstreamBodies.push(body);
    res.writeHead(200, { 'content-type': 'application/json' });
    if (upstreamBodies.length === 1) {
      res.end(JSON.stringify({
        choices: [
          {
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  id: 'call_search',
                  type: 'function',
                  function: { name: 'tavily_search', arguments: '{"query":"latest docs"}' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      }));
      return;
    }
    if (upstreamBodies.length === 2) {
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: '', reasoning_content: 'Now I can summarize.' }, finish_reason: 'stop' }],
      }));
      return;
    }
    assert.equal(body.tool_choice, undefined);
    assert.equal(body.tools, undefined);
    res.end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: '', reasoning_content: 'Still only reasoning.' }, finish_reason: 'stop' }],
    }));
  });
  const tavily = http.createServer(async (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      results: [{ title: 'Docs', url: 'https://example.com/docs', content: 'Snippet' }],
    }));
  });
  const upstreamUrl = await listen(upstream);
  const tavilyUrl = await listen(tavily);
  const proxy = createProxyServer({
    config: {
      upstreamBaseUrl: upstreamUrl,
      upstreamApiKey: 'test-key',
      upstreamModel: 'deepseek-v4-flash',
      upstreamProvider: 'deepseek',
      upstreamTimeoutMs: 5000,
      tavilyApiKey: 'tvly-test',
      tavilyBaseUrl: tavilyUrl,
      tavilyWebSearchEnabled: true,
      webSearchMaxRounds: 2,
    },
    reasoningCache: new ReasoningCache(),
  });
  const proxyUrl = await listen(proxy);

  try {
    const response = await fetch(`${proxyUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'codex',
        input: 'search then answer',
        tools: [{ type: 'web_search' }],
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(upstreamBodies.length, 3);
    assert.equal(body.status, 'completed');
    assert.equal(body.incomplete_details, null);
    assert.match(body.output_text, /Incomplete response/);
  } finally {
    await close(proxy);
    await close(upstream);
    await close(tavily);
  }
  });
  await scenario('recovers from unsupported model tool calls with a final answer turn', async () => {
  const upstreamBodies = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    upstreamBodies.push(body);
    res.writeHead(200, { 'content-type': 'application/json' });
    if (upstreamBodies.length === 1) {
      res.end(JSON.stringify({
        choices: [
          {
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  id: 'call_search',
                  type: 'function',
                  function: { name: 'tavily_search', arguments: '{"query":"docs"}' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      }));
      return;
    }
    if (upstreamBodies.length === 2) {
      res.end(JSON.stringify({
        choices: [
          {
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  id: 'call_unsupported',
                  type: 'function',
                  function: { name: 'unsupported_tool', arguments: '{"q":"docs"}' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      }));
      return;
    }
    assert.equal(body.tool_choice, undefined);
    assert.equal(body.tools, undefined);
    assert.equal(body.messages.at(-2).role, 'tool');
    assert.match(body.messages.at(-2).content, /not available in this turn/);
    res.end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'Final answer from available source [1].' }, finish_reason: 'stop' }],
    }));
  });
  const tavily = http.createServer(async (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      results: [{ title: 'Docs', url: 'https://example.com/docs', content: 'Snippet' }],
    }));
  });
  const upstreamUrl = await listen(upstream);
  const tavilyUrl = await listen(tavily);
  const proxy = createProxyServer({
    config: {
      upstreamBaseUrl: upstreamUrl,
      upstreamApiKey: 'test-key',
      upstreamModel: 'deepseek-v4-flash',
      upstreamProvider: 'deepseek',
      upstreamTimeoutMs: 5000,
      tavilyApiKey: 'tvly-test',
      tavilyBaseUrl: tavilyUrl,
      tavilyWebSearchEnabled: true,
      webSearchMaxRounds: 2,
    },
    reasoningCache: new ReasoningCache(),
  });
  const proxyUrl = await listen(proxy);

  try {
    const response = await fetch(`${proxyUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'codex',
        input: 'search then answer',
        tools: [{ type: 'web_search' }],
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(upstreamBodies.length, 3);
    assert.equal(body.output.some((item) => item.type === 'function_call' && item.name === 'unsupported_tool'), false);
    assert.equal(body.output.at(-1).content[0].text, 'Final answer from available source [1].');
  } finally {
    await close(proxy);
    await close(upstream);
    await close(tavily);
  }
  });
  await scenario('exposes an unavailable web_search shim when no search provider is configured', async () => {
  const upstreamBodies = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    upstreamBodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
    }));
  });
  const upstreamUrl = await listen(upstream);
  const proxy = createProxyServer({
    config: {
      upstreamBaseUrl: upstreamUrl,
      upstreamApiKey: 'test-key',
      upstreamModel: 'deepseek-v4-flash',
      upstreamProvider: 'deepseek',
      upstreamTimeoutMs: 5000,
    },
    reasoningCache: new ReasoningCache(),
  });
  const proxyUrl = await listen(proxy);

  try {
    const response = await fetch(`${proxyUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-v4-flash',
        input: 'find the docs',
        store: false,
        tools: [
          { type: 'web_search' },
          { type: 'function', name: 'shell_command', parameters: { type: 'object', properties: {} } },
        ],
      }),
    });
    assert.equal(response.status, 200);
    const toolNames = upstreamBodies[0].tools.map((tool) => tool.function.name);
    assert.deepEqual(toolNames, ['shell_command', 'web_search', 'commentary']);
    const shim = upstreamBodies[0].tools.find((tool) => tool.function.name === 'web_search');
    assert.match(shim.function.description, /no search provider is configured/);
  } finally {
    await close(proxy);
    await close(upstream);
  }
  });
  await scenario('feeds provider search failures back to the model and completes the turn', async () => {
  const upstreamBodies = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    upstreamBodies.push(body);
    res.writeHead(200, { 'content-type': 'application/json' });
    if (upstreamBodies.length === 1) {
      res.end(JSON.stringify({
        choices: [{
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{ id: 'call_failed_search', type: 'function', function: { name: 'web_search', arguments: '{"query":"current status"}' } }],
          },
          finish_reason: 'tool_calls',
        }],
      }));
      return;
    }
    assert.equal(body.messages.at(-1).role, 'tool');
    assert.match(body.messages.at(-1).content, /Search error: provider unavailable/);
    res.end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'Live search is unavailable, so I cannot verify the current status.' }, finish_reason: 'stop' }],
    }));
  });
  const tavily = http.createServer(async (_req, res) => {
    res.writeHead(503, { 'content-type': 'text/plain' });
    res.end('provider unavailable');
  });
  const upstreamUrl = await listen(upstream);
  const tavilyUrl = await listen(tavily);
  const proxy = createProxyServer({
    config: {
      upstreamBaseUrl: upstreamUrl,
      upstreamApiKey: 'test-key',
      upstreamModel: 'deepseek-v4-flash',
      upstreamProvider: 'deepseek',
      upstreamTimeoutMs: 5000,
      tavilyApiKey: 'tvly-test',
      tavilyBaseUrl: tavilyUrl,
      tavilyWebSearchEnabled: true,
      tavilyTimeoutMs: 5000,
    },
    reasoningCache: new ReasoningCache(),
  });
  const proxyUrl = await listen(proxy);

  try {
    const response = await fetch(`${proxyUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-v4-flash', input: 'Check current status.', tools: [{ type: 'web_search' }] }),
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(upstreamBodies.length, 2);
    assert.equal(body.status, 'completed');
    const searchItem = body.output.find((item) => item.type === 'web_search_call');
    assert.equal(searchItem.status, 'failed');
    assert.equal(searchItem.error.message, 'provider unavailable');
    assert.equal(body.output_text, 'Live search is unavailable, so I cannot verify the current status.');
  } finally {
    await close(proxy);
    await close(upstream);
    await close(tavily);
  }
  });
});

test('streaming web-search rounds, usage, and commentary', async () => {
  await scenario('emulates Codex web_search with progressive Responses SSE when client requests stream', async () => {
  let tavilyResolve;
  const tavilyStarted = new Promise((resolve) => {
    tavilyResolve = resolve;
  });
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    res.writeHead(200, { 'content-type': 'application/json' });
    if (!body.messages.some((message) => message.role === 'tool')) {
      res.end(JSON.stringify({
        choices: [
          {
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  id: 'call_search',
                  type: 'function',
                  function: { name: 'web_search', arguments: '{"query":"live result"}' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      }));
      return;
    }
    res.end(JSON.stringify({
      choices: [{
        message: {
          role: 'assistant',
          content: 'Answer [1].',
          reasoning_content: 'Checked the search result before answering.',
        },
        finish_reason: 'stop',
      }],
    }));
  });
  const tavily = http.createServer(async (_req, res) => {
    tavilyResolve();
    await new Promise((resolve) => setTimeout(resolve, 50));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      results: [{ title: 'Source', url: 'https://example.com/source', content: 'Snippet' }],
    }));
  });
  const upstreamUrl = await listen(upstream);
  const tavilyUrl = await listen(tavily);
  const proxy = createProxyServer({
    config: {
      upstreamBaseUrl: upstreamUrl,
      upstreamApiKey: 'test-key',
      upstreamModel: 'deepseek-v4-flash',
      upstreamProvider: 'deepseek',
      upstreamTimeoutMs: 5000,
      tavilyApiKey: 'tvly-test',
      tavilyBaseUrl: tavilyUrl,
      tavilyWebSearchEnabled: true,
      tavilyTimeoutMs: 5000,
    },
    reasoningCache: new ReasoningCache(),
  });
  const proxyUrl = await listen(proxy);

  try {
    const response = await fetch(`${proxyUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'codex',
        input: 'search',
        stream: true,
        tools: [{ type: 'web_search_preview' }],
      }),
    });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    let earlyText = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      earlyText += Buffer.from(value).toString('utf8');
      if (earlyText.includes('"type":"web_search_call"')) break;
    }
    await tavilyStarted;
    assert.match(earlyText, /event: response\.created/);
    assert.match(earlyText, /"type":"web_search_call"/);
    assert.match(earlyText, /"status":"in_progress"/);
    assert.doesNotMatch(earlyText, /"text":"Answer \[1\]\."/);
    let remainingText = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      remainingText += Buffer.from(value).toString('utf8');
    }
    const text = earlyText + remainingText;
    const frames = parseResponsesSse(text);
    const completed = frames.find((frame) => frame.event === 'response.completed').data.response;
    const webSearch = completed.output.find((item) => item.type === 'web_search_call');
    assert.equal(webSearch.status, 'completed');
    assert.equal('sources' in webSearch, false);
    assert.equal(frames.some((frame) => frame.event === 'response.reasoning_summary_part.added'), true);
    const reasoningText = frames
      .filter((frame) => frame.event === 'response.reasoning_summary_text.delta')
      .map((frame) => frame.data.delta)
      .join('');
    assert.match(reasoningText, /Checked the search result before answering\./);
    const summaryDeltaIndex = frames.findIndex((frame) => frame.event === 'response.reasoning_summary_text.delta');
    const outputDeltaIndex = frames.findIndex((frame) => frame.event === 'response.output_text.delta');
    assert.ok(summaryDeltaIndex !== -1 && summaryDeltaIndex < outputDeltaIndex);
    assert.equal(frames.some((frame) => frame.event === 'response.output_text.annotation.added'), false);
    const outputPart = completed.output.find((item) => item.type === 'message').content[0];
    assert.equal(outputPart.text, 'Answer [1].');
    assert.equal(outputPart.annotations[0].type, 'url_citation');
    assert.equal(outputPart.annotations[0].url, 'https://example.com/source');
    assert.equal(frames.at(-1).data, '[DONE]');
  } finally {
    await close(proxy);
    await close(upstream);
    await close(tavily);
  }
  });
  await scenario('streams reasoning live and reports final-round usage with aggregate diagnostics', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'gateway-web-usage-'));
  const debugPath = join(tempDir, 'debug.log');
  let tavilyResolve;
  const tavilyStarted = new Promise((resolve) => {
    tavilyResolve = resolve;
  });
  const sse = (res, payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
    if (!body.messages.some((message) => message.role === 'tool')) {
      sse(res, { choices: [{ delta: { reasoning_content: 'Need fresh data.\n' }, finish_reason: null }] });
      sse(res, {
        choices: [{
          delta: {
            tool_calls: [{ index: 0, id: 'call_search', type: 'function', function: { name: 'tavily_search', arguments: '{"query":"latest"}' } }],
          },
          finish_reason: null,
        }],
      });
      sse(res, { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    sse(res, { choices: [{ delta: { reasoning_content: 'Results are in.\n' }, finish_reason: null }] });
    sse(res, { choices: [{ delta: { content: 'Fresh answer.' }, finish_reason: null }] });
    sse(res, { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 60, completion_tokens: 7 } });
    res.write('data: [DONE]\n\n');
    res.end();
  });
  const tavily = http.createServer(async (_req, res) => {
    tavilyResolve();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      results: [{ title: 'Source', url: 'https://example.com/live', content: 'Snippet' }],
    }));
  });
  const upstreamUrl = await listen(upstream);
  const tavilyUrl = await listen(tavily);
  const reasoningCache = new ReasoningCache();
  const proxy = createProxyServer({
    config: {
      upstreamBaseUrl: upstreamUrl,
      upstreamApiKey: 'test-key',
      upstreamModel: 'deepseek-v4-flash',
      upstreamProvider: 'deepseek',
      upstreamTimeoutMs: 5000,
      tavilyApiKey: 'tvly-test',
      tavilyBaseUrl: tavilyUrl,
      tavilyWebSearchEnabled: true,
      tavilyTimeoutMs: 5000,
      debugPayload: true,
      debugPayloadLogPath: debugPath,
    },
    reasoningCache,
  });
  const proxyUrl = await listen(proxy);

  try {
    const response = await fetch(`${proxyUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'codex',
        input: 'search',
        stream: true,
        client_metadata: {
          session_id: 'session_usage',
          thread_id: 'thread_usage',
          turn_id: 'turn_usage',
        },
        tools: [{ type: 'web_search_preview' }],
      }),
    });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    let earlyText = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      earlyText += Buffer.from(value).toString('utf8');
      if (earlyText.includes('"type":"web_search_call"')) break;
    }
    await tavilyStarted;
    assert.match(earlyText, /event: response\.reasoning_summary_text\.delta/);
    assert.match(earlyText, /Need fresh data\./);
    let text = earlyText;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      text += Buffer.from(value).toString('utf8');
    }
    const frames = parseResponsesSse(text);
    const reasoningAdded = frames.filter(
      (frame) => frame.event === 'response.output_item.added' && frame.data.item.type === 'reasoning',
    );
    assert.equal(reasoningAdded.length, 2);
    const reasoningText = frames
      .filter((frame) => frame.event === 'response.reasoning_summary_text.delta')
      .map((frame) => frame.data.delta)
      .join('');
    assert.match(reasoningText, /Results are in\./);
    const completedFrames = frames.filter((frame) => frame.event === 'response.completed');
    assert.equal(completedFrames.length, 1);
    const completed = completedFrames[0].data;
    assert.equal(completed.response.output_text, 'Fresh answer.');
    assert.equal(completed.response.output.some((item) => item.type === 'function_call'), false);
    assert.equal(completed.response.output.some((item) => item.name === 'tavily_search'), false);
    assert.equal(completed.response.usage.output_tokens, 7);
    assert.equal(completed.response.usage.input_tokens, 60);
    const usageLine = (await readFile(debugPath, 'utf8')).split(/\r?\n/)
      .find((line) => line.startsWith('[codex-deepseek-gateway] web search usage '));
    const usage = JSON.parse(usageLine.replace('[codex-deepseek-gateway] web search usage ', ''));
    assert.equal(usage.session_id, 'session_usage');
    assert.equal(usage.thread_id, 'thread_usage');
    assert.equal(usage.turn_id, 'turn_usage');
    assert.equal(usage.stage, 'web_search_stream');
    assert.equal(usage.rounds, 2);
    assert.equal(usage.aggregate.prompt_tokens, 70);
    assert.equal(usage.aggregate.completion_tokens, 12);
    assert.equal(usage.final.prompt_tokens, 60);
    assert.equal(usage.final.completion_tokens, 7);
    assert.equal(usage.web.providerCalls, 1);
    assert.equal(usage.web.counts.searches, 1);
    assert.equal(usage.web.operations[0].provider, 'tavily');
    assert.equal(usage.web.operations[0].source, 'explicit');
    assert.equal(usage.web.operations[0].query, 'latest');
    assert.match(usage.web.operations[0].itemId, /^ws_/);
    assert.deepEqual(usage.web.operations[0].options, {
      searchDepth: 'basic',
      maxResults: 5,
      includeDomains: 0,
      excludeDomains: 0,
    });
    assert.equal(frames.at(-1).data, '[DONE]');

  } finally {
    await close(proxy);
    await close(upstream);
    await close(tavily);
    await rm(tempDir, { recursive: true, force: true });
  }
  });
  await scenario('replaces pseudo tool-call text with the gateway incomplete answer in the streamed final round', async () => {
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    res.writeHead(200, { 'content-type': 'application/json' });
    if (Array.isArray(body.tools) && body.tools.length) {
      res.end(JSON.stringify({
        choices: [{
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{ id: 'call_search', type: 'function', function: { name: 'tavily_search', arguments: '{"query":"latest"}' } }],
          },
          finish_reason: 'tool_calls',
        }],
      }));
      return;
    }
    res.end(JSON.stringify({
      choices: [{
        message: { role: 'assistant', content: '<DSML tool_calls>\n<invoke name="tavily_search">' },
        finish_reason: 'stop',
      }],
    }));
  });
  const upstreamUrl = await listen(upstream);
  const proxy = createProxyServer({
    config: {
      upstreamBaseUrl: upstreamUrl,
      upstreamApiKey: 'test-key',
      upstreamModel: 'deepseek-v4-flash',
      upstreamProvider: 'deepseek',
      upstreamTimeoutMs: 5000,
      tavilyApiKey: 'tvly-test',
      tavilyBaseUrl: 'http://127.0.0.1:9',
      tavilyWebSearchEnabled: true,
      tavilyTimeoutMs: 5000,
      webSearchMaxRounds: 0,
    },
    reasoningCache: new ReasoningCache(),
  });
  const proxyUrl = await listen(proxy);

  try {
    const response = await fetch(`${proxyUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'codex',
        input: 'search',
        stream: true,
        tools: [{ type: 'web_search_preview' }],
      }),
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    const frames = parseResponsesSse(text);
    const completed = frames.find((frame) => frame.event === 'response.completed');
    assert.match(completed.data.response.output_text, /Incomplete response: after web tools were disabled/);
    assert.equal(completed.data.response.output.some((item) => item.type === 'function_call'), false);
    assert.equal(completed.data.response.output.some((item) => item.type === 'web_search_call'), false);
    assert.doesNotMatch(completed.data.response.output_text, /DSML tool_calls/);
    assert.equal(frames.at(-1).data, '[DONE]');
  } finally {
    await close(proxy);
    await close(upstream);
  }
  });
  await scenario('streams non-web tool calls after web tools are disabled', async () => {
  const upstreamBodies = [];
  const sse = (res, payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    upstreamBodies.push(body);
    const toolNames = (body.tools || []).map((tool) => tool.function?.name).filter(Boolean);
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
    if (toolNames.includes('web_search')) {
      assert.equal(toolNames.includes('apply_patch'), true);
      sse(res, {
        choices: [{
          delta: {
            tool_calls: [{ index: 0, id: 'call_search', type: 'function', function: { name: 'web_search', arguments: '{"query":"latest"}' } }],
          },
          finish_reason: null,
        }],
      });
      sse(res, { choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    assert.equal(toolNames.includes('web_search'), false);
    assert.equal(toolNames.includes('web_open_page'), false);
    assert.equal(toolNames.includes('web_find_in_page'), false);
    assert.equal(toolNames.includes('apply_patch'), true);
    assert.match(body.messages.at(-1).content, /Continue the task using completed web results/);
    sse(res, {
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            id: 'call_patch',
            type: 'function',
            function: {
              name: 'apply_patch',
              arguments: JSON.stringify({
                edits: [{ type: 'replace_text', file: 'notes.md', old: 'old text', new: 'new text' }],
              }),
            },
          }],
        },
        finish_reason: null,
      }],
    });
    sse(res, { choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
    res.write('data: [DONE]\n\n');
    res.end();
  });
  const upstreamUrl = await listen(upstream);
  const proxy = createProxyServer({
    config: {
      upstreamBaseUrl: upstreamUrl,
      upstreamApiKey: 'test-key',
      upstreamModel: 'deepseek-v4-flash',
      upstreamProvider: 'deepseek',
      upstreamTimeoutMs: 5000,
      tavilyApiKey: 'tvly-test',
      tavilyBaseUrl: 'http://127.0.0.1:9',
      tavilyWebSearchEnabled: true,
      tavilyTimeoutMs: 5000,
      webSearchMaxRounds: 0,
    },
    reasoningCache: new ReasoningCache(),
  });
  const proxyUrl = await listen(proxy);

  try {
    const response = await fetch(`${proxyUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'codex',
        input: 'search then edit',
        stream: true,
        tools: [
          { type: 'web_search_preview' },
          {
            type: 'custom',
            name: 'apply_patch',
            description: 'Edit files.',
            format: { type: 'grammar', syntax: 'lark', definition: 'start: begin_patch hunk+ end_patch' },
          },
        ],
      }),
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    const frames = parseResponsesSse(text);
    assert.equal(upstreamBodies.length, 2);
    const completed = frames.find((frame) => frame.event === 'response.completed').data.response;
    assert.equal(completed.output.some((item) => item.type === 'web_search_call'), false);
    const patch = completed.output.find((item) => item.type === 'custom_tool_call' && item.name === 'apply_patch');
    assert.equal(patch.call_id, 'call_patch');
    assert.match(patch.input, /\*\*\* Update File: notes\.md/);
    assert.equal(completed.output_text, '');
    assert.doesNotMatch(completed.output_text, /Incomplete response/);
    assert.equal(frames.at(-1).data, '[DONE]');
  } finally {
    await close(proxy);
    await close(upstream);
  }
  });
  await scenario('streams thinking-mode final text incrementally through the web-search path', async () => {
  const upstream = http.createServer(async (_req, res) => {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
    });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'Thinking about the answer.\n' }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Hello ' }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'streamed ' }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'world.' }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });
  const upstreamUrl = await listen(upstream);
  const proxy = createProxyServer({
    config: {
      upstreamBaseUrl: upstreamUrl,
      upstreamApiKey: 'test-key',
      upstreamModel: 'deepseek-v4-flash',
      upstreamProvider: 'deepseek',
      upstreamTimeoutMs: 5000,
      tavilyApiKey: 'tvly-test',
      tavilyBaseUrl: 'http://127.0.0.1:9',
      tavilyWebSearchEnabled: true,
      tavilyTimeoutMs: 5000,
    },
    reasoningCache: new ReasoningCache(),
  });
  const proxyUrl = await listen(proxy);

  try {
    const response = await fetch(`${proxyUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'codex',
        input: 'say hello',
        stream: true,
        reasoning: { effort: 'high' },
        tools: [{ type: 'web_search_preview' }],
      }),
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    const frames = parseResponsesSse(text);
    const textDeltas = frames
      .filter((frame) => frame.event === 'response.output_text.delta')
      .map((frame) => frame.data.delta);
    assert.deepEqual(textDeltas, ['Hello ', 'streamed ', 'world.']);
    const summaryDeltaIndex = frames.findIndex((frame) => frame.event === 'response.reasoning_summary_text.delta');
    const reasoningDoneIndex = frames.findIndex(
      (frame) => frame.event === 'response.output_item.done' && frame.data.item.type === 'reasoning',
    );
    const messageAddedIndex = frames.findIndex(
      (frame) => frame.event === 'response.output_item.added' && frame.data.item.type === 'message',
    );
    const firstTextDeltaIndex = frames.findIndex((frame) => frame.event === 'response.output_text.delta');
    assert.ok(summaryDeltaIndex !== -1 && reasoningDoneIndex !== -1 && messageAddedIndex !== -1 && firstTextDeltaIndex !== -1);
    assert.ok(summaryDeltaIndex < reasoningDoneIndex);
    assert.ok(reasoningDoneIndex < messageAddedIndex);
    assert.ok(messageAddedIndex < firstTextDeltaIndex);
    const messageDone = frames.find(
      (frame) => frame.event === 'response.output_item.done' && frame.data.item.type === 'message',
    );
    assert.equal(messageDone.data.item.phase, 'final_answer');
    assert.equal(
      frames.find((frame) => frame.event === 'response.completed').data.response.output_text,
      'Hello streamed world.',
    );
  } finally {
    await close(proxy);
    await close(upstream);
  }
  });
  await scenario('expands multi_tool_use.parallel into individual Codex tool calls through the web-search path', async () => {
  const wrapperArguments = JSON.stringify({
    tool_uses: [
      { recipient_name: 'functions.shell_command', parameters: { command: 'rg --files src' } },
      { recipient_name: 'functions.shell_command', parameters: { command: 'Get-Content package.json' } },
    ],
  });
  const upstream = http.createServer(async (_req, res) => {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
    });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'Batching two reads.\n' }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_wrapper', type: 'function', function: { name: 'multi_tool_use.parallel', arguments: wrapperArguments } }] }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });
  const upstreamUrl = await listen(upstream);
  const proxy = createProxyServer({
    config: {
      upstreamBaseUrl: upstreamUrl,
      upstreamApiKey: 'test-key',
      upstreamModel: 'deepseek-v4-flash',
      upstreamProvider: 'deepseek',
      upstreamTimeoutMs: 5000,
      tavilyApiKey: 'tvly-test',
      tavilyBaseUrl: 'http://127.0.0.1:9',
      tavilyWebSearchEnabled: true,
      tavilyTimeoutMs: 5000,
    },
    reasoningCache: new ReasoningCache(),
  });
  const proxyUrl = await listen(proxy);

  try {
    const response = await fetch(`${proxyUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'codex',
        input: 'read both files',
        stream: true,
        reasoning: { effort: 'high' },
        tools: [
          { type: 'web_search_preview' },
          {
            type: 'function',
            name: 'shell_command',
            parameters: {
              type: 'object',
              properties: { command: { type: 'string' } },
              required: ['command'],
            },
          },
        ],
      }),
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    const frames = parseResponsesSse(text);
    const doneItems = frames
      .filter((frame) => frame.event === 'response.output_item.done' && frame.data.item.type === 'function_call')
      .map((frame) => frame.data.item);
    assert.equal(doneItems.length, 2);
    assert.deepEqual(doneItems.map((item) => item.name), ['shell_command', 'shell_command']);
    assert.deepEqual(
      doneItems.map((item) => item.arguments),
      ['{"command":"rg --files src"}', '{"command":"Get-Content package.json"}'],
    );
    assert.notEqual(doneItems[0].call_id, doneItems[1].call_id);
    assert.equal(doneItems.some((item) => item.name === 'multi_tool_use.parallel'), false);
    assert.equal(frames.some((frame) => frame.event === 'response.reasoning_summary_text.delta'), true);
    assert.equal(frames.some((frame) => frame.event === 'response.completed'), true);
  } finally {
    await close(proxy);
    await close(upstream);
  }
  });
  await scenario('answers commentary-only rounds internally and streams the update as a commentary message', async () => {
  const upstreamBodies = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    upstreamBodies.push(body);
    res.writeHead(200, { 'content-type': 'application/json' });
    if (!body.messages.some((message) => message.role === 'tool')) {
      res.end(JSON.stringify({
        choices: [{
          message: {
            role: 'assistant',
            content: '',
            reasoning_content: 'planning the first step',
            tool_calls: [{
              id: 'call_note',
              type: 'function',
              function: { name: 'commentary', arguments: '{"text":"Starting with the config file."}' },
            }],
          },
          finish_reason: 'tool_calls',
        }],
      }));
      return;
    }
    res.end(JSON.stringify({
      choices: [{
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: 'call_shell',
            type: 'function',
            function: { name: 'shell_command', arguments: '{"command":"ls"}' },
          }],
        },
        finish_reason: 'tool_calls',
      }],
    }));
  });
  const upstreamUrl = await listen(upstream);
  const proxy = createProxyServer({
    config: {
      upstreamBaseUrl: upstreamUrl,
      upstreamApiKey: 'test-key',
      upstreamModel: 'deepseek-v4-flash',
      upstreamProvider: 'deepseek',
      upstreamTimeoutMs: 5000,
      tavilyApiKey: 'tvly-test',
      tavilyBaseUrl: 'http://127.0.0.1:9',
      tavilyWebSearchEnabled: true,
      tavilyTimeoutMs: 1000,
    },
    reasoningCache: new ReasoningCache(),
  });
  const proxyUrl = await listen(proxy);

  try {
    const response = await fetch(`${proxyUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'codex',
        input: 'do the work',
        stream: true,
        store: false,
        tools: [
          { type: 'web_search_preview' },
          { type: 'function', name: 'shell_command', parameters: { type: 'object', properties: {} } },
        ],
      }),
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    const frames = parseResponsesSse(text);

    assert.equal(upstreamBodies.length, 2);
    assert.equal(upstreamBodies[0].tools.some((tool) => tool.function?.name === 'commentary'), true);
    const replayedAssistant = upstreamBodies[1].messages.findLast(
      (message) => message.role === 'assistant' && Array.isArray(message.tool_calls),
    );
    assert.deepEqual(replayedAssistant.tool_calls.map((toolCall) => toolCall.function.name), ['commentary']);
    assert.equal(replayedAssistant.reasoning_content, 'planning the first step');
    const commentaryToolResult = upstreamBodies[1].messages.find(
      (message) => message.role === 'tool' && message.tool_call_id === 'call_note',
    );
    assert.equal(commentaryToolResult.content, 'Delivered to the user.');

    const commentaryDoneIndex = frames.findIndex(
      (frame) => frame.event === 'response.output_item.done'
        && frame.data.item.type === 'message'
        && frame.data.item.phase === 'commentary',
    );
    const shellDoneIndex = frames.findIndex(
      (frame) => frame.event === 'response.output_item.done'
        && frame.data.item.type === 'function_call'
        && frame.data.item.name === 'shell_command',
    );
    assert.ok(commentaryDoneIndex !== -1 && commentaryDoneIndex < shellDoneIndex);
    assert.equal(
      frames.some((frame) => frame.event === 'response.output_item.done' && frame.data.item.name === 'commentary'),
      false,
    );
    const completedPayload = frames.find((frame) => frame.event === 'response.completed').data;
    const commentaryItems = completedPayload.response.output.filter(
      (item) => item.type === 'message' && item.phase === 'commentary',
    );
    assert.equal(commentaryItems.length, 1);
    assert.equal(commentaryItems[0].content[0].text, 'Starting with the config file.');
    assert.equal(completedPayload.response.output.some((item) => item.type === 'function_call' && item.name === 'shell_command'), true);
    assert.equal(completedPayload.response.output_text, '');
  } finally {
    await close(proxy);
    await close(upstream);
  }
  });
  await scenario('uses configured idle heartbeats with minimal payload in web-search streams', async () => {
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
    res.flushHeaders();
    const timers = [20, 50, 80, 110].map((delay) => setTimeout(() => {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'x' }, finish_reason: null }] })}\n\n`);
    }, delay));
    timers.push(setTimeout(() => {
      res.write(`data: ${JSON.stringify({
        choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
      })}\n\n`);
      res.end('data: [DONE]\n\n');
    }, 220));
    res.on('close', () => timers.forEach(clearTimeout));
  });
  const upstreamUrl = await listen(upstream);
  const proxy = createProxyServer({
    config: {
      upstreamBaseUrl: upstreamUrl,
      upstreamApiKey: 'test-key',
      upstreamModel: 'deepseek-v4-flash',
      upstreamProvider: 'deepseek',
      upstreamTimeoutMs: 5000,
      streamHeartbeatMs: 60,
      tavilyApiKey: 'tvly-test',
      tavilyWebSearchEnabled: true,
    },
    reasoningCache: new ReasoningCache(),
  });
  const proxyUrl = await listen(proxy);

  try {
    const response = await fetch(`${proxyUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'codex',
        input: 'hello',
        stream: true,
        tools: [{ type: 'web_search' }],
      }),
    });
    assert.equal(response.status, 200);
    const frames = parseResponsesSse(await response.text());
    const heartbeats = frames.filter((frame) => frame.event === 'response.in_progress');
    const lastDeltaIndex = frames.findLastIndex((frame) => frame.event === 'response.output_text.delta');
    const heartbeatIndexes = frames
      .map((frame, index) => frame.event === 'response.in_progress' ? index : -1)
      .filter((index) => index >= 0);
    assert.ok(heartbeats.length >= 2);
    assert.ok(heartbeatIndexes[1] > lastDeltaIndex);
    assert.deepEqual(heartbeats.at(-1).data.response.output, []);
    assert.deepEqual(heartbeats.at(-1).data.response.tools, []);
  } finally {
    await close(proxy);
    await close(upstream);
  }
  });
});

test('apply_patch correction rounds', async () => {
  const applyPatchTool = {
    type: 'custom',
    name: 'apply_patch',
    description: 'Edit files.',
    format: { type: 'grammar', syntax: 'lark', definition: 'start: begin_patch hunk+ end_patch' },
  };
  const shellTool = {
    type: 'function',
    name: 'shell_command',
    description: 'Run a shell command.',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
      additionalProperties: false,
    },
  };
  const applyPatchCall = (id, edits) => ({
    id,
    type: 'function',
    function: { name: 'apply_patch', arguments: JSON.stringify({ edits }) },
  });
  const toolCallCompletion = (toolCalls) => JSON.stringify({
    choices: [
      {
        message: { role: 'assistant', content: '', tool_calls: toolCalls },
        finish_reason: 'tool_calls',
      },
    ],
  });
  const textCompletion = (content) => JSON.stringify({
    choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
  });
  const jsonUpstream = (handler) => {
    const bodies = [];
    const server = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      bodies.push(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(handler(body, bodies.length));
    });
    return { server, bodies };
  };
  const gatewayConfig = (upstreamUrl, overrides = {}) => ({
    upstreamBaseUrl: upstreamUrl,
    upstreamApiKey: 'test-key',
    upstreamModel: 'deepseek-v4-flash',
    upstreamProvider: 'deepseek',
    upstreamTimeoutMs: 5000,
    ...overrides,
  });

  await scenario('replaces an invalid apply_patch round with a corrected call on the non-streaming web-enabled path', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'gateway-patch-flow-'));
  const debugPath = join(tempDir, 'debug.log');
  const { server: upstream, bodies: upstreamBodies } = jsonUpstream((body) => {
    if (!body.messages.some((message) => message.role === 'tool')) {
      return toolCallCompletion([
        applyPatchCall('call_bad_patch', [{ type: 'replace_text', file: 'a.txt', new: 'new' }]),
        { id: 'call_shell_first', type: 'function', function: { name: 'shell_command', arguments: '{"command":"ls"}' } },
      ]);
    }
    return toolCallCompletion([
      applyPatchCall('call_good_patch', [{ type: 'replace_text', file: 'a.txt', old: 'old', new: 'new' }]),
      { id: 'call_shell_again', type: 'function', function: { name: 'shell_command', arguments: '{"command":"ls"}' } },
    ]);
  });
  const upstreamUrl = await listen(upstream);
  const proxy = createProxyServer({
    config: gatewayConfig(upstreamUrl, {
      tavilyApiKey: 'tvly-test',
      tavilyBaseUrl: 'https://tavily.invalid',
      tavilyWebSearchEnabled: true,
      debugPayload: true,
      debugPayloadLogPath: debugPath,
    }),
    reasoningCache: new ReasoningCache(),
  });
  const proxyUrl = await listen(proxy);

  try {
    const response = await fetch(`${proxyUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'codex',
        input: 'edit the file',
        tools: [{ type: 'web_search' }, applyPatchTool, shellTool],
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(upstreamBodies.length, 2);
    const secondMessages = upstreamBodies[1].messages;
    const assistantEcho = secondMessages.find(
      (message) => message.role === 'assistant' && message.tool_calls?.some((toolCall) => toolCall.id === 'call_bad_patch'),
    );
    assert.ok(assistantEcho);
    assert.equal(assistantEcho.tool_calls.some((toolCall) => toolCall.id === 'call_shell_first'), true);
    const diagnostic = secondMessages.find((message) => message.role === 'tool' && message.tool_call_id === 'call_bad_patch');
    assert.match(diagnostic.content, /apply_patch was not executed\./);
    assert.match(diagnostic.content, /edits\[0\] replace_text: "old" must be non-empty/);
    assert.match(diagnostic.content, /re-issue all intended tool calls/);
    const shellNotice = secondMessages.find((message) => message.role === 'tool' && message.tool_call_id === 'call_shell_first');
    assert.match(shellNotice.content, /No tools were executed this round/);
    assert.match(shellNotice.content, /re-issue all intended tool calls/);
    const customCalls = body.output.filter((item) => item.type === 'custom_tool_call');
    assert.equal(customCalls.length, 1);
    assert.equal(customCalls[0].call_id, 'call_good_patch');
    assert.equal(customCalls[0].input, '*** Begin Patch\n*** Update File: a.txt\n@@\n-old\n+new\n*** End Patch');
    const shellCalls = body.output.filter((item) => item.type === 'function_call' && item.name === 'shell_command');
    assert.equal(shellCalls.length, 1);
    assert.equal(shellCalls[0].call_id, 'call_shell_again');
    assert.equal(body.output.some((item) => item.type === 'custom_tool_call' && !item.input), false);
    assert.equal(JSON.stringify(body.output).includes('call_bad_patch'), false);
    assert.equal(JSON.stringify(body.output).includes('call_shell_first'), false);
    const log = await readFile(debugPath, 'utf8');
    assert.doesNotMatch(log, /\[codex-deepseek-gateway\] web search usage /);
    const line = log.split(/\r?\n/).find((entry) => entry.startsWith('[codex-deepseek-gateway] apply patch usage '));
    const usage = JSON.parse(line.replace('[codex-deepseek-gateway] apply patch usage ', ''));
    assert.equal(usage.stage, 'apply_patch');
    assert.equal(usage.apply_patch.validationOutcome, 'corrected');
    assert.equal(usage.apply_patch.correctionRounds, 1);
    assert.deepEqual(usage.apply_patch.errorCategories, ['schema']);
    assert.doesNotMatch(log, /test-key|"old":"old"/);
  } finally {
    await close(proxy);
    await close(upstream);
    await rm(tempDir, { recursive: true, force: true });
  }
  });

  await scenario('corrects invalid apply_patch through streaming rounds when web search is not configured', async () => {
  const { server: upstream, bodies: upstreamBodies } = jsonUpstream((body) => {
    if (!body.messages.some((message) => message.role === 'tool')) {
      return toolCallCompletion([
        applyPatchCall('call_blank', [{ type: 'insert_text_after', file: 'f.txt', anchor: 'x' }]),
      ]);
    }
    return toolCallCompletion([
      applyPatchCall('call_fixed', [{ type: 'insert_text_after', file: 'f.txt', anchor: 'x', content: '' }]),
    ]);
  });
  const upstreamUrl = await listen(upstream);
  const proxy = createProxyServer({
    config: gatewayConfig(upstreamUrl),
    reasoningCache: new ReasoningCache(),
  });
  const proxyUrl = await listen(proxy);

  try {
    const response = await fetch(`${proxyUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'codex',
        input: 'insert a blank line',
        stream: true,
        tools: [applyPatchTool],
      }),
    });
    assert.equal(response.status, 200);
    const frames = parseResponsesSse(await response.text());
    assert.equal(upstreamBodies.length, 2);
    const diagnostic = upstreamBodies[1].messages.find((message) => message.role === 'tool' && message.tool_call_id === 'call_blank');
    assert.match(diagnostic.content, /apply_patch was not executed\./);
    assert.match(diagnostic.content, /edits\[0\] insert_text_after: "content" is required/);
    const doneCustomItems = frames
      .filter((frame) => frame.event === 'response.output_item.done')
      .map((frame) => frame.data.item)
      .filter((item) => item.type === 'custom_tool_call');
    assert.equal(doneCustomItems.length, 1);
    assert.equal(doneCustomItems[0].call_id, 'call_fixed');
    assert.equal(doneCustomItems[0].input, '*** Begin Patch\n*** Update File: f.txt\n@@\n x\n+\n*** End Patch');
    const completed = frames.find((frame) => frame.event === 'response.completed').data.response;
    const completedCustomItems = completed.output.filter((item) => item.type === 'custom_tool_call');
    assert.equal(completedCustomItems.length, 1);
    assert.equal(completedCustomItems[0].call_id, 'call_fixed');
    assert.equal(completedCustomItems[0].input.length > 0, true);
    assert.equal(JSON.stringify(frames).includes('call_blank'), false);
    assert.equal(frames.at(-1).data, '[DONE]');
  } finally {
    await close(proxy);
    await close(upstream);
  }
  });

  await scenario('exhausts persistently invalid apply_patch after one streaming correction round regardless of webSearchMaxRounds', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'gateway-patch-flow-'));
  const debugPath = join(tempDir, 'debug.log');
  const { server: upstream, bodies: upstreamBodies } = jsonUpstream(() => toolCallCompletion([
    applyPatchCall('call_stream_always_bad', [{ type: 'replace_text', file: 'a.txt', new: 'x' }]),
  ]));
  const upstreamUrl = await listen(upstream);
  const proxy = createProxyServer({
    config: gatewayConfig(upstreamUrl, {
      webSearchMaxRounds: 0,
      debugPayload: true,
      debugPayloadLogPath: debugPath,
    }),
    reasoningCache: new ReasoningCache(),
  });
  const proxyUrl = await listen(proxy);

  try {
    const response = await fetch(`${proxyUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'codex',
        input: 'edit the file',
        stream: true,
        tools: [applyPatchTool],
      }),
    });
    assert.equal(response.status, 200);
    const frames = parseResponsesSse(await response.text());
    assert.equal(upstreamBodies.length, 3);
    const correctionNotice = upstreamBodies[1].messages.find((message) => message.role === 'tool' && message.tool_call_id === 'call_stream_always_bad');
    assert.match(correctionNotice.content, /apply_patch was not executed\./);
    assert.match(correctionNotice.content, /re-issue all intended tool calls/);
    assert.doesNotMatch(correctionNotice.content, /No correction rounds remain/);
    assert.equal(upstreamBodies[2].messages.some((message) => message.role === 'tool' && /No correction rounds remain/.test(message.content)), true);
    const completed = frames.find((frame) => frame.event === 'response.completed').data.response;
    assert.equal(completed.output.some((item) => item.type === 'custom_tool_call'), false);
    assert.equal(completed.output.some((item) => item.type === 'function_call'), false);
    assert.match(completed.output_text, /Incomplete response/);
    assert.equal(frames.at(-1).data, '[DONE]');
    const log = await readFile(debugPath, 'utf8');
    assert.doesNotMatch(log, /\[codex-deepseek-gateway\] web search usage /);
    const line = log.split(/\r?\n/).find((entry) => entry.startsWith('[codex-deepseek-gateway] apply patch usage '));
    const usage = JSON.parse(line.replace('[codex-deepseek-gateway] apply patch usage ', ''));
    assert.equal(usage.stage, 'apply_patch_stream');
    assert.equal(usage.apply_patch.validationOutcome, 'exhausted');
    assert.equal(usage.apply_patch.correctionRounds, 1);
    assert.deepEqual(usage.apply_patch.errorCategories, ['schema']);
    assert.doesNotMatch(log, /test-key|"new":"x"/);
  } finally {
    await close(proxy);
    await close(upstream);
    await rm(tempDir, { recursive: true, force: true });
  }
  });

});

test('apply_patch structured argument replay restoration', async () => {
  const applyPatchTool = {
    type: 'custom',
    name: 'apply_patch',
    description: 'Edit files.',
    format: { type: 'grammar', syntax: 'lark', definition: 'start: begin_patch hunk+ end_patch' },
  };
  const applyPatchEnvTool = {
    type: 'custom',
    name: 'apply_patch',
    description: 'Edit files.',
    format: {
      type: 'grammar',
      syntax: 'lark',
      definition: [
        'start: begin_patch environment_id? hunk+ end_patch',
        'environment_id: "*** Environment ID: " filename LF',
        'begin_patch: "*** Begin Patch" LF',
        'end_patch: "*** End Patch" LF?',
      ].join('\n'),
    },
  };
  const shellTool = {
    type: 'function',
    name: 'shell_command',
    description: 'Run a shell command.',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
      additionalProperties: false,
    },
  };
  const structuredCall = (id, args) => ({
    id,
    type: 'function',
    function: { name: 'apply_patch', arguments: JSON.stringify(args) },
  });
  const toolCallCompletion = (toolCalls) => JSON.stringify({
    choices: [{ message: { role: 'assistant', content: '', tool_calls: toolCalls }, finish_reason: 'tool_calls' }],
  });
  const textCompletion = (text) => JSON.stringify({
    choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
  });
  const jsonUpstream = (handler) => {
    const bodies = [];
    const server = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      bodies.push(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(handler(body, bodies.length));
    });
    return { server, bodies };
  };
  const gatewayConfig = (upstreamUrl, overrides = {}) => ({
    upstreamBaseUrl: upstreamUrl,
    upstreamApiKey: 'test-key',
    upstreamModel: 'deepseek-v4-flash',
    upstreamProvider: 'deepseek',
    upstreamTimeoutMs: 5000,
    ...overrides,
  });
  const replayInput = (item) => [
    JSON.parse(JSON.stringify(item)),
    { type: 'custom_tool_call_output', call_id: item.call_id, output: 'applied' },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'continue' }] },
  ];
  const failedReplayInput = (item) => [
    JSON.parse(JSON.stringify(item)),
    {
      type: 'custom_tool_call_output',
      call_id: item.call_id,
      output: 'apply_patch verification failed: Failed to find expected lines in a.txt:\n# Title',
    },
  ];
  const assistantApplyPatchCall = (body) => {
    const message = (body.messages || []).find((entry) => entry.role === 'assistant' && Array.isArray(entry.tool_calls));
    return message?.tool_calls?.find((toolCall) => toolCall.function?.name === 'apply_patch');
  };

  await scenario('restores structured edits with an environment id after a real non-streaming replay round-trip', async () => {
  const edits = [{ type: 'add_file', file: 'env.md', content: 'ok' }];
  const { server: upstream, bodies } = jsonUpstream((body) => (
    assistantApplyPatchCall(body)
      ? textCompletion('done')
      : toolCallCompletion([structuredCall('call_env_replay', { environment_id: 'workspace', edits })])
  ));
  const upstreamUrl = await listen(upstream);
  const proxy = createProxyServer({ config: gatewayConfig(upstreamUrl), reasoningCache: new ReasoningCache() });
  const proxyUrl = await listen(proxy);

  try {
    const first = await fetch(`${proxyUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'codex', input: 'edit the file', tools: [applyPatchEnvTool] }),
    });
    assert.equal(first.status, 200);
    const firstBody = await first.json();
    const item = firstBody.output.find((entry) => entry.type === 'custom_tool_call');
    assert.ok(item);
    assert.equal(item.arguments, undefined);
    assert.match(item.input, /\*\*\* Environment ID: workspace/);

    const second = await fetch(`${proxyUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'codex', input: replayInput(item), tools: [applyPatchEnvTool] }),
    });
    assert.equal(second.status, 200);
    assert.equal(bodies.length, 2);
    const restored = assistantApplyPatchCall(bodies[1]);
    assert.ok(restored);
    const restoredArgs = JSON.parse(restored.function.arguments);
    assert.deepEqual(restoredArgs.edits, edits);
    assert.equal(restoredArgs.environment_id, 'workspace');
    assert.equal(restoredArgs.input, undefined);
  } finally {
    await close(proxy);
    await close(upstream);
  }
  });

  await scenario('restores structured edits after a real streaming replay round-trip', async () => {
  const edits = [{ type: 'replace_text', file: 'a.txt', old: 'old', new: 'new' }];
  const { server: upstream, bodies } = jsonUpstream((body) => (
    assistantApplyPatchCall(body)
      ? textCompletion('done')
      : toolCallCompletion([structuredCall('call_stream_replay', { edits })])
  ));
  const upstreamUrl = await listen(upstream);
  const proxy = createProxyServer({ config: gatewayConfig(upstreamUrl), reasoningCache: new ReasoningCache() });
  const proxyUrl = await listen(proxy);

  try {
    const first = await fetch(`${proxyUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'codex', input: 'edit the file', stream: true, tools: [applyPatchTool] }),
    });
    assert.equal(first.status, 200);
    const frames = parseResponsesSse(await first.text());
    const completed = frames.find((frame) => frame.event === 'response.completed').data.response;
    const item = completed.output.find((entry) => entry.type === 'custom_tool_call');
    assert.ok(item);
    assert.equal(item.arguments, undefined);
    assert.equal(item.input, '*** Begin Patch\n*** Update File: a.txt\n@@\n-old\n+new\n*** End Patch');

    const second = await fetch(`${proxyUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'codex', input: replayInput(item), tools: [applyPatchTool] }),
    });
    assert.equal(second.status, 200);
    assert.equal(bodies.length, 2);
    const restored = assistantApplyPatchCall(bodies[1]);
    assert.ok(restored);
    const restoredArgs = JSON.parse(restored.function.arguments);
    assert.deepEqual(restoredArgs.edits, edits);
    assert.equal(restoredArgs.environment_id, undefined);
    assert.equal(restoredArgs.input, undefined);
  } finally {
    await close(proxy);
    await close(upstream);
  }
  });

  await scenario('repairs a replayed native BOM-style patch failure through the real shell compatibility path', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'gateway-bom-debug-'));
  const debugPath = join(tempDir, 'debug.log');
  const filePath = join(tempDir, 'a.txt');
  const edits = [{ type: 'replace_text', file: 'a.txt', old: '# Title', new: '# Updated' }];
  await writeFile(filePath, Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from('# Title\r\n\r\nBody\r\n', 'utf8'),
  ]));
  const { server: upstream, bodies } = jsonUpstream((body) => (
    body.messages.some((message) => message.role === 'tool' && /Applied UTF-8 BOM compatibility patch/.test(String(message.content || '')))
      ? textCompletion('done')
      : toolCallCompletion([structuredCall('call_bom_replay', { edits })])
  ));
  const upstreamUrl = await listen(upstream);
  const proxy = createProxyServer({
    config: gatewayConfig(upstreamUrl, { debugPayload: true, debugPayloadLogPath: debugPath }),
    reasoningCache: new ReasoningCache(),
  });
  const proxyUrl = await listen(proxy);

  try {
    const first = await fetch(`${proxyUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'codex', input: 'edit the file', tools: [applyPatchTool, shellTool] }),
    });
    assert.equal(first.status, 200);
    const item = (await first.json()).output.find((entry) => entry.type === 'custom_tool_call');
    assert.ok(item);

    const second = await fetch(`${proxyUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'codex', input: failedReplayInput(item), tools: [applyPatchTool, shellTool] }),
    });
    assert.equal(second.status, 200);
    const secondBody = await second.json();
    assert.equal(bodies.length, 1);
    const shell = secondBody.output.find((entry) => entry.type === 'function_call' && entry.name === 'shell_command');
    assert.ok(shell);
    assert.match(shell.call_id, /^call_dsgw_bom_/);
    const args = JSON.parse(shell.arguments);
    assert.match(args.command, /apply-patch-bom\.js/);
    assert.doesNotMatch(args.command, /# Title|# Updated/);
    const invocation = process.platform === 'win32'
      ? ['powershell.exe', ['-NoProfile', '-Command', args.command]]
      : ['/bin/sh', ['-c', args.command]];
    const executed = spawnSync(invocation[0], invocation[1], { cwd: tempDir, encoding: 'utf8' });
    assert.equal(executed.status, 0, executed.stderr);
    const file = await readFile(filePath);
    assert.deepEqual(file.subarray(0, 3), Buffer.from([0xef, 0xbb, 0xbf]));
    assert.equal(file.subarray(3).toString('utf8'), '# Updated\r\n\r\nBody\r\n');
    const compatibilityOutput = `Exit code: ${executed.status}\nOutput:\n${executed.stdout}${executed.stderr}`;

    const third = await fetch(`${proxyUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'codex',
        input: [
          item,
          failedReplayInput(item)[1],
          shell,
          {
            type: 'function_call_output',
            call_id: shell.call_id,
            output: compatibilityOutput,
          },
        ],
        tools: [applyPatchTool, shellTool],
      }),
    });
    assert.equal(third.status, 200);
    const thirdBody = await third.json();
    assert.match(thirdBody.output.find((entry) => entry.type === 'message').content[0].text, /done/);
    assert.equal(bodies.length, 2);
    const log = await readFile(debugPath, 'utf8');
    const attempted = log.split(/\r?\n/).find((entry) => entry.startsWith('[codex-deepseek-gateway] apply patch compatibility '));
    const completed = log.split(/\r?\n/).find((entry) => entry.startsWith('[codex-deepseek-gateway] apply patch compatibility result '));
    assert.ok(attempted);
    assert.ok(completed);
    const diagnostic = JSON.parse(completed.replace('[codex-deepseek-gateway] apply patch compatibility result ', ''));
    assert.equal(diagnostic.compatibility_call_id, shell.call_id);
    assert.equal(diagnostic.outcome, 'applied');
    assert.equal(diagnostic.applied, true);
    assert.doesNotMatch(log, /# Title|# Updated/);
  } finally {
    await close(proxy);
    await close(upstream);
    await rm(tempDir, { recursive: true, force: true });
  }
  });

  await scenario('leaves the degenerate input wrapper when the reasoning cache misses the call', async () => {
  const edits = [{ type: 'replace_text', file: 'a.txt', old: 'old', new: 'new' }];
  const { server: upstream, bodies } = jsonUpstream((body) => (
    assistantApplyPatchCall(body)
      ? textCompletion('done')
      : toolCallCompletion([structuredCall('call_miss', { edits })])
  ));
  const upstreamUrl = await listen(upstream);
  const warmProxy = createProxyServer({ config: gatewayConfig(upstreamUrl), reasoningCache: new ReasoningCache() });
  const freshProxy = createProxyServer({ config: gatewayConfig(upstreamUrl), reasoningCache: new ReasoningCache() });
  const warmProxyUrl = await listen(warmProxy);
  const freshProxyUrl = await listen(freshProxy);

  try {
    const first = await fetch(`${warmProxyUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'codex', input: 'edit the file', tools: [applyPatchTool] }),
    });
    assert.equal(first.status, 200);
    const item = (await first.json()).output.find((entry) => entry.type === 'custom_tool_call');
    assert.ok(item);

    const second = await fetch(`${freshProxyUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'codex', input: replayInput(item), tools: [applyPatchTool] }),
    });
    assert.equal(second.status, 200);
    assert.equal(bodies.length, 2);
    const unrestored = assistantApplyPatchCall(bodies[1]);
    assert.ok(unrestored);
    const unrestoredArgs = JSON.parse(unrestored.function.arguments);
    assert.equal(unrestoredArgs.input, item.input);
    assert.equal(Array.isArray(unrestoredArgs.edits), false);
  } finally {
    await close(warmProxy);
    await close(freshProxy);
    await close(upstream);
  }
  });
});

test('streaming Responses lifecycle and terminal behavior', async () => {
  await scenario('returns upstream stream errors before opening Responses SSE', async () => {
  const upstream = http.createServer(async (_req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'bad key' } }));
  });
  const upstreamUrl = await listen(upstream);

  const proxy = createProxyServer({
    config: {
      serverName: 'test',
      upstreamBaseUrl: upstreamUrl,
      upstreamApiKey: 'test-key',
      upstreamProvider: 'deepseek',
      upstreamTimeoutMs: 5000,
    },
    reasoningCache: new ReasoningCache(),
  });
  const proxyUrl = await listen(proxy);

  try {
    const response = await fetch(`${proxyUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-v4-flash', input: 'ping', stream: true }),
    });
    assert.equal(response.status, 401);
    assert.match(response.headers.get('content-type') || '', /application\/json/);
    const body = await response.json();
    assert.equal(body.error.message, 'bad key');
  } finally {
    await close(proxy);
    await close(upstream);
  }
  });
  await scenario('converts streaming chat completion chunks to Responses SSE events', async () => {
  const upstream = http.createServer(async (_req, res) => {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
    });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'po' }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ng' }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({
      choices: [{ delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });
  const upstreamUrl = await listen(upstream);

  const proxy = createProxyServer({
    config: {
      serverName: 'test',
      upstreamBaseUrl: upstreamUrl,
      upstreamApiKey: 'test-key',
      upstreamModel: 'deepseek-v4-flash',
      upstreamProvider: 'deepseek',
      upstreamTimeoutMs: 5000,
    },
    reasoningCache: new ReasoningCache(),
  });
  const proxyUrl = await listen(proxy);

  try {
    const response = await fetch(`${proxyUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'codex', input: 'ping', stream: true }),
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    const frames = parseResponsesSse(text);
    assert.equal(frames[0].event, 'response.created');
    assert.deepEqual(
      frames.filter((frame) => frame.event === 'response.output_text.delta').map((frame) => frame.data.delta),
      ['po', 'ng'],
    );
    const completed = frames.find((frame) => frame.event === 'response.completed');
    assert.equal(completed.data.response.output_text, 'pong');
    assert.deepEqual(completed.data.response.usage, {
      input_tokens: 2,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 1,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 3,
    });
    assert.equal(frames.at(-1).data, '[DONE]');
  } finally {
    await close(proxy);
    await close(upstream);
  }
  });
  await scenario('emits complete reasoning summary before visible output when thinking is enabled', async () => {
  const upstream = http.createServer(async (_req, res) => {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
    });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'think first. ' }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'think second.' }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'answer' }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });
  const upstreamUrl = await listen(upstream);

  const proxy = createProxyServer({
    config: {
      serverName: 'test',
      upstreamBaseUrl: upstreamUrl,
      upstreamApiKey: 'test-key',
      upstreamModel: 'deepseek-v4-pro',
      upstreamProvider: 'deepseek',
      upstreamTimeoutMs: 5000,
      codexReasoningEffort: 'max',
    },
    reasoningCache: new ReasoningCache(),
  });
  const proxyUrl = await listen(proxy);

  try {
    const response = await fetch(`${proxyUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-v4-pro', input: 'ping', reasoning: { effort: 'max' }, stream: true }),
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    const frames = parseResponsesSse(text);
    const summaryDeltaFrames = frames.filter((frame) => frame.event === 'response.reasoning_summary_text.delta');
    const summaryDeltaIndex = frames.findIndex((frame) => frame.event === 'response.reasoning_summary_text.delta');
    const outputTextDeltaIndex = frames.findIndex((frame) => frame.event === 'response.output_text.delta');
    assert.equal(frames.some((frame) => frame.event === 'response.reasoning_summary_part.added'), true);
    assert.equal(summaryDeltaFrames.length, 1);
    assert.equal(summaryDeltaFrames[0].data.delta, '**Reasoning**\n\nthink first. think second.');
    assert.ok(summaryDeltaIndex !== -1 && outputTextDeltaIndex !== -1);
    assert.ok(summaryDeltaIndex < outputTextDeltaIndex);
    assert.deepEqual(
      frames.filter((frame) => frame.event === 'response.output_text.delta').map((frame) => frame.data.delta),
      ['answer'],
    );
    assert.equal(frames.find((frame) => frame.event === 'response.completed').data.response.output_text, 'answer');
  } finally {
    await close(proxy);
    await close(upstream);
  }
  });
  await scenario('starts streamed assistant text as commentary when DeepSeek tools may still arrive', async () => {
  const upstream = http.createServer(async (_req, res) => {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
    });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'I will inspect available tools first.' }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call_search',
                type: 'function',
                function: { name: 'tool_search', arguments: '{"query":"multi_tool_use.parallel"}' },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });
  const upstreamUrl = await listen(upstream);

  const proxy = createProxyServer({
    config: {
      serverName: 'test',
      upstreamBaseUrl: upstreamUrl,
      upstreamApiKey: 'test-key',
      upstreamModel: 'deepseek-v4-flash',
      upstreamProvider: 'deepseek',
      upstreamTimeoutMs: 5000,
    },
    reasoningCache: new ReasoningCache(),
  });
  const proxyUrl = await listen(proxy);

  try {
    const response = await fetch(`${proxyUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-v4-flash',
        input: 'list current tools',
        stream: true,
        tools: [
          {
            type: 'tool_search',
            execution: 'client',
            parameters: {
              type: 'object',
              properties: { query: { type: 'string' } },
              required: ['query'],
            },
          },
        ],
      }),
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    const frames = parseResponsesSse(text);
    const messageAddedIndex = frames.findIndex(
      (frame) => frame.event === 'response.output_item.added' && frame.data.item.type === 'message',
    );
    const textDeltaIndex = frames.findIndex((frame) => frame.event === 'response.output_text.delta');
    const messageAdded = frames[messageAddedIndex].data.item;
    assert.equal(messageAdded.phase, 'commentary');
    assert.ok(textDeltaIndex === -1 || messageAddedIndex < textDeltaIndex);
    assert.equal(
      frames.some((frame) => frame.event === 'response.output_item.done' && frame.data.item.type === 'tool_search_call'),
      true,
    );
    const completed = frames.find((frame) => frame.event === 'response.completed');
    assert.equal(completed.data.response.output_text, '');
    assert.equal(
      completed.data.response.output.some((item) => item.type === 'message' && item.phase === 'final_answer'),
      false,
    );
  } finally {
    await close(proxy);
    await close(upstream);
  }
  });
  await scenario('promotes streamed assistant text to final answer when DeepSeek does not call a tool', async () => {
  const upstream = http.createServer(async (_req, res) => {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
    });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'direct answer' }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });
  const upstreamUrl = await listen(upstream);

  const proxy = createProxyServer({
    config: {
      serverName: 'test',
      upstreamBaseUrl: upstreamUrl,
      upstreamApiKey: 'test-key',
      upstreamModel: 'deepseek-v4-flash',
      upstreamProvider: 'deepseek',
      upstreamTimeoutMs: 5000,
    },
    reasoningCache: new ReasoningCache(),
  });
  const proxyUrl = await listen(proxy);

  try {
    const response = await fetch(`${proxyUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-v4-flash',
        input: 'answer directly',
        stream: true,
        tools: [
          {
            type: 'function',
            name: 'lookup',
            parameters: {
              type: 'object',
              properties: { query: { type: 'string' } },
              required: ['query'],
            },
          },
        ],
      }),
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    const frames = parseResponsesSse(text);
    const messageAdded = frames.find(
      (frame) => frame.event === 'response.output_item.added' && frame.data.item.type === 'message',
    );
    const messageDone = frames.find(
      (frame) => frame.event === 'response.output_item.done' && frame.data.item.type === 'message',
    );
    assert.equal(messageAdded.data.item.phase, 'commentary');
    assert.deepEqual(
      frames.filter((frame) => frame.event === 'response.output_text.delta').map((frame) => frame.data.delta),
      ['direct answer'],
    );
    assert.equal(messageDone.data.item.phase, 'final_answer');
    assert.equal(frames.find((frame) => frame.event === 'response.completed').data.response.output_text, 'direct answer');
  } finally {
    await close(proxy);
    await close(upstream);
  }
  });
  await scenario('reports response.failed when the upstream stream ends without finish_reason', async () => {
  const upstream = http.createServer(async (_req, res) => {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
    });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'partial' }, finish_reason: null }] })}\n\n`);
    res.end();
  });
  const upstreamUrl = await listen(upstream);
  const proxy = createProxyServer({
    config: {
      serverName: 'test',
      upstreamBaseUrl: upstreamUrl,
      upstreamApiKey: 'test-key',
      upstreamModel: 'deepseek-v4-flash',
      upstreamProvider: 'deepseek',
      upstreamTimeoutMs: 5000,
    },
    reasoningCache: new ReasoningCache(),
  });
  const proxyUrl = await listen(proxy);

  try {
    const response = await fetch(`${proxyUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-v4-flash', input: 'hello', stream: true }),
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    const frames = parseResponsesSse(text);
    const failed = frames.find((frame) => frame.event === 'response.failed');
    assert.ok(failed);
    assert.equal(frames.some((frame) => frame.event === 'response.completed'), false);
    assert.match(failed.data.response.error.message, /ended before completion/);
  } finally {
    await close(proxy);
    await close(upstream);
  }
  });
  await scenario('emits heartbeat in_progress events while the upstream stream stays silent', async () => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(': keep-alive\n\n');
  });
  const upstreamUrl = await listen(upstream);
  const proxy = createProxyServer({
    config: {
      upstreamBaseUrl: upstreamUrl,
      upstreamApiKey: 'test-key',
      upstreamModel: 'deepseek-v4-flash',
      upstreamProvider: 'deepseek',
      upstreamTimeoutMs: 5000,
      streamHeartbeatMs: 30,
    },
    reasoningCache: new ReasoningCache(),
  });
  const proxyUrl = await listen(proxy);
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 3000);

  try {
    const response = await fetch(`${proxyUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'codex', input: 'hello', stream: true }),
      signal: controller.signal,
    });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    let text = '';
    while ((text.match(/event: response\.in_progress/g) || []).length < 3) {
      const { value, done } = await reader.read();
      if (done) break;
      text += Buffer.from(value).toString('utf8');
    }
    assert.ok((text.match(/event: response\.in_progress/g) || []).length >= 3);
    assert.match(text, /event: response\.created/);
    assert.doesNotMatch(text, /event: response\.completed/);
  } finally {
    clearTimeout(deadline);
    controller.abort();
    await close(proxy);
    await close(upstream);
  }
  });
});

test('client disconnect propagation', async () => {
  await scenario('aborts the upstream request when the streaming client disconnects', async () => {
  let upstreamRequests = 0;
  let upstreamClosed;
  const upstreamClosedPromise = new Promise((resolve) => {
    upstreamClosed = resolve;
  });
  const upstream = http.createServer(async (req, res) => {
    upstreamRequests += 1;
    for await (const chunk of req) void chunk;
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'partial' }, finish_reason: null }] })}\n\n`);
    res.on('close', upstreamClosed);
  });
  const upstreamUrl = await listen(upstream);
  const proxy = createProxyServer({
    config: {
      upstreamBaseUrl: upstreamUrl,
      upstreamApiKey: 'test-key',
      upstreamModel: 'deepseek-v4-flash',
      upstreamProvider: 'deepseek',
      upstreamTimeoutMs: 5000,
    },
    reasoningCache: new ReasoningCache(),
  });
  const proxyUrl = await listen(proxy);

  try {
    const clientResponse = await new Promise((resolve, reject) => {
      const clientRequest = http.request(`${proxyUrl}/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      }, resolve);
      clientRequest.on('error', reject);
      clientRequest.end(JSON.stringify({ model: 'deepseek-v4-flash', input: 'hello', stream: true }));
    });
    await new Promise((resolve) => {
      clientResponse.once('data', resolve);
    });
    clientResponse.destroy();
    await Promise.race([
      upstreamClosedPromise,
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error('upstream connection was not aborted')), 3000).unref();
      }),
    ]);
    assert.equal(upstreamRequests, 1);
    const health = await fetch(`${proxyUrl}/health`);
    assert.equal(health.status, 200);
  } finally {
    proxy.closeAllConnections();
    upstream.closeAllConnections();
    await close(proxy);
    await close(upstream);
  }
  });
  await scenario('stops the web-search loop without further rounds when the client disconnects', async () => {
  let upstreamRequests = 0;
  let upstreamClosed;
  const upstreamClosedPromise = new Promise((resolve) => {
    upstreamClosed = resolve;
  });
  const upstream = http.createServer(async (req, res) => {
    upstreamRequests += 1;
    for await (const chunk of req) void chunk;
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
    res.write(`data: ${JSON.stringify({
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            id: 'call_note',
            type: 'function',
            function: { name: 'commentary', arguments: '{"text":"Working on it."}' },
          }],
        },
        finish_reason: null,
      }],
    })}\n\n`);
    res.on('close', upstreamClosed);
  });
  const upstreamUrl = await listen(upstream);
  const proxy = createProxyServer({
    config: {
      upstreamBaseUrl: upstreamUrl,
      upstreamApiKey: 'test-key',
      upstreamModel: 'deepseek-v4-flash',
      upstreamProvider: 'deepseek',
      upstreamTimeoutMs: 5000,
      tavilyApiKey: 'tvly-test',
      tavilyBaseUrl: 'http://127.0.0.1:9',
      tavilyWebSearchEnabled: true,
      tavilyTimeoutMs: 1000,
    },
    reasoningCache: new ReasoningCache(),
  });
  const proxyUrl = await listen(proxy);

  try {
    const clientResponse = await new Promise((resolve, reject) => {
      const clientRequest = http.request(`${proxyUrl}/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      }, resolve);
      clientRequest.on('error', reject);
      clientRequest.end(JSON.stringify({
        model: 'codex',
        input: 'do the work',
        stream: true,
        store: false,
        tools: [
          { type: 'web_search_preview' },
          { type: 'function', name: 'shell_command', parameters: { type: 'object', properties: {} } },
        ],
      }));
    });
    await new Promise((resolve) => {
      clientResponse.once('data', resolve);
    });
    clientResponse.destroy();
    await Promise.race([
      upstreamClosedPromise,
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error('upstream connection was not aborted')), 3000).unref();
      }),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(upstreamRequests, 1);
    const health = await fetch(`${proxyUrl}/health`);
    assert.equal(health.status, 200);
  } finally {
    proxy.closeAllConnections();
    upstream.closeAllConnections();
    await close(proxy);
    await close(upstream);
  }
  });
});
