import assert from 'node:assert/strict';
import http from 'node:http';
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
    assert.equal(body.usage.total_tokens, 40);
    assert.equal(upstreamBodies.length, 2);
    assert.equal(upstreamBodies[0].tools.some((tool) => tool.function?.name === 'tavily_search'), true);
    assert.equal(upstreamBodies[0].stream, false);
    assert.equal(upstreamBodies[1].messages.at(-1).role, 'tool');
    assert.match(upstreamBodies[1].messages.at(-1).content, /Search query: Codex web search Tavily/);
    assert.match(upstreamBodies[1].messages.at(-1).content, /\[1\] Tavily Search API/);
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
    assert.match(text, /event: response\.output_text\.annotation\.added/);
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
    assert.match(toolContent, /\[1\.L1\] Nested Link/);
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

test('does not leak internal search function calls when search loop reaches max rounds', async () => {
  const upstream = http.createServer(async (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
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
        tools: [{ type: 'web_search' }],
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.output[0].type, 'web_search_call');
    assert.equal(body.output.some((item) => item.type === 'function_call' && item.name === 'tavily_search'), false);
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
    assert.equal(body.tool_choice, 'none');
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

test('emits reasoning summary for every DeepSeek reasoning_content chunk when thinking is enabled', async () => {
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
    assert.match(text, /event: response\.reasoning_summary_part\.added/);
    assert.match(text, /event: response\.reasoning_summary_text\.delta/);
    assert.match(text, /think first\. think second\./);
    assert.match(text, /event: response\.output_text\.delta/);
    assert.match(text, /"text":"answer"/);
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
