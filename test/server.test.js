import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createProxyServer } from '../src/server.js';
import { SessionStore } from '../src/session-store.js';
import { DEFAULT_MODEL_ALIASES } from '../src/model-map.js';

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

test('exposes configured model aliases on /v1/models', async () => {
  const proxy = createProxyServer({
    config: {
      serverName: 'test',
      upstreamProvider: 'deepseek',
      modelAliases: DEFAULT_MODEL_ALIASES,
    },
    sessions: new SessionStore(),
  });
  const proxyUrl = await listen(proxy);

  try {
    const response = await fetch(`${proxyUrl}/v1/models`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.object, 'list');
    assert.equal(body.data.some((model) => model.id === 'deepseek-v4-flash'), true);
    assert.equal(body.data.some((model) => model.id === 'deepseek-v4-pro'), true);
    assert.equal(body.data.some((model) => model.id === legacyChatModel), false);
  } finally {
    await close(proxy);
  }
});

test('returns minimal health payload', async () => {
  const proxy = createProxyServer({
    config: {
      serverName: 'test',
      upstreamProvider: 'deepseek',
      modelAliases: DEFAULT_MODEL_ALIASES,
    },
    sessions: new SessionStore(),
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

test('merges upstream models and filters deprecated DeepSeek model names', async () => {
  const upstream = http.createServer(async (_req, res) => {
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
    sessions: new SessionStore(),
  });
  const proxyUrl = await listen(proxy);

  try {
    const response = await fetch(`${proxyUrl}/v1/models`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.data.some((model) => model.id === 'deepseek-v4-vision'), true);
    assert.equal(body.data.some((model) => model.id === legacyChatModel), false);
    assert.equal(body.data.some((model) => model.id === legacyReasoningModel), false);
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('requires configured proxy API key for v1 routes', async () => {
  const proxy = createProxyServer({
    config: {
      serverName: 'test',
      proxyApiKey: 'local-key',
      modelAliases: DEFAULT_MODEL_ALIASES,
    },
    sessions: new SessionStore(),
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

test('proxies non-streaming Responses request to chat completions upstream', async () => {
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
    sessions: new SessionStore(),
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

test('keeps full previous_response_id history across multiple follow-ups', async () => {
  const upstreamBodies = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    upstreamBodies.push(body);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: `chatcmpl_${upstreamBodies.length}`,
      object: 'chat.completion',
      created: 123 + upstreamBodies.length,
      model: body.model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: `answer ${upstreamBodies.length}` },
          finish_reason: 'stop',
        },
      ],
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
    sessions: new SessionStore(),
  });
  const proxyUrl = await listen(proxy);

  try {
    const first = await fetch(`${proxyUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'codex', input: 'first user' }),
    });
    const firstBody = await first.json();
    const second = await fetch(`${proxyUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'codex', previous_response_id: firstBody.id, input: 'second user' }),
    });
    const secondBody = await second.json();
    const third = await fetch(`${proxyUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'codex', previous_response_id: secondBody.id, input: 'third user' }),
    });
    assert.equal(third.status, 200);
    await third.json();

    assert.deepEqual(upstreamBodies[2].messages.map((message) => message.content), [
      'first user',
      'answer 1',
      'second user',
      'answer 2',
      'third user',
    ]);
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('resumes previous_response_id and conversation history after gateway restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gateway-server-sessions-'));
  const persistPath = join(dir, 'sessions.json');
  const upstreamBodies = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    upstreamBodies.push(body);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: `chatcmpl_restart_${upstreamBodies.length}`,
      object: 'chat.completion',
      created: 123 + upstreamBodies.length,
      model: body.model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: `restart answer ${upstreamBodies.length}` },
          finish_reason: 'stop',
        },
      ],
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
    sessionStoreEnabled: true,
    sessionStorePath: persistPath,
    sessionStoreMaxSessions: 10,
  };

  let proxy = null;
  try {
    proxy = createProxyServer({ config });
    let proxyUrl = await listen(proxy);
    const first = await fetch(`${proxyUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'codex', conversation: 'conv_restart', input: 'first user' }),
    });
    assert.equal(first.status, 200);
    const firstBody = await first.json();
    await close(proxy);
    proxy = null;

    proxy = createProxyServer({ config });
    proxyUrl = await listen(proxy);
    const second = await fetch(`${proxyUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'codex',
        conversation: 'conv_restart',
        previous_response_id: firstBody.id,
        input: 'second user',
      }),
    });
    assert.equal(second.status, 200);
    await second.json();
    await close(proxy);
    proxy = null;

    proxy = createProxyServer({ config });
    proxyUrl = await listen(proxy);
    const third = await fetch(`${proxyUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'codex', conversation: 'conv_restart', input: 'third user' }),
    });
    assert.equal(third.status, 200);
    await third.json();

    assert.deepEqual(upstreamBodies[1].messages.map((message) => message.content), [
      'first user',
      'restart answer 1',
      'second user',
    ]);
    assert.deepEqual(upstreamBodies[2].messages.map((message) => message.content), [
      'first user',
      'restart answer 1',
      'second user',
      'restart answer 2',
      'third user',
    ]);
  } finally {
    if (proxy) await close(proxy);
    await close(upstream);
    await rm(dir, { recursive: true, force: true });
  }
});

test('store:false persists only the tool-call cache and still restores reasoning after restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gateway-server-store-false-'));
  const persistPath = join(dir, 'sessions.json');
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
    sessionStoreEnabled: true,
    sessionStorePath: persistPath,
    sessionStoreMaxSessions: 10,
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

    const persisted = JSON.parse(await readFile(persistPath, 'utf8'));
    assert.deepEqual(persisted.sessions, []);
    assert.deepEqual(persisted.conversations, []);
    assert.equal(persisted.toolCallMessages.length, 1);
    assert.equal(persisted.assistantMessages.length, 1);
    assert.equal(persisted.assistantMessages[persisted.toolCallMessages[0][1]].reasoning_content, 'store-false thinking');

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
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'first user' }] },
          { type: 'function_call', call_id: 'call_store_1', name: 'lookup', arguments: '{"query":"codex"}' },
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

    const persistedAfter = JSON.parse(await readFile(persistPath, 'utf8'));
    assert.deepEqual(persistedAfter.sessions, []);
    assert.equal(persistedAfter.toolCallMessages.length, 1);
  } finally {
    if (proxy) await close(proxy);
    await close(upstream);
    await rm(dir, { recursive: true, force: true });
  }
});

test('emulates Codex web_search with Tavily for non-streaming Responses requests', async () => {
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
                    name: 'tavily_search',
                    arguments: '{"query":"Codex web search Tavily","max_results":3}',
                  },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
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
      usage: { prompt_tokens: 20, completion_tokens: 7, total_tokens: 27 },
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
      tavilyMaxSearchRounds: 2,
      tavilyMaxResults: 5,
      tavilySearchDepth: 'basic',
    },
    sessions: new SessionStore(),
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
    assert.equal(body.usage.output_tokens, 10);
    assert.equal(body.usage.total_tokens, 30);
    assert.equal(upstreamBodies.length, 2);
    assert.equal(upstreamBodies[0].tools.some((tool) => tool.function?.name === 'tavily_search'), true);
    assert.equal(upstreamBodies[0].stream, false);
    assert.equal(upstreamBodies[1].messages.at(-1).role, 'tool');
    assert.match(upstreamBodies[1].messages.at(-1).content, /Search query: Codex web search Tavily/);
    assert.match(upstreamBodies[1].messages.at(-1).content, /Source 1: Tavily Search API/);
    assert.match(upstreamBodies[1].messages.at(-1).content, /source title and URL/);
    assert.doesNotMatch(upstreamBodies[1].messages.at(-1).content, /cite them as \[1\].*Do not write Markdown links or raw source URLs/);
    assert.doesNotMatch(upstreamBodies[1].messages.at(-1).content, /RAW CONTENT SHOULD NOT REACH MODEL|raw_content/);
  } finally {
    await close(proxy);
    await close(upstream);
    await close(tavily);
  }
});

test('emulates Codex web_search with progressive Responses SSE when client requests stream', async () => {
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
                  function: { name: 'tavily_search', arguments: '{"query":"live result"}' },
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
    sessions: new SessionStore(),
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
    assert.match(text, /event: response\.completed/);
    assert.match(text, /"type":"web_search_call"/);
    assert.match(text, /"status":"completed"/);
    assert.doesNotMatch(text, /"sources":/);
    assert.match(text, /event: response\.reasoning_summary_part\.added/);
    assert.match(text, /event: response\.reasoning_summary_text\.delta/);
    assert.match(text, /Checked the search result before answering\./);
    assert.ok(text.indexOf('event: response.reasoning_summary_text.delta') < text.indexOf('event: response.output_text.delta'));
    assert.doesNotMatch(text, /event: response\.output_text\.annotation\.added/);
    assert.match(text, /"type":"url_citation"/);
    assert.match(text, /"url":"https:\/\/example\.com\/source"/);
    assert.match(text, /"text":"Answer \[1\]\."/);
    assert.match(text, /data: \[DONE\]/);
  } finally {
    await close(proxy);
    await close(upstream);
    await close(tavily);
  }
});

test('streams reasoning live across web-search rounds and merges usage', async () => {
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
  const sessions = new SessionStore();
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
    sessions,
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
    assert.match(earlyText, /event: response\.reasoning_summary_text\.delta/);
    assert.match(earlyText, /Need fresh data\./);
    let text = earlyText;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      text += Buffer.from(value).toString('utf8');
    }
    const reasoningAdded = [...text.matchAll(/"type":"response\.output_item\.added".*"type":"reasoning"/g)];
    assert.equal(reasoningAdded.length, 2);
    assert.match(text, /Results are in\./);
    assert.match(text, /"text":"Fresh answer\."/);
    assert.doesNotMatch(text, /"type":"function_call"/);
    assert.doesNotMatch(text, /tavily_search/);
    const completedMatches = [...text.matchAll(/event: response\.completed\r?\ndata: ([^\n]+)/g)];
    assert.equal(completedMatches.length, 1);
    const completed = JSON.parse(completedMatches[0][1]);
    assert.equal(completed.response.usage.output_tokens, 12);
    assert.equal(completed.response.usage.input_tokens, 60);
    assert.match(text, /data: \[DONE\]/);

    const session = sessions.get(completed.response.id);
    const assistantWithTools = session.messages.find((message) => message.role === 'assistant' && Array.isArray(message.tool_calls));
    assert.equal(assistantWithTools.tool_calls[0].function.name, 'tavily_search');
    assert.equal(assistantWithTools.reasoning_content, 'Need fresh data.');
    const toolMessage = session.messages.find((message) => message.role === 'tool');
    assert.equal(toolMessage.tool_call_id, 'call_search');
    const finalAssistant = session.messages.at(-1);
    assert.equal(finalAssistant.content, 'Fresh answer.');
    assert.equal(finalAssistant.reasoning_content, 'Results are in.');
  } finally {
    await close(proxy);
    await close(upstream);
    await close(tavily);
  }
});

test('replaces pseudo tool-call text with the gateway incomplete answer in the streamed final round', async () => {
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
      tavilyMaxSearchRounds: 0,
    },
    sessions: new SessionStore(),
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
    assert.match(text, /event: response\.completed/);
    assert.match(text, /Gateway incomplete: after web tools were disabled/);
    assert.doesNotMatch(text, /"type":"function_call"/);
    assert.doesNotMatch(text, /"type":"web_search_call"/);
    assert.doesNotMatch(text, /DSML tool_calls/);
    assert.match(text, /data: \[DONE\]/);
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('includes web_search_call sources only when requested', async () => {
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
                  function: { name: 'tavily_search', arguments: '{"query":"include source search"}' },
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
      choices: [{ message: { role: 'assistant', content: 'Included source [1].' }, finish_reason: 'stop' }],
    }));
  });
  const tavily = http.createServer(async (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      results: [{ title: 'Included Source', url: 'https://example.com/include', content: 'Snippet' }],
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
    sessions: new SessionStore(),
  });
  const proxyUrl = await listen(proxy);

  try {
    const response = await fetch(`${proxyUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'codex',
        input: 'Search with sources',
        tools: [{ type: 'web_search' }],
        include: ['web_search_call.action.sources'],
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.output[0].action.sources, [
      { type: 'url', title: 'Included Source', url: 'https://example.com/include' },
    ]);
    assert.deepEqual(body.output[1].content[0].annotations, [
      {
        type: 'url_citation',
        start_index: 16,
        end_index: 19,
        url: 'https://example.com/include',
        title: 'Included Source',
      },
    ]);
  } finally {
    await close(proxy);
    await close(upstream);
    await close(tavily);
  }
});

test('adds Firecrawl opened page excerpts to Tavily-backed web_search', async () => {
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
                  function: { name: 'tavily_search', arguments: '{"query":"firecrawl integration","max_results":1}' },
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
        markdown: '# Firecrawl\n\nOpened page text for DeepSeek.',
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
    sessions: new SessionStore(),
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
    assert.deepEqual(firecrawlBody.formats, ['markdown', 'links']);
    assert.equal(upstreamBodies[0].tools.some((tool) => tool.function?.name === 'firecrawl_open_page'), true);
    const toolContent = upstreamBodies[1].messages.at(-1).content;
    assert.match(toolContent, /Opened page excerpt:/);
    assert.match(toolContent, /Opened page text for DeepSeek/);
    assert.match(toolContent, /Source 1 link 1: Nested Link/);
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

test('lets DeepSeek explicitly open a page through Firecrawl during web_search emulation', async () => {
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
                  id: 'call_open',
                  type: 'function',
                  function: {
                    name: 'firecrawl_open_page',
                    arguments: '{"url":"https://example.com/page","query":"pricing"}',
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
    assert.equal(upstreamBodies[1].messages.at(-1).tool_call_id, 'call_open');
    assert.match(upstreamBodies[1].messages.at(-1).content, /Opened page: https:\/\/example\.com\/page/);
    assert.doesNotMatch(upstreamBodies[1].messages.at(-1).content, /Assigned source number|source number/i);
    res.end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'The page says pricing changed [1].' }, finish_reason: 'stop' }],
    }));
  });
  const firecrawl = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    assert.equal(body.url, 'https://example.com/page');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      data: {
        markdown: 'Pricing changed for the gateway service.',
        metadata: { title: 'Pricing Page', sourceURL: 'https://example.com/page' },
      },
    }));
  });
  const upstreamUrl = await listen(upstream);
  const firecrawlUrl = await listen(firecrawl);
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
      firecrawlApiKey: 'fc-test',
      firecrawlBaseUrl: firecrawlUrl,
      firecrawlWebFetchEnabled: true,
      firecrawlAutoScrapeTopResults: 0,
      firecrawlTimeoutMs: 5000,
    },
    sessions: new SessionStore(),
  });
  const proxyUrl = await listen(proxy);

  try {
    const response = await fetch(`${proxyUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'codex',
        input: 'Open page',
        tools: [{ type: 'web_search' }],
        include: ['web_search_call.action.sources'],
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.output.some((item) => item.type === 'function_call' && item.name === 'firecrawl_open_page'), false);
    assert.equal(body.output[0].type, 'web_search_call');
    assert.equal(body.output[0].action.type, 'open_page');
    assert.equal(body.output[0].action.url, 'https://example.com/page');
    assert.deepEqual(body.output[0].action.sources, [
      { type: 'url', title: 'Pricing Page', url: 'https://example.com/page' },
    ]);
    assert.deepEqual(body.output[1].content[0].annotations, [
      {
        type: 'url_citation',
        start_index: 30,
        end_index: 33,
        url: 'https://example.com/page',
        title: 'Pricing Page',
      },
    ]);
  } finally {
    await close(proxy);
    await close(upstream);
    await close(firecrawl);
  }
});

test('intercepts leaked web_search function calls from DeepSeek', async () => {
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
                  id: 'call_web_search',
                  type: 'function',
                  function: { name: 'web_search', arguments: '{"search":"crude oil price today"}' },
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
      choices: [{ message: { role: 'assistant', content: 'WTI moved today [1].' }, finish_reason: 'stop' }],
    }));
  });
  const tavily = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    assert.equal(body.query, 'crude oil price today');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      results: [{ title: 'Oil price source', url: 'https://example.com/oil', content: 'WTI price update.' }],
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
    sessions: new SessionStore(),
  });
  const proxyUrl = await listen(proxy);

  try {
    const response = await fetch(`${proxyUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'codex',
        input: 'Search oil prices',
        tools: [{ type: 'web_search' }],
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.output[0].type, 'web_search_call');
    assert.equal(body.output[0].action.query, 'crude oil price today');
    assert.equal(body.output.some((item) => item.type === 'function_call' && item.name === 'web_search'), false);
    assert.equal(upstreamBodies.length, 2);
    assert.equal(upstreamBodies[1].messages.at(-1).role, 'tool');
    assert.match(upstreamBodies[1].messages.at(-1).content, /Search query: crude oil price today/);
  } finally {
    await close(proxy);
    await close(upstream);
    await close(tavily);
  }
});

test('keeps Tavily search history valid for previous_response_id follow-ups', async () => {
  const upstreamBodies = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    upstreamBodies.push(body);

    for (const [index, message] of body.messages.entries()) {
      if (message.role !== 'assistant' || !Array.isArray(message.tool_calls) || !message.tool_calls.length) continue;
      const expectedIds = message.tool_calls.map((toolCall) => toolCall.id);
      const following = body.messages.slice(index + 1, index + 1 + expectedIds.length);
      assert.deepEqual(following.map((next) => next.role), expectedIds.map(() => 'tool'));
      assert.deepEqual(following.map((next) => next.tool_call_id), expectedIds);
    }

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
                  function: { name: 'tavily_search', arguments: '{"query":"gold futures price"}' },
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
      choices: [{ message: { role: 'assistant', content: upstreamBodies.length === 2 ? 'Gold moved [1].' : 'Oil moved too.' }, finish_reason: 'stop' }],
    }));
  });
  const tavily = http.createServer(async (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      results: [{ title: 'Gold source', url: 'https://example.com/gold', content: 'Gold price update.' }],
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
    sessions: new SessionStore(),
  });
  const proxyUrl = await listen(proxy);

  try {
    const firstResponse = await fetch(`${proxyUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'codex',
        input: 'Search gold',
        tools: [{ type: 'web_search' }],
      }),
    });
    assert.equal(firstResponse.status, 200);
    const firstBody = await firstResponse.json();
    assert.equal(firstBody.output[0].type, 'web_search_call');

    const secondResponse = await fetch(`${proxyUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'codex',
        input: 'Now discuss oil',
        previous_response_id: firstBody.id,
      }),
    });
    assert.equal(secondResponse.status, 200);
    assert.equal(upstreamBodies.length, 3);
    const secondRequestMessages = upstreamBodies[2].messages;
    const searchAssistantIndex = secondRequestMessages.findIndex((message) => Array.isArray(message.tool_calls));
    assert.notEqual(searchAssistantIndex, -1);
    assert.equal(secondRequestMessages[searchAssistantIndex + 1].role, 'tool');
    assert.equal(secondRequestMessages.at(-1).content, 'Now discuss oil');
  } finally {
    await close(proxy);
    await close(upstream);
    await close(tavily);
  }
});

test('accepts Codex state that replays prior web_search_call items', async () => {
  const upstreamBodies = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    upstreamBodies.push(body);
    assert.equal(body.messages.some((message) => {
      const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      return calls.some((toolCall) => toolCall.function?.name === 'web_search');
    }), false);
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
    sessions: new SessionStore(),
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

test('maps Codex web_search filters to Tavily domains', async () => {
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
                  function: { name: 'tavily_search', arguments: '{"query":"domain filtered search"}' },
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
      choices: [{ message: { role: 'assistant', content: 'Filtered result [1].' }, finish_reason: 'stop' }],
    }));
  });
  const tavily = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    assert.deepEqual(body.include_domains, ['wsj.com']);
    assert.deepEqual(body.exclude_domains, ['example.com']);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      results: [{ title: 'Filtered source', url: 'https://wsj.com/a', content: 'Snippet' }],
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
    sessions: new SessionStore(),
  });
  const proxyUrl = await listen(proxy);

  try {
    const response = await fetch(`${proxyUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'codex',
        input: 'Search',
        tools: [
          {
            type: 'web_search',
            filters: {
              allowed_domains: ['wsj.com'],
              blocked_domains: ['example.com'],
            },
          },
        ],
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.output[0].type, 'web_search_call');
  } finally {
    await close(proxy);
    await close(upstream);
    await close(tavily);
  }
});

test('does not pass forced web_search tool_choice to DeepSeek', async () => {
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
    sessions: new SessionStore(),
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
    assert.equal(upstreamBody.tool_choice, undefined);
    assert.equal(upstreamBody.tools.some((tool) => tool.function?.name === 'tavily_search'), true);
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('does not pass required web_search tool_choice to DeepSeek', async () => {
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
    sessions: new SessionStore(),
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

test('passes through real external tool calls while web search emulation is enabled', async () => {
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
    sessions: new SessionStore(),
  });
  const proxyUrl = await listen(proxy);

  try {
    const response = await fetch(`${proxyUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'codex',
        input: 'Assign this to a sub-agent and use web if needed.',
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
    assert.equal(upstreamBodies[0].tools.some((tool) => tool.function?.name === 'tavily_search'), true);
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
    assert.equal(round.codex_tools.some((tool) => tool.type === 'web_search'), true);
    assert.equal(round.codex_tools.some((tool) => tool.type === 'namespace' && tool.name === 'multi_agent_v1'), true);
    assert.equal(round.chat_tools.some((tool) => tool.name === 'multi_agent_v1__spawn_agent'), true);
    assert.equal(round.upstream_tools.some((tool) => tool.name === 'tavily_search'), true);
    assert.equal(round.upstream_tools.some((tool) => tool.name === 'multi_agent_v1__spawn_agent'), true);
  } finally {
    await close(proxy);
    await close(upstream);
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('does not enable Tavily when Codex allowed_tools excludes web search', async () => {
  let upstreamBody;
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    upstreamBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      choices: [
        {
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'call_lookup',
                type: 'function',
                function: { name: 'lookup', arguments: '{"q":"docs"}' },
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
    },
    sessions: new SessionStore(),
  });
  const proxyUrl = await listen(proxy);

  try {
    const response = await fetch(`${proxyUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'codex',
        input: 'lookup only',
        tools: [
          { type: 'web_search' },
          {
            type: 'function',
            name: 'lookup',
            parameters: {
              type: 'object',
              properties: { q: { type: 'string' } },
              required: ['q'],
              additionalProperties: false,
            },
          },
        ],
        tool_choice: {
          type: 'allowed_tools',
          mode: 'auto',
          tools: [{ type: 'function', name: 'lookup' }],
        },
      }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(upstreamBody.tools.map((tool) => tool.function?.name), ['lookup', 'commentary']);
    assert.equal(upstreamBody.messages[0].content.includes('For live web information, use tavily_search.'), false);
    const body = await response.json();
    const toolCall = body.output.find((item) => item.type === 'function_call');
    assert.equal(toolCall.name, 'lookup');
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('does not leak internal search function calls when search loop reaches max rounds', async () => {
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
      assert.equal(body.messages.some((message) => String(message.content || '').includes('For live web information, use tavily_search.')), false);
      assert.equal(body.messages.at(-1).role, 'user');
      assert.match(body.messages.at(-1).content, /Web tools are not available now/);
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
      tavilyMaxSearchRounds: 1,
    },
    sessions: new SessionStore(),
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

test('completes with a visible gateway explanation when final answer turn writes pseudo tool calls', async () => {
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
      assert.match(body.messages.at(-1).content, /Do not write tool calls/);
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
      tavilyMaxSearchRounds: 1,
    },
    sessions: new SessionStore(),
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
    assert.match(body.output_text, /Gateway incomplete/);
    assert.equal(body.output_text.includes('DSML'), false);
    assert.equal(body.output_text.includes('tavily_search'), false);
  } finally {
    await close(proxy);
    await close(upstream);
    await close(tavily);
  }
});

test('allows model-driven multi-round web search before final answer', async () => {
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
      tavilyMaxSearchRounds: 8,
    },
    sessions: new SessionStore(),
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
    assert.equal(upstreamBodies.at(-1).tools.some((tool) => tool.function?.name === 'tavily_search'), true);
  } finally {
    await close(proxy);
    await close(upstream);
    await close(tavily);
  }
});

test('completes with a visible gateway explanation when final answer turn has no visible content', async () => {
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
      tavilyMaxSearchRounds: 2,
    },
    sessions: new SessionStore(),
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
    assert.match(body.output_text, /Gateway incomplete/);
  } finally {
    await close(proxy);
    await close(upstream);
    await close(tavily);
  }
});

test('recovers from unsupported model tool calls with a final answer turn', async () => {
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
    assert.match(body.messages.at(-2).content, /not available through this gateway/);
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
      tavilyMaxSearchRounds: 2,
    },
    sessions: new SessionStore(),
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

test('returns upstream stream errors before opening Responses SSE', async () => {
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
    sessions: new SessionStore(),
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

test('converts streaming chat completion chunks to Responses SSE events', async () => {
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
    sessions: new SessionStore(),
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
    assert.match(text, /event: response\.created/);
    assert.match(text, /event: response\.output_text\.delta/);
    assert.match(text, /event: response\.completed/);
    assert.match(text, /"text":"pong"/);
    assert.match(text, /"input_tokens"/);
    assert.match(text, /data: \[DONE\]/);
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('emits complete reasoning summary before visible output when thinking is enabled', async () => {
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
      codexReasoningEffort: 'xhigh',
    },
    sessions: new SessionStore(),
  });
  const proxyUrl = await listen(proxy);

  try {
    const response = await fetch(`${proxyUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-v4-pro', input: 'ping', reasoning: { effort: 'xhigh' }, stream: true }),
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    const summaryDeltaMatches = [...text.matchAll(/event: response\.reasoning_summary_text\.delta\r?\ndata: ([^\n]+)/g)];
    const summaryDeltaIndex = text.indexOf('event: response.reasoning_summary_text.delta');
    const outputTextDeltaIndex = text.indexOf('event: response.output_text.delta');
    assert.match(text, /event: response\.reasoning_summary_part\.added/);
    assert.match(text, /event: response\.reasoning_summary_text\.delta/);
    assert.equal(summaryDeltaMatches.length, 1);
    assert.equal(JSON.parse(summaryDeltaMatches[0][1]).delta, '**Reasoning**\n\nthink first. think second.');
    assert.ok(summaryDeltaIndex !== -1 && outputTextDeltaIndex !== -1);
    assert.ok(summaryDeltaIndex < outputTextDeltaIndex);
    assert.match(text, /event: response\.output_text\.delta/);
    assert.match(text, /"text":"answer"/);
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('marks streamed assistant text before tool calls as commentary when thinking is enabled', async () => {
  const upstreamBodies = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    upstreamBodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
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
      upstreamModel: 'deepseek-v4-pro',
      upstreamProvider: 'deepseek',
      upstreamTimeoutMs: 5000,
      codexReasoningEffort: 'high',
    },
    sessions: new SessionStore(),
  });
  const proxyUrl = await listen(proxy);

  try {
    const response = await fetch(`${proxyUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-v4-pro',
        input: 'list current tools',
        stream: true,
        reasoning: { effort: 'high' },
        tools: [
          {
            type: 'tool_search',
            execution: 'client',
            parameters: {
              type: 'object',
              properties: { query: { type: 'string' } },
              required: ['query'],
              additionalProperties: false,
            },
          },
        ],
      }),
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.equal(upstreamBodies[0].tools.some((tool) => tool.function?.name === 'tool_search'), true);
    assert.match(text, /"phase":"commentary"/);
    assert.doesNotMatch(text, /"phase":"final_answer"/);
    assert.match(text, /"type":"tool_search_call"/);
    assert.match(text, /"output_text":""/);
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('starts streamed assistant text as commentary when DeepSeek tools may still arrive', async () => {
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
    sessions: new SessionStore(),
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
    const messageAddedLine = text
      .split(/\r?\n/)
      .find((line, index, lines) => lines[index - 1] === 'event: response.output_item.added' && line.includes('"type":"message"'));
    assert.ok(messageAddedLine);
    assert.match(messageAddedLine, /"phase":"commentary"/);
    assert.doesNotMatch(messageAddedLine, /"phase":"final_answer"/);
    const lines = text.split(/\r?\n/);
    const messageAddedIndex = lines.findIndex((line, index) => lines[index - 1] === 'event: response.output_item.added' && line.includes('"type":"message"'));
    const textDeltaIndex = lines.findIndex((line) => line === 'event: response.output_text.delta');
    assert.ok(textDeltaIndex === -1 || messageAddedIndex < textDeltaIndex);
    assert.match(text, /"type":"tool_search_call"/);
    assert.match(text, /"output_text":""/);
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('promotes streamed assistant text to final answer when DeepSeek does not call a tool', async () => {
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
    sessions: new SessionStore(),
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
    const lines = text.split(/\r?\n/);
    const messageAddedLine = lines
      .find((line, index) => lines[index - 1] === 'event: response.output_item.added' && line.includes('"type":"message"'));
    const messageDoneLine = lines
      .find((line, index) => lines[index - 1] === 'event: response.output_item.done' && line.includes('"type":"message"'));
    const textDeltaLine = lines
      .find((line, index) => lines[index - 1] === 'event: response.output_text.delta' && line.includes('direct answer'));
    assert.ok(messageAddedLine);
    assert.match(messageAddedLine, /"phase":"commentary"/);
    assert.ok(textDeltaLine);
    assert.ok(messageDoneLine);
    assert.match(messageDoneLine, /"phase":"final_answer"/);
    assert.match(text, /"output_text":"direct answer"/);
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('streams thinking-mode final text incrementally through the web-search path', async () => {
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
    sessions: new SessionStore(),
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
        reasoning: { effort: 'medium' },
        tools: [{ type: 'web_search_preview' }],
      }),
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    const lines = text.split(/\r?\n/);
    const textDeltas = lines
      .filter((line, index) => lines[index - 1] === 'event: response.output_text.delta')
      .map((line) => JSON.parse(line.slice('data: '.length)).delta);
    assert.deepEqual(textDeltas, ['Hello ', 'streamed ', 'world.']);
    const summaryDeltaIndex = lines.findIndex((line) => line === 'event: response.reasoning_summary_text.delta');
    const reasoningDoneIndex = lines.findIndex((line, index) => lines[index - 1] === 'event: response.output_item.done' && line.includes('"type":"reasoning"')) ;
    const messageAddedIndex = lines.findIndex((line, index) => lines[index - 1] === 'event: response.output_item.added' && line.includes('"type":"message"'));
    const firstTextDeltaIndex = lines.findIndex((line) => line === 'event: response.output_text.delta');
    assert.ok(summaryDeltaIndex !== -1 && reasoningDoneIndex !== -1 && messageAddedIndex !== -1 && firstTextDeltaIndex !== -1);
    assert.ok(summaryDeltaIndex < reasoningDoneIndex);
    assert.ok(reasoningDoneIndex < messageAddedIndex);
    assert.ok(messageAddedIndex < firstTextDeltaIndex);
    const messageDoneLine = lines
      .find((line, index) => lines[index - 1] === 'event: response.output_item.done' && line.includes('"type":"message"'));
    assert.match(messageDoneLine, /"phase":"final_answer"/);
    assert.match(text, /"output_text":"Hello streamed world."/);
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('expands multi_tool_use.parallel into individual Codex tool calls through the web-search path', async () => {
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
    sessions: new SessionStore(),
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
        reasoning: { effort: 'medium' },
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
    const lines = text.split(/\r?\n/);
    const doneItems = lines
      .filter((line, index) => lines[index - 1] === 'event: response.output_item.done' && line.includes('"type":"function_call"'))
      .map((line) => JSON.parse(line.slice('data: '.length)).item);
    assert.equal(doneItems.length, 2);
    assert.deepEqual(doneItems.map((item) => item.name), ['shell_command', 'shell_command']);
    assert.deepEqual(
      doneItems.map((item) => item.arguments),
      ['{"command":"rg --files src"}', '{"command":"Get-Content package.json"}'],
    );
    assert.notEqual(doneItems[0].call_id, doneItems[1].call_id);
    assert.equal(text.includes('multi_tool_use'), false);
    assert.match(text, /event: response\.reasoning_summary_text\.delta/);
    assert.match(text, /event: response\.completed/);
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('restores DeepSeek reasoning_content when Codex sends only tool output on the next turn', async () => {
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
    sessions: new SessionStore(),
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

test('restores raw DeepSeek reasoning for replayed tool-call turns via session store', async () => {
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
    sessions: new SessionStore(),
  });
  const proxyUrl = await listen(proxy);

  try {
    const tools = [
      { type: 'function', name: 'lookup', parameters: { type: 'object', properties: { q: { type: 'string' } } } },
    ];
    const first = await fetch(`${proxyUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-v4-flash', input: 'find x', tools, reasoning: { effort: 'medium' } }),
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
        reasoning: { effort: 'medium' },
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

test('reports response.failed when the upstream stream ends without finish_reason', async () => {
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
    sessions: new SessionStore(),
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
    assert.match(text, /event: response\.failed/);
    assert.doesNotMatch(text, /event: response\.completed/);
    assert.match(text, /ended before completion/);
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('answers commentary-only rounds internally and streams the update as a commentary message', async () => {
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
    sessions: new SessionStore(),
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

    assert.match(text, /"phase":"commentary"/);
    assert.match(text, /Starting with the config file\./);
    assert.doesNotMatch(text, /"name":"commentary"/);
    assert.match(text, /"name":"shell_command"/);
    assert.ok(text.indexOf('Starting with the config file.') < text.indexOf('"call_id":"call_shell"'));
    assert.match(text, /event: response\.completed/);
    const completedPayload = JSON.parse(
      [...text.matchAll(/event: response\.completed\r?\ndata: ([^\n]+)/g)].at(-1)[1],
    );
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

test('aborts the upstream request when the streaming client disconnects', async () => {
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
    sessions: new SessionStore(),
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

test('stops the web-search loop without further rounds when the client disconnects', async () => {
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
    sessions: new SessionStore(),
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

test('exposes an unavailable web_search shim when no search provider is configured', async () => {
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
    sessions: new SessionStore(),
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
    assert.match(shim.function.description, /no search provider configured/);
  } finally {
    await close(proxy);
    await close(upstream);
  }
});
