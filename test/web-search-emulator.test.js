import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

async function scenario(name, run) {
  try {
    await run();
  } catch (error) {
    error.message = `${name}: ${error.message}`;
    throw error;
  }
}
import {
  advanceWebSearchChatRequest,
  annotateMessagePartWithWebCitations,
  APPLY_PATCH_CORRECTION_LIMIT,
  applyPatchCorrectionMessages,
  applyPatchRoundAction,
  applyWebSearchOutputCompatibility,
  assistantMessageFromCompletion,
  buildWebSearchCallItem,
  buildWebSearchCallItems,
  containsWebSearchTool,
  executeWebSearchCalls,
  extractInternalWebSearchCalls,
  hasAnyToolCalls,
  hasKnownExternalToolCalls,
  hasUnknownExternalToolCalls,
  hasVisibleAssistantContent,
  knownExternalToolCallsCompletion,
  maxWebSearchRounds,
  noteWebSearchModelContinuation,
  prepareWebSearchRequest,
  providerRetryDelayMs,
  removeWebSearchInstructions,
  shouldContinueWebSearchLoop,
  shouldIncludeSearchSources,
  unhandledToolMessagesFromCompletion,
  webSearchDiagnosticsSnapshot,
  webSearchRoundDecision,
} from '../src/web-search-emulator.js';
import { clearWebSearchEvidenceForTests, webSearchEvidenceNote } from '../src/web-search-evidence.js';

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function functionTool(name) {
  return {
    type: 'function',
    function: {
      name,
      description: `${name} tool`,
      parameters: { type: 'object', properties: {} },
    },
  };
}

function completion(...toolCalls) {
  return {
    choices: [{
      message: {
        role: 'assistant',
        content: '',
        reasoning_content: 'planned',
        tool_calls: toolCalls,
      },
      finish_reason: 'tool_calls',
    }],
  };
}

function toolCall(id, name, args = {}) {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

test('web-search request preparation and tool classification', async () => {
  await scenario('prepares hosted web search without mutating caller input', async () => {
  const normalized = {
    tools: [{
      type: 'web_search_preview',
      filters: {
        allowed_domains: ['openai.com'],
        blocked_domains: ['example.com'],
      },
      user_location: { type: 'approximate', country: 'CN' },
      search_context_size: 'low',
    }],
    tool_choice: { type: 'web_search_preview' },
  };
  const chatRequest = {
    messages: [{ role: 'system', content: 'Base instructions.' }, { role: 'user', content: 'Search.' }],
    tools: [functionTool('lookup')],
    tool_choice: undefined,
  };
  const prepared = prepareWebSearchRequest({
    normalized,
    chatRequest,
    config: {
      tavilyApiKey: 'tvly-test',
      tavilyWebSearchEnabled: true,
      firecrawlApiKey: 'fc-test',
      firecrawlWebFetchEnabled: true,
    },
  });

  assert.equal(prepared.enabled, true);
  assert.deepEqual(prepared.chatRequest.tools.map((tool) => tool.function.name), [
    'lookup',
    'web_search',
    'web_open_page',
    'web_find_in_page',
  ]);
  assert.deepEqual(prepared.chatRequest.tool_choice, { type: 'function', function: { name: 'web_search' } });
  assert.match(prepared.chatRequest.messages[0].content, /Use web_search when current web facts are needed/);
  assert.match(prepared.chatRequest.messages[0].content, /60 web rounds, 30 searches, and 50 page reads/);
  assert.match(prepared.chatRequest.messages[0].content, /independent web calls may be made together/);
  assert.match(prepared.chatRequest.messages[0].content, /use web_open_page when snippets are insufficient for an important URL/);
  assert.match(prepared.chatRequest.messages[0].content, /do not mix web and non-web tools in the same response/);
  assert.match(prepared.chatRequest.messages[0].content, /For time-bounded requests, set time_range or start_date\/end_date/);
  assert.match(prepared.chatRequest.messages[0].content, /verify that the event date, not merely the source publication date/);
  assert.match(prepared.chatRequest.messages[0].content, /use an official or primary source or corroborate the claim with two independent sources/);
  assert.match(prepared.chatRequest.messages[0].content, /When the final answer relies on web results, place the full source URL, not just the site or outlet name, next to each fact it supports\./);
  const searchTool = prepared.chatRequest.tools.find((tool) => tool.function.name === 'web_search');
  assert.match(searchTool.function.description, /concise sourced evidence/);
  assert.deepEqual(searchTool.function.parameters.properties.search_depth.enum, ['basic', 'advanced']);
  assert.deepEqual(prepared.config.tavilyIncludeDomains, ['openai.com']);
  assert.deepEqual(prepared.config.tavilyExcludeDomains, ['example.com']);
  assert.equal(prepared.config.tavilyCountry, 'china');
  assert.equal(prepared.config.firecrawlCountry, 'CN');
  assert.equal(prepared.config.tavilyDefaultMaxResults, 3);
  assert.deepEqual(chatRequest.tools.map((tool) => tool.function.name), ['lookup']);
  assert.equal(chatRequest.messages[0].content, 'Base instructions.');
  assert.equal(prepared.webCache.searches.size, 0);
  assert.equal(prepared.webCache.pages.size, 0);
  assert.equal(prepared.webState.limits.concurrency, 3);
  assert.equal(prepared.webState.limits.searches, 30);
  assert.equal(prepared.webState.limits.pages, 50);
  assert.equal(prepared.webState.limits.toolChars, 240000);
  });
  await scenario('drops required tool choice for the internal web-search loop', async () => {
  const prepared = prepareWebSearchRequest({
    normalized: { tools: [{ type: 'web_search' }], tool_choice: 'required' },
    chatRequest: {
      messages: [{ role: 'user', content: 'Search.' }],
      tools: [],
      tool_choice: 'required',
    },
    config: { tavilyApiKey: 'key', tavilyWebSearchEnabled: true },
  });

  assert.equal(prepared.enabled, true);
  assert.equal(prepared.chatRequest.tool_choice, undefined);
  });
  await scenario('enables web search only when the request, tool choice, and provider allow it', async () => {
  const chatRequest = { messages: [{ role: 'user', content: 'Search.' }], tools: [functionTool('lookup')] };
  const cases = [
    [{ tools: [] }, { tavilyApiKey: 'key' }],
    [{ tools: [{ type: 'web_search' }] }, {}],
    [{ tools: [{ type: 'web_search' }] }, { tavilyApiKey: 'key', tavilyWebSearchEnabled: false }],
    [{
      tools: [{ type: 'web_search' }],
      tool_choice: { type: 'allowed_tools', tools: [{ type: 'function', name: 'lookup' }] },
    }, { tavilyApiKey: 'key', tavilyWebSearchEnabled: true }],
  ];

  for (const [normalized, config] of cases) {
    assert.deepEqual(prepareWebSearchRequest({ normalized, chatRequest, config }), { enabled: false, chatRequest });
  }
  assert.equal(containsWebSearchTool({ tools: [{ type: 'web_search' }] }), true);
  assert.equal(containsWebSearchTool({ tools: [{ type: 'function', name: 'web_search' }] }), false);
  });
  await scenario('keeps caller-owned tool names and assigns collision-safe internal names', async () => {
  const chatRequest = {
    messages: [{ role: 'user', content: 'Search.' }],
    tools: [functionTool('web_search'), functionTool('web_search_tool'), functionTool('tavily_search')],
  };
  const prepared = prepareWebSearchRequest({
    normalized: { tools: [{ type: 'web_search' }], tool_choice: { type: 'web_search' } },
    chatRequest,
    config: { tavilyApiKey: 'key', tavilyWebSearchEnabled: true },
  });
  const names = prepared.chatRequest.tools.map((tool) => tool.function.name);

  assert.deepEqual(names, ['web_search', 'web_search_tool', 'tavily_search', 'web_search_tool_2']);
  assert.equal(prepared.webTools.search, 'web_search_tool_2');
  assert.deepEqual(prepared.chatRequest.tool_choice, {
    type: 'function',
    function: { name: 'web_search_tool_2' },
  });
  assert.match(prepared.chatRequest.messages[0].content, /Use web_search_tool_2 when current web facts are needed/);
  assert.doesNotMatch(prepared.chatRequest.messages[0].content, /page inspections|primary page fails|web_open_page/);
  });
  await scenario('classifies internal, known external, and unknown tool calls without leaking internal calls', async () => {
  const prepared = prepareWebSearchRequest({
    normalized: { tools: [{ type: 'web_search' }] },
    chatRequest: { messages: [{ role: 'user', content: 'Search.' }], tools: [functionTool('lookup')] },
    config: { tavilyApiKey: 'key', tavilyWebSearchEnabled: true },
  });
  const mixed = completion(
    toolCall('call_search', prepared.webTools.search, { query: 'news' }),
    toolCall('call_known', 'lookup', { q: 'x' }),
    toolCall('call_unknown', 'missing', {}),
  );

  assert.equal(hasAnyToolCalls(mixed), true);
  assert.equal(shouldContinueWebSearchLoop(mixed, prepared.webTools), true);
  assert.deepEqual(extractInternalWebSearchCalls(mixed, prepared.webTools).map((call) => call.id), ['call_search']);
  assert.equal(hasKnownExternalToolCalls(mixed, prepared.chatRequest.tools, prepared.webTools), true);
  assert.equal(hasUnknownExternalToolCalls(mixed, prepared.chatRequest.tools, prepared.webTools), true);

  const externalOnly = knownExternalToolCallsCompletion(mixed, prepared.chatRequest.tools, prepared.webTools);
  assert.deepEqual(externalOnly.choices[0].message.tool_calls.map((call) => call.id), ['call_known']);
  assert.deepEqual(mixed.choices[0].message.tool_calls.map((call) => call.id), ['call_search', 'call_known', 'call_unknown']);

  const recovery = unhandledToolMessagesFromCompletion(mixed, 'Unavailable.', {
    onlyUnknownExternal: true,
    tools: prepared.chatRequest.tools,
    webTools: prepared.webTools,
  });
  assert.equal(recovery[0].role, 'assistant');
  assert.deepEqual(recovery.slice(1).map((message) => message.tool_call_id), ['call_unknown']);
  assert.equal(recovery[1].content, 'Unavailable.');
  assert.equal(assistantMessageFromCompletion(mixed, prepared.webTools).reasoning_content, 'planned');
  });
  await scenario('removes the active web instructions and bounds search rounds', async () => {
  const prepared = prepareWebSearchRequest({
    normalized: { tools: [{ type: 'web_search' }] },
    chatRequest: { messages: [{ role: 'system', content: 'Keep this.' }, { role: 'user', content: 'hello' }], tools: [] },
    config: { tavilyApiKey: 'key', tavilyWebSearchEnabled: true },
  });
  const messages = removeWebSearchInstructions(prepared.chatRequest.messages, prepared.webTools);

  assert.deepEqual(messages, [
    { role: 'system', content: 'Keep this.' },
    { role: 'user', content: 'hello' },
  ]);
  assert.equal(maxWebSearchRounds({}), 60);
  assert.equal(maxWebSearchRounds({ webSearchMaxRounds: -3 }), 0);
  assert.equal(maxWebSearchRounds({ webSearchMaxRounds: 8.9 }), 8);
  assert.equal(maxWebSearchRounds({ webSearchMaxRounds: 100 }), 80);
  });
  await scenario('caps enlarged web-search budgets at their shared hard limits', async () => {
  const prepared = prepareWebSearchRequest({
    normalized: { tools: [{ type: 'web_search' }] },
    chatRequest: { messages: [{ role: 'user', content: 'Search.' }], tools: [] },
    config: {
      tavilyApiKey: 'key',
      tavilyWebSearchEnabled: true,
      firecrawlApiKey: 'key',
      firecrawlWebFetchEnabled: true,
      webSearchMaxRounds: 100,
      webSearchMaxSearches: 100,
      webSearchMaxPages: 100,
      webSearchMaxToolChars: 1000000,
    },
  });

  assert.match(prepared.chatRequest.messages[0].content, /80 web rounds, 50 searches, and 80 page reads/);
  assert.equal(prepared.webState.limits.searches, 50);
  assert.equal(prepared.webState.limits.pages, 80);
  assert.equal(prepared.webState.limits.toolChars, 400000);
  });
});

test('web-search execution, caching, and provider failures', async () => {
  await scenario('executes search and page tools with turn-local caching and default top-result reading', async () => {
  let tavilyCalls = 0;
  let firecrawlCalls = 0;
  const tavilyBodies = [];
  const firecrawlBodies = [];
  const tavily = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    tavilyCalls += 1;
    tavilyBodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      answer: 'Current answer',
      results: [{ title: 'Search Result', url: 'https://example.com/result', content: 'Same query result snippet.' }],
    }));
  });
  const firecrawl = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    firecrawlCalls += 1;
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    firecrawlBodies.push(body);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      data: {
        markdown: `Opened content for ${body.url}. The requested same query, topic, and different topic are present in this sufficiently long paragraph. `.repeat(8),
        metadata: { title: 'Opened Page', sourceURL: body.url },
      },
    }));
  });
  const tavilyBaseUrl = await listen(tavily);
  const firecrawlBaseUrl = await listen(firecrawl);
  const config = {
    tavilyApiKey: 'tvly-test',
    tavilyWebSearchEnabled: true,
    tavilyBaseUrl,
    firecrawlApiKey: 'fc-test',
    firecrawlBaseUrl,
    firecrawlWebFetchEnabled: true,
    firecrawlAutoScrapeTopResults: 1,
  };
  const prepared = prepareWebSearchRequest({
    normalized: { tools: [{ type: 'web_search' }] },
    chatRequest: { messages: [{ role: 'user', content: 'Search.' }], tools: [] },
    config,
  });
  const calls = completion(
    toolCall('search_1', prepared.webTools.search, { query: 'same query', time_range: 'day' }),
    toolCall('search_2', prepared.webTools.search, { query: 'same query', time_range: 'day' }),
    toolCall('open_1', prepared.webTools.openPage, { url: 'https://example.com/page', query: 'topic' }),
    toolCall('open_2', prepared.webTools.openPage, { url: 'https://example.com/page', query: 'different topic' }),
  );
  const started = [];
  const finished = [];

  try {
    const result = await executeWebSearchCalls({
      completion: calls,
      config,
      webTools: prepared.webTools,
      webCache: prepared.webCache,
      onSearchStart: (item) => started.push(item.id),
      onSearchDone: (item) => finished.push(item.id),
    });

    assert.equal(tavilyCalls, 1);
    assert.equal(firecrawlCalls, 2);
    assert.equal(tavilyBodies[0].query, 'same query');
    assert.deepEqual(firecrawlBodies.map((body) => body.url).sort(), [
      'https://example.com/page',
      'https://example.com/result',
    ]);
    assert.equal(firecrawlBodies.find((body) => body.url === 'https://example.com/result').maxAge, 900000);
    assert.equal(firecrawlBodies.find((body) => body.url === 'https://example.com/page').maxAge, 172800000);
    assert.deepEqual(started, ['search_1', 'search_2', 'open_1', 'open_2']);
    assert.deepEqual([...finished].sort(), [...started].sort());
    assert.equal(result.messages.length, 5);
    assert.equal(result.searches.length, 2);
    assert.equal(result.openedPages.filter((page) => page.auto).length, 2);
    assert.equal(result.openedPages.filter((page) => !page.auto).length, 2);
    assert.match(result.messages[1].content, /Opened page matches/);
    assert.doesNotMatch(result.messages[1].content, /Opened page excerpt/);
    assert.match(result.messages[3].content, /Opened page:/);
    assert.match(result.messages[4].content, /Find in page query: different topic/);
    const diagnostics = webSearchDiagnosticsSnapshot(result.webState);
    assert.equal(diagnostics.providerCalls, 3);
    assert.equal(diagnostics.singleFlights + diagnostics.cacheHits, 3);
    assert.equal(diagnostics.counts.searches, 2);
    assert.equal(diagnostics.counts.pages, 4);
    const advanced = advanceWebSearchChatRequest({
      ...prepared.chatRequest,
      tool_choice: { type: 'function', function: { name: prepared.webTools.search } },
    }, {
      toolResult: result,
      commentaryCalls: [toolCall('commentary_1', 'commentary', { text: 'Searching.' })],
      webTools: prepared.webTools,
    });
    assert.equal(advanced.messages.length, prepared.chatRequest.messages.length + result.messages.length + 1);
    assert.equal(advanced.messages.at(-1).tool_call_id, 'commentary_1');
    assert.equal(advanced.tool_choice, 'auto');
  } finally {
    await close(tavily);
    await close(firecrawl);
  }
  });
  await scenario('returns provider failures as model-readable tool results without caching them', async () => {
  let calls = 0;
  const tavily = http.createServer(async (_req, res) => {
    calls += 1;
    res.writeHead(429, { 'content-type': 'text/plain', 'retry-after': '0' });
    res.end('rate limited');
  });
  const tavilyBaseUrl = await listen(tavily);
  const config = { tavilyApiKey: 'key', tavilyWebSearchEnabled: true, tavilyBaseUrl };
  const prepared = prepareWebSearchRequest({
    normalized: { tools: [{ type: 'web_search' }] },
    chatRequest: { messages: [{ role: 'user', content: 'Search.' }], tools: [] },
    config,
  });

  try {
    const result = await executeWebSearchCalls({
      completion: completion(
        toolCall('search_1', prepared.webTools.search, { query: 'same query' }),
        toolCall('search_2', prepared.webTools.search, { query: 'same query' }),
      ),
      config,
      webTools: prepared.webTools,
      webCache: prepared.webCache,
    });
    assert.equal(calls, 2);
    assert.equal(result.searches.every((search) => search.error === 'rate limited'), true);
    assert.equal(result.messages.slice(1).every((message) => /Search error: rate limited/.test(message.content)), true);
    await executeWebSearchCalls({
      completion: completion(toolCall('search_3', prepared.webTools.search, { query: 'same query' })),
      config,
      webTools: prepared.webTools,
      webCache: prepared.webCache,
      webState: result.webState,
    });
    assert.equal(calls, 4);
  } finally {
    await close(tavily);
  }
  });
  await scenario('keeps failed automatic page enrichment out of search evidence', async () => {
  const tavily = http.createServer(async (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      results: [{ title: 'Source', url: 'https://example.com/source', content: 'Useful query search snippet.' }],
    }));
  });
  const firecrawl = http.createServer(async (_req, res) => {
    res.destroy();
  });
  const tavilyBaseUrl = await listen(tavily);
  const firecrawlBaseUrl = await listen(firecrawl);
  const config = {
    tavilyApiKey: 'key',
    tavilyWebSearchEnabled: true,
    tavilyBaseUrl,
    firecrawlApiKey: 'key',
    firecrawlBaseUrl,
    firecrawlWebFetchEnabled: true,
    firecrawlAutoScrapeTopResults: 1,
  };
  const prepared = prepareWebSearchRequest({
    normalized: { tools: [{ type: 'web_search' }] },
    chatRequest: { messages: [{ role: 'user', content: 'Search.' }], tools: [] },
    config,
  });

  try {
    const result = await executeWebSearchCalls({
      completion: completion(toolCall('search_1', prepared.webTools.search, { query: 'query' })),
      config,
      webTools: prepared.webTools,
      webCache: prepared.webCache,
      webState: prepared.webState,
    });
    assert.equal(result.searches[0].error, '');
    assert.equal(result.searches[0].results[0].page, undefined);
    assert.equal(result.openedPages.length, 0);
    assert.equal(buildWebSearchCallItem(result.searches[0]).status, 'completed');
    assert.equal(result.hadProviderFailure, true);
    assert.doesNotMatch(result.messages[1].content, /Opened page error:/);
    assert.match(result.messages[1].content, /Useful query search snippet/);
    assert.equal(webSearchDiagnosticsSnapshot(result.webState).operations.some((item) => item.operation === 'open_page' && item.providerCall), true);
    noteWebSearchModelContinuation(result.webState, result.hadProviderFailure);
    assert.equal(webSearchDiagnosticsSnapshot(result.webState).failureRounds, 1);
  } finally {
    await close(tavily);
    await close(firecrawl);
  }
  });
  await scenario('bounds provider concurrency and preserves tool-result order', async () => {
  let active = 0;
  let maxActive = 0;
  const tavily = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 30));
    active -= 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ results: [{ title: body.query, url: `https://example.com/${body.query}`, content: body.query }] }));
  });
  const tavilyBaseUrl = await listen(tavily);
  const config = {
    tavilyApiKey: 'key',
    tavilyWebSearchEnabled: true,
    tavilyBaseUrl,
    firecrawlAutoScrapeTopResults: 0,
    webSearchConcurrency: 2,
    webSearchMaxToolChars: 1000,
  };
  const prepared = prepareWebSearchRequest({
    normalized: { tools: [{ type: 'web_search' }] },
    chatRequest: { messages: [{ role: 'user', content: 'Search.' }], tools: [] },
    config,
  });

  try {
    const result = await executeWebSearchCalls({
      completion: completion(
        toolCall('search_1', prepared.webTools.search, { query: 'one' }),
        toolCall('search_2', prepared.webTools.search, { query: 'two' }),
        toolCall('search_3', prepared.webTools.search, { query: 'three' }),
        toolCall('search_4', prepared.webTools.search, { query: 'four' }),
      ),
      config,
      webTools: prepared.webTools,
      webCache: prepared.webCache,
      webState: prepared.webState,
    });
    assert.equal(maxActive, 2);
    assert.deepEqual(result.messages.slice(1).map((message) => message.tool_call_id), [
      'search_1',
      'search_2',
      'search_3',
      'search_4',
    ]);
    assert.deepEqual(result.searches.map((search) => search.query), ['one', 'two', 'three', 'four']);
    assert.equal(result.messages.slice(1).every((message) => message.content.trim().length > 0), true);
    assert.match(result.messages[1].content, /Web search results for: one/);
    assert.equal(webSearchDiagnosticsSnapshot(result.webState).counts.toolChars <= 1000, true);
  } finally {
    await close(tavily);
  }
  });
  await scenario('enforces the turn deadline and operation budgets without retrying providers', async () => {
  let calls = 0;
  const tavily = http.createServer(async (_req, res) => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (res.destroyed) return;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ results: [] }));
  });
  const tavilyBaseUrl = await listen(tavily);
  const config = {
    tavilyApiKey: 'key',
    tavilyWebSearchEnabled: true,
    tavilyBaseUrl,
    tavilyTimeoutMs: 1000,
    webSearchTurnTimeoutMs: 100,
    webSearchMaxSearches: 1,
    firecrawlAutoScrapeTopResults: 0,
  };
  const prepared = prepareWebSearchRequest({
    normalized: { tools: [{ type: 'web_search' }] },
    chatRequest: { messages: [{ role: 'user', content: 'Search.' }], tools: [] },
    config,
  });

  try {
    const result = await executeWebSearchCalls({
      completion: completion(
        toolCall('search_1', prepared.webTools.search, { query: 'one' }),
        toolCall('search_2', prepared.webTools.search, { query: 'two' }),
      ),
      config,
      webTools: prepared.webTools,
      webCache: prepared.webCache,
      webState: prepared.webState,
    });
    assert.equal(calls, 1);
    assert.match(result.searches[0].error, /timed out/i);
    assert.match(result.searches[1].error, /search limit reached/i);
    const diagnostics = webSearchDiagnosticsSnapshot(result.webState);
    assert.equal(diagnostics.providerCalls, 1);
    assert.equal(diagnostics.operations.some((item) => item.errorCategory === 'timeout'), true);
    assert.equal(diagnostics.operations.some((item) => item.errorCategory === 'search_limit'), true);
  } finally {
    await close(tavily);
  }
  });
  await scenario('gives every assistant tool_call a response when advancing a mixed internal-and-unknown round', async () => {
  const tavily = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ results: [{ title: 'Source', url: 'https://example.com/s', content: 'Snippet text.' }] }));
  });
  const tavilyBaseUrl = await listen(tavily);
  const config = { tavilyApiKey: 'key', tavilyWebSearchEnabled: true, tavilyBaseUrl, firecrawlAutoScrapeTopResults: 0 };
  const prepared = prepareWebSearchRequest({
    normalized: { tools: [{ type: 'web_search' }] },
    chatRequest: { messages: [{ role: 'user', content: 'Search.' }], tools: [functionTool('lookup')] },
    config,
  });
  try {
    const result = await executeWebSearchCalls({
      completion: completion(
        toolCall('search_1', prepared.webTools.search, { query: 'q' }),
        toolCall('call_unknown', 'missing', {}),
      ),
      config,
      webTools: prepared.webTools,
      webCache: prepared.webCache,
      webState: prepared.webState,
    });
    const advanced = advanceWebSearchChatRequest(prepared.chatRequest, {
      toolResult: result,
      commentaryCalls: [],
      webTools: prepared.webTools,
    });
    const respondedIds = new Set(
      advanced.messages.filter((message) => message.role === 'tool').map((message) => message.tool_call_id),
    );
    for (const call of result.messages[0].tool_calls) {
      assert.equal(respondedIds.has(call.id), true);
    }
    const stub = advanced.messages.find((message) => message.role === 'tool' && message.tool_call_id === 'call_unknown');
    assert.match(stub.content, /not available in this turn/);
  } finally {
    await close(tavily);
  }
  });
  await scenario('emits a concise plain-text notice when the per-turn search budget is exhausted', async () => {
  const tavily = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ results: [{ title: 'Source', url: 'https://example.com/s', content: 'Snippet text.' }] }));
  });
  const tavilyBaseUrl = await listen(tavily);
  const config = { tavilyApiKey: 'key', tavilyWebSearchEnabled: true, tavilyBaseUrl, webSearchMaxSearches: 1, webSearchConcurrency: 1, firecrawlAutoScrapeTopResults: 0 };
  const prepared = prepareWebSearchRequest({
    normalized: { tools: [{ type: 'web_search' }] },
    chatRequest: { messages: [{ role: 'user', content: 'Search.' }], tools: [] },
    config,
  });
  try {
    const result = await executeWebSearchCalls({
      completion: completion(
        toolCall('search_1', prepared.webTools.search, { query: 'one' }),
        toolCall('search_2', prepared.webTools.search, { query: 'two' }),
      ),
      config,
      webTools: prepared.webTools,
      webCache: prepared.webCache,
      webState: prepared.webState,
    });
    const limited = result.messages[2];
    assert.equal(limited.tool_call_id, 'search_2');
    assert.match(limited.content, /web searches limit for this turn was reached/);
    assert.doesNotMatch(limited.content, /Web search results for:/);
    assert.equal(result.messages.slice(1).every((message) => message.content.trim().length > 0), true);
    assert.match(result.searches[1].error, /search limit reached/i);
  } finally {
    await close(tavily);
  }
  });
  await scenario('reports automatic page-read limits in the search result shown to the model', async () => {
  const tavily = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ results: [{ title: 'Primary Source', url: 'https://example.com/s', content: 'Snippet evidence.' }] }));
  });
  const tavilyBaseUrl = await listen(tavily);
  const config = {
    tavilyApiKey: 'key',
    tavilyWebSearchEnabled: true,
    tavilyBaseUrl,
    firecrawlApiKey: 'key',
    firecrawlWebFetchEnabled: true,
    firecrawlAutoScrapeTopResults: 1,
    webSearchMaxPages: 0,
  };
  const prepared = prepareWebSearchRequest({
    normalized: { tools: [{ type: 'web_search' }] },
    chatRequest: { messages: [{ role: 'user', content: 'Search.' }], tools: [] },
    config,
  });
  try {
    const result = await executeWebSearchCalls({
      completion: completion(toolCall('search_1', prepared.webTools.search, { query: 'primary fact' })),
      config,
      webTools: prepared.webTools,
      webCache: prepared.webCache,
      webState: prepared.webState,
    });
    assert.match(result.messages[1].content, /Search status: No useful page body was opened automatically/);
    assert.match(result.messages[1].content, /Search status: Page read limit reached/);
    assert.match(result.messages[1].content, /Snippet evidence/);
    const diagnostics = webSearchDiagnosticsSnapshot(result.webState);
    assert.equal(diagnostics.operations.some((item) => item.errorCategory === 'page_limit' && item.providerCall === false), true);
  } finally {
    await close(tavily);
  }
  });
  await scenario('splits result text budget across same-round explicit pages', async () => {
  const firecrawl = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      data: {
        markdown: 'Long page body. '.repeat(800),
        metadata: { title: 'Long Page', sourceURL: 'https://example.com/page' },
      },
    }));
  });
  const firecrawlBaseUrl = await listen(firecrawl);
  const config = {
    tavilyApiKey: 'key',
    tavilyWebSearchEnabled: true,
    firecrawlApiKey: 'key',
    firecrawlBaseUrl,
    firecrawlWebFetchEnabled: true,
    webSearchMaxToolChars: 6000,
    webSearchConcurrency: 2,
  };
  const prepared = prepareWebSearchRequest({
    normalized: { tools: [{ type: 'web_search' }] },
    chatRequest: { messages: [{ role: 'user', content: 'Open pages.' }], tools: [] },
    config,
  });
  try {
    const result = await executeWebSearchCalls({
      completion: completion(
        toolCall('open_1', prepared.webTools.openPage, { url: 'https://example.com/a' }),
        toolCall('open_2', prepared.webTools.openPage, { url: 'https://example.com/b' }),
      ),
      config,
      webTools: prepared.webTools,
      webCache: prepared.webCache,
      webState: prepared.webState,
    });
    assert.equal(result.messages[1].content.length <= 3300, true);
    assert.equal(result.messages[2].content.length <= 3300, true);
    assert.match(result.messages[1].content, /Opened page:/);
    assert.match(result.messages[2].content, /Opened page:/);
    assert.equal(webSearchDiagnosticsSnapshot(result.webState).counts.toolChars <= 6000, true);
  } finally {
    await close(firecrawl);
  }
  });
  await scenario('screens and deduplicates search results while preserving lower-overlap evidence for the model', async () => {
  const firecrawlBodies = [];
  const tavily = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      results: [
        { title: 'USA Federal Holidays 2026', url: 'https://travel.example/holidays', content: 'Dates for public holidays and vacation planning.', score: 0.99 },
        { title: '2026 FIFA World Cup Final', url: 'https://news.example/final', content: 'Final result and winner report.', score: 0.8 },
        { title: 'Duplicate World Cup Final', url: 'https://news.example/final#report', content: 'Final result and winner report.', score: 0.7 },
      ],
    }));
  });
  const firecrawl = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    firecrawlBodies.push(body);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      data: {
        markdown: 'The 2026 FIFA World Cup final result and winner are documented with match evidence. '.repeat(12),
        links: [{ title: 'Navigation', url: 'https://news.example/navigation' }],
        metadata: { title: 'World Cup Final Report', sourceURL: body.url },
      },
    }));
  });
  const tavilyBaseUrl = await listen(tavily);
  const firecrawlBaseUrl = await listen(firecrawl);
  const config = {
    tavilyApiKey: 'key',
    tavilyWebSearchEnabled: true,
    tavilyBaseUrl,
    firecrawlApiKey: 'key',
    firecrawlBaseUrl,
    firecrawlWebFetchEnabled: true,
    firecrawlAutoScrapeTopResults: 1,
    debugPayload: true,
  };
  const prepared = prepareWebSearchRequest({
    normalized: { tools: [{ type: 'web_search' }] },
    chatRequest: { messages: [{ role: 'user', content: 'Search.' }], tools: [] },
    config,
  });
  try {
    const result = await executeWebSearchCalls({
      completion: completion(toolCall('search_1', prepared.webTools.search, { query: '2026 FIFA World Cup final result winner' })),
      config,
      webTools: prepared.webTools,
      webCache: prepared.webCache,
      webState: prepared.webState,
    });
    assert.deepEqual(firecrawlBodies.map((body) => body.url), ['https://news.example/final']);
    assert.deepEqual(firecrawlBodies[0].formats, ['markdown']);
    assert.equal(result.openedPages.length, 1);
    assert.equal(result.openedPages[0].url, 'https://news.example/final');
    assert.deepEqual(result.openedPages[0].links, []);
    assert.equal(result.searches[0].results.length, 2);
    assert.equal(result.searches[0].results[0].url, 'https://news.example/final');
    assert.equal(result.searches[0].results[0].page.url, 'https://news.example/final');
    assert.equal(result.searches[0].results[1].url, 'https://travel.example/holidays');
    assert.equal(result.searches[0].results[1].page, undefined);
    assert.match(result.messages[1].content, /Source 1: 2026 FIFA World Cup Final/);
    assert.match(result.messages[1].content, /Source 2: USA Federal Holidays 2026/);
    assert.doesNotMatch(result.messages[1].content, /Duplicate World Cup Final/);
    assert.doesNotMatch(result.messages[1].content, /lower-overlap candidate/);
    assert.doesNotMatch(result.messages[1].content, /Navigation/);
    const diagnostics = webSearchDiagnosticsSnapshot(result.webState);
    assert.equal(diagnostics.counts.pages, 1);
    const searchOperation = diagnostics.operations.find((item) => item.operation === 'search');
    const pageOperation = diagnostics.operations.find((item) => item.operation === 'open_page');
    assert.equal(searchOperation.returnedResults, 3);
    assert.equal(searchOperation.retainedResults, 2);
    assert.equal(pageOperation.candidateRank, 1);
    assert.equal(searchOperation.distinctOrigins, 2);
    assert.equal(pageOperation.candidateRelevant, true);
    assert.equal(pageOperation.candidateCoverage >= 0.4, true);
    assert.equal(pageOperation.candidateAnchorsAccepted, true);
    assert.equal(pageOperation.accepted, true);
    assert.equal(pageOperation.pageEvidenceHits >= 3, true);
    assert.equal(pageOperation.pageEvidenceCoverage >= 0.4, true);
    assert.equal(pageOperation.pageAnchorsAccepted, true);
    assert.equal(pageOperation.acceptedDistinctOrigins, 1);
    assert.equal(pageOperation.matches > 0, true);
    assert.equal(pageOperation.markdownChars > 0, true);
    assert.deepEqual(pageOperation.options.formats, ['markdown']);
    assert.equal(pageOperation.options.includeLinks, false);
  } finally {
    await close(tavily);
    await close(firecrawl);
  }
  });
  await scenario('filters entity-specific pages and bounds automatic fallback attempts', async () => {
    const firecrawlUrls = [];
  const tavily = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const results = body.query === 'bounded'
      ? [
        { title: 'Generic result one', url: 'https://generic.example/one', content: 'OpenAtom open source report summary.', score: 0.9 },
        { title: 'Generic result two', url: 'https://generic.example/two', content: 'OpenAtom open source report details.', score: 0.8 },
        { title: 'Target result', url: 'https://target.example/report', content: 'OpenAtom open source report details.', score: 0.7 },
      ]
      : [
        { title: 'OpenAtom open source report', url: 'https://quarterly.example/report', content: 'OpenAtom open source report summary.', score: 0.9 },
        { title: 'OpenAtom open source report details', url: 'https://report.example/2025', content: 'OpenAtom open source report with project and ecosystem data.', score: 0.8 },
      ];
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ results }));
  });
  const firecrawl = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    firecrawlUrls.push(body.url);
    res.writeHead(200, { 'content-type': 'application/json' });
    const markdown = body.url === 'https://quarterly.example/report'
      ? 'Quarterly open source report with general ecosystem background.'.repeat(24)
      : body.url.startsWith('https://generic.example/')
      ? 'Generic open source report with general ecosystem background.'.repeat(24)
      : 'OpenAtom open source report details with project and ecosystem data.'.repeat(24);
    res.end(JSON.stringify({ data: { markdown, metadata: { title: '报告正文', sourceURL: body.url } } }));
  });
  const tavilyBaseUrl = await listen(tavily);
  const firecrawlBaseUrl = await listen(firecrawl);
  const config = {
    tavilyApiKey: 'key',
    tavilyWebSearchEnabled: true,
    tavilyBaseUrl,
    firecrawlApiKey: 'key',
    firecrawlBaseUrl,
    firecrawlWebFetchEnabled: true,
    firecrawlAutoScrapeTopResults: 1,
    debugPayload: true,
  };
  const prepared = prepareWebSearchRequest({
    normalized: { tools: [{ type: 'web_search' }] },
    chatRequest: { messages: [{ role: 'user', content: 'Search.' }], tools: [] },
    config,
  });
  try {
    const result = await executeWebSearchCalls({
      completion: completion(toolCall('search_anchor', prepared.webTools.search, { query: 'OpenAtom open source report' })),
      config,
      webTools: prepared.webTools,
      webCache: prepared.webCache,
      webState: prepared.webState,
    });
    assert.deepEqual(firecrawlUrls, ['https://quarterly.example/report', 'https://report.example/2025']);
    assert.equal(result.openedPages.length, 1);
    assert.equal(result.openedPages[0].url, 'https://report.example/2025');
    assert.match(result.messages[1].content, /Automatic page evidence rejected 1 anchor mismatch; snippets remain available\./);
    assert.match(result.messages[1].content, /listed snippets span 2 origins/);
    const diagnostics = webSearchDiagnosticsSnapshot(result.webState);
    const pages = diagnostics.operations.filter((item) => item.operation === 'open_page');
    assert.equal(pages.length, 2);
    assert.equal(pages[0].evidenceOutcome, 'anchor_mismatch');
    assert.equal(pages[0].accepted, false);
    assert.equal(pages[1].accepted, true);

    const bounded = await executeWebSearchCalls({
      completion: completion(toolCall('search_bounded', prepared.webTools.search, { query: 'bounded' })),
      config,
      webTools: prepared.webTools,
      webCache: prepared.webCache,
      webState: prepared.webState,
    });
    assert.equal(bounded.openedPages.length, 0);
    assert.match(bounded.messages[1].content, /Automatic page attempt limit reached; remaining search candidates are snippets only\./);
    assert.deepEqual(firecrawlUrls, [
      'https://quarterly.example/report',
      'https://report.example/2025',
      'https://generic.example/one',
      'https://generic.example/two',
    ]);
  } finally {
    await close(tavily);
    await close(firecrawl);
  }
  });
  await scenario('skips denied origins for later automatic enrichment but preserves explicit page reads', async () => {
  const firecrawlUrls = [];
  const tavily = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const key = body.query.startsWith('Alpha') ? 'alpha' : 'beta';
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      results: [
        { title: `${body.query} social report`, url: `https://blocked.example/${key}`, content: `${body.query} evidence.`, score: 0.9 },
        { title: `${body.query} primary report`, url: `https://useful.example/${key}`, content: `${body.query} evidence.`, score: 0.8 },
      ],
    }));
  });
  const firecrawl = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    firecrawlUrls.push(body.url);
    if (body.url.startsWith('https://blocked.example/')) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Forbidden' }));
      return;
    }
    const topic = body.url.endsWith('/alpha') ? 'Alpha launch evidence' : 'Beta launch evidence';
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      data: {
        markdown: `${topic} with timing, outcome, and primary source details. `.repeat(16),
        metadata: { title: 'Useful Report', sourceURL: body.url },
      },
    }));
  });
  const tavilyBaseUrl = await listen(tavily);
  const firecrawlBaseUrl = await listen(firecrawl);
  const config = {
    tavilyApiKey: 'key',
    tavilyWebSearchEnabled: true,
    tavilyBaseUrl,
    firecrawlApiKey: 'key',
    firecrawlBaseUrl,
    firecrawlWebFetchEnabled: true,
    firecrawlAutoScrapeTopResults: 1,
    debugPayload: true,
  };
  const prepared = prepareWebSearchRequest({
    normalized: { tools: [{ type: 'web_search' }] },
    chatRequest: { messages: [{ role: 'user', content: 'Search.' }], tools: [] },
    config,
  });
  try {
    const first = await executeWebSearchCalls({
      completion: completion(toolCall('search_alpha', prepared.webTools.search, { query: 'Alpha launch' })),
      config,
      webTools: prepared.webTools,
      webCache: prepared.webCache,
      webState: prepared.webState,
    });
    const second = await executeWebSearchCalls({
      completion: completion(toolCall('search_beta', prepared.webTools.search, { query: 'Beta launch' })),
      config,
      webTools: prepared.webTools,
      webCache: prepared.webCache,
      webState: prepared.webState,
    });
    const explicit = await executeWebSearchCalls({
      completion: completion(toolCall('open_blocked', prepared.webTools.openPage, { url: 'https://blocked.example/manual', query: 'manual' })),
      config,
      webTools: prepared.webTools,
      webCache: prepared.webCache,
      webState: prepared.webState,
    });
    assert.deepEqual(firecrawlUrls, [
      'https://blocked.example/alpha',
      'https://useful.example/alpha',
      'https://useful.example/beta',
      'https://blocked.example/manual',
    ]);
    assert.equal(first.openedPages[0].url, 'https://useful.example/alpha');
    assert.equal(second.openedPages[0].url, 'https://useful.example/beta');
    assert.match(second.messages[1].content, /1 automatic page candidate skipped because the same origin was already denied earlier in this turn/);
    assert.match(explicit.openedPages[0].error, /Forbidden/);
    const diagnostics = webSearchDiagnosticsSnapshot(explicit.webState);
    const skipped = diagnostics.operations.find((item) => item.skipReason === 'origin_access_denied');
    assert.ok(skipped);
    assert.equal(skipped.providerCall, false);
    assert.equal(skipped.candidateRank, 1);
    assert.equal(diagnostics.counts.pages, 4);
    const rejected = diagnostics.operations.find((item) => item.url === 'https://blocked.example/alpha');
    const accepted = diagnostics.operations.find((item) => item.url === 'https://useful.example/alpha');
    assert.equal(rejected.accepted, false);
    assert.equal(rejected.status, 403);
    assert.equal(accepted.accepted, true);
    assert.equal(accepted.candidateRank, 2);
    assert.equal(accepted.matches > 0, true);
  } finally {
    await close(tavily);
    await close(firecrawl);
  }
  });
  await scenario('ranks matching automatic page candidates by Tavily relevance score', async () => {
  const firecrawlUrls = [];
  const tavily = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      results: [
        { title: '世界杯决赛结果概览', url: 'https://first.example/article', content: '赛事报道。', score: 0.2 },
        { title: '世界杯决赛结果详情', url: 'https://best.example/article', content: '赛事报道。', score: 0.9 },
      ],
    }));
  });
  const firecrawl = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    firecrawlUrls.push(body.url);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      data: {
        markdown: '世界杯决赛结果正文包含比赛时间、胜者和赛事证据。'.repeat(24),
        metadata: { title: '赛事报道', sourceURL: body.url },
      },
    }));
  });
  const tavilyBaseUrl = await listen(tavily);
  const firecrawlBaseUrl = await listen(firecrawl);
  const config = {
    tavilyApiKey: 'key',
    tavilyWebSearchEnabled: true,
    tavilyBaseUrl,
    firecrawlApiKey: 'key',
    firecrawlBaseUrl,
    firecrawlWebFetchEnabled: true,
    firecrawlAutoScrapeTopResults: 1,
  };
  const prepared = prepareWebSearchRequest({
    normalized: { tools: [{ type: 'web_search' }] },
    chatRequest: { messages: [{ role: 'user', content: 'Search.' }], tools: [] },
    config,
  });
  try {
    const result = await executeWebSearchCalls({
      completion: completion(toolCall('search_1', prepared.webTools.search, { query: '世界杯决赛结果' })),
      config,
      webTools: prepared.webTools,
      webCache: prepared.webCache,
      webState: prepared.webState,
    });
    assert.deepEqual(firecrawlUrls, ['https://best.example/article']);
    assert.equal(result.openedPages.length, 1);
    assert.equal(result.openedPages[0].url, 'https://best.example/article');
    assert.equal(result.searches[0].results[0].url, 'https://best.example/article');
    assert.equal(result.searches[0].results[0].page.url, 'https://best.example/article');
    assert.equal(result.searches[0].results[1].url, 'https://first.example/article');
    assert.equal(result.searches[0].results[1].page, undefined);
    assert.equal(webSearchDiagnosticsSnapshot(result.webState).counts.pages, 1);
  } finally {
    await close(tavily);
    await close(firecrawl);
  }
  });
  await scenario('keeps explicit open_page independent of automatic candidate ranking', async () => {
  const firecrawlUrls = [];
  const firecrawl = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    firecrawlUrls.push(body.url);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      data: {
        markdown: 'Public post body with launch details. '.repeat(12),
        metadata: { title: 'Public Page', sourceURL: body.url },
      },
    }));
  });
  const firecrawlBaseUrl = await listen(firecrawl);
  const config = {
    tavilyApiKey: 'key',
    tavilyWebSearchEnabled: true,
    firecrawlApiKey: 'key',
    firecrawlBaseUrl,
    firecrawlWebFetchEnabled: true,
  };
  const prepared = prepareWebSearchRequest({
    normalized: { tools: [{ type: 'web_search' }] },
    chatRequest: { messages: [{ role: 'user', content: 'Open page.' }], tools: [] },
    config,
  });
  try {
    const result = await executeWebSearchCalls({
      completion: completion(
        toolCall('open_1', prepared.webTools.openPage, { url: 'https://facebook.com/spacex/posts/1' }),
        toolCall('open_2', prepared.webTools.openPage, { url: 'https://www.youtube.com/watch?v=abc123' }),
      ),
      config,
      webTools: prepared.webTools,
      webCache: prepared.webCache,
      webState: prepared.webState,
    });
    assert.deepEqual(firecrawlUrls.sort(), [
      'https://facebook.com/spacex/posts/1',
      'https://www.youtube.com/watch?v=abc123',
    ]);
    assert.equal(result.openedPages.length, 2);
    assert.equal(result.openedPages[0].url, 'https://facebook.com/spacex/posts/1');
    assert.equal(result.openedPages[0].error, '');
    assert.equal(result.openedPages[1].url, 'https://www.youtube.com/watch?v=abc123');
    assert.equal(result.openedPages[1].error, '');
    assert.match(result.messages[1].content, /Opened page:/);
    assert.match(result.messages[2].content, /Opened page:/);
  } finally {
    await close(firecrawl);
  }
  });
  await scenario('does not spend page quota when text budget is already exhausted', async () => {
  const config = {
    tavilyApiKey: 'key',
    tavilyWebSearchEnabled: true,
    firecrawlApiKey: 'key',
    firecrawlWebFetchEnabled: true,
    webSearchMaxToolChars: 1000,
  };
  const prepared = prepareWebSearchRequest({
    normalized: { tools: [{ type: 'web_search' }] },
    chatRequest: { messages: [{ role: 'user', content: 'Open page.' }], tools: [] },
    config,
  });
  prepared.webState.counts.toolChars = prepared.webState.limits.toolChars;
  const result = await executeWebSearchCalls({
    completion: completion(toolCall('open_1', prepared.webTools.openPage, { url: 'https://example.com/a' })),
    config,
    webTools: prepared.webTools,
    webCache: prepared.webCache,
    webState: prepared.webState,
  });
  const diagnostics = webSearchDiagnosticsSnapshot(result.webState);
  assert.equal(diagnostics.counts.pages, 0);
  assert.equal(diagnostics.operations[0].errorCategory, 'tool_text_limit');
  assert.match(result.messages[1].content, /No more web result text/);
  });
  await scenario('records debug targets only when payload debugging is enabled', async () => {
  const tavily = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ results: [{ title: 'Source', url: 'https://example.com/source', content: 'Snippet.' }] }));
  });
  const tavilyBaseUrl = await listen(tavily);
  const baseConfig = {
    tavilyApiKey: 'key',
    tavilyWebSearchEnabled: true,
    tavilyBaseUrl,
    firecrawlAutoScrapeTopResults: 0,
  };
  const first = prepareWebSearchRequest({
    normalized: { tools: [{ type: 'web_search' }] },
    chatRequest: { messages: [{ role: 'user', content: 'Search.' }], tools: [] },
    config: baseConfig,
  });
  const secondConfig = { ...baseConfig, debugPayload: true };
  const second = prepareWebSearchRequest({
    normalized: { tools: [{ type: 'web_search' }] },
    chatRequest: { messages: [{ role: 'user', content: 'Search.' }], tools: [] },
    config: secondConfig,
  });
  try {
    const normal = await executeWebSearchCalls({
      completion: completion(toolCall('search_1', first.webTools.search, { query: 'latest target query', search_depth: 'advanced' })),
      config: baseConfig,
      webTools: first.webTools,
      webCache: first.webCache,
      webState: first.webState,
    });
    const debug = await executeWebSearchCalls({
      completion: completion(toolCall('search_2', second.webTools.search, {
        query: 'latest target query',
        search_depth: 'advanced',
        topic: 'news',
        time_range: 'week',
        start_date: '2026-07-01',
        end_date: '2026-07-25',
        max_results: 4,
        include_domains: ['openai.com', 'example.com'],
        exclude_domains: ['spam.test'],
      })),
      config: secondConfig,
      webTools: second.webTools,
      webCache: second.webCache,
      webState: second.webState,
    });
    const normalOperation = webSearchDiagnosticsSnapshot(normal.webState).operations[0];
    const debugOperation = webSearchDiagnosticsSnapshot(debug.webState).operations[0];
    assert.notEqual(first.webCache, second.webCache);
    assert.equal(normalOperation.cache, 'miss');
    assert.equal(debugOperation.cache, 'miss');
    assert.equal(Object.hasOwn(normalOperation, 'query'), false);
    assert.equal(Object.hasOwn(normalOperation, 'options'), false);
    assert.equal(debugOperation.query, 'latest target query');
    assert.equal(debugOperation.callId, 'search_2');
    assert.match(debugOperation.itemId, /^ws_/);
    assert.deepEqual(debugOperation.options, {
      searchDepth: 'advanced',
      topic: 'news',
      timeRange: 'week',
      startDate: '2026-07-01',
      endDate: '2026-07-25',
      maxResults: 4,
      includeDomains: 2,
      excludeDomains: 1,
    });
  } finally {
    await close(tavily);
  }
  });
});

test('web-search transient provider retry and pre-emption diagnostics', async () => {
  await scenario('retries a transient http failure once and returns the successful result', async () => {
  let calls = 0;
  const tavily = http.createServer((_req, res) => {
    calls += 1;
    if (calls === 1) {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '0' });
      res.end(JSON.stringify({ error: { message: 'rate limited' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ results: [{ title: 'Source', url: 'https://example.com/s', content: 'Snippet text.' }] }));
  });
  const tavilyBaseUrl = await listen(tavily);
  const config = { tavilyApiKey: 'key', tavilyWebSearchEnabled: true, tavilyBaseUrl, firecrawlAutoScrapeTopResults: 0 };
  const prepared = prepareWebSearchRequest({
    normalized: { tools: [{ type: 'web_search' }] },
    chatRequest: { messages: [{ role: 'user', content: 'Search.' }], tools: [] },
    config,
  });
  try {
    const result = await executeWebSearchCalls({
      completion: completion(toolCall('search_1', prepared.webTools.search, { query: 'q' })),
      config,
      webTools: prepared.webTools,
      webCache: prepared.webCache,
      webState: prepared.webState,
    });
    assert.equal(calls, 2);
    assert.equal(result.searches[0].error, '');
    assert.equal(result.searches[0].results.length, 1);
    const diagnostics = webSearchDiagnosticsSnapshot(result.webState);
    const operation = diagnostics.operations.find((item) => item.operation === 'search');
    assert.equal(operation.attempts, 2);
    assert.equal(operation.firstStatus, 429);
    assert.equal(operation.retryReason, 'http_transient');
    assert.equal(operation.totalDurationMs >= operation.durationMs, true);
    assert.equal(diagnostics.providerCalls, 2);
  } finally {
    await close(tavily);
  }
  });
  await scenario('does not cap provider Retry-After when the turn deadline cannot absorb it', async () => {
  let calls = 0;
  const tavily = http.createServer((_req, res) => {
    calls += 1;
    res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '6' });
    res.end(JSON.stringify({ error: { message: 'rate limited' } }));
  });
  const tavilyBaseUrl = await listen(tavily);
  const config = {
    tavilyApiKey: 'key',
    tavilyWebSearchEnabled: true,
    tavilyBaseUrl,
    webSearchTurnTimeoutMs: 6500,
    firecrawlAutoScrapeTopResults: 0,
  };
  const prepared = prepareWebSearchRequest({
    normalized: { tools: [{ type: 'web_search' }] },
    chatRequest: { messages: [{ role: 'user', content: 'Search.' }], tools: [] },
    config,
  });
  try {
    const result = await executeWebSearchCalls({
      completion: completion(toolCall('search_1', prepared.webTools.search, { query: 'q' })),
      config,
      webTools: prepared.webTools,
      webCache: prepared.webCache,
      webState: prepared.webState,
    });
    const operation = webSearchDiagnosticsSnapshot(result.webState).operations.find((item) => item.operation === 'search');
    assert.equal(calls, 1);
    assert.equal(operation.attempts, 1);
    assert.equal(operation.retryAfterMs, 6000);
  } finally {
    await close(tavily);
  }
  });
  await scenario('retries a network failure at most once', async () => {
  let calls = 0;
  const tavily = http.createServer((_req, res) => {
    calls += 1;
    res.destroy();
  });
  const tavilyBaseUrl = await listen(tavily);
  const config = { tavilyApiKey: 'key', tavilyWebSearchEnabled: true, tavilyBaseUrl, firecrawlAutoScrapeTopResults: 0 };
  const prepared = prepareWebSearchRequest({
    normalized: { tools: [{ type: 'web_search' }] },
    chatRequest: { messages: [{ role: 'user', content: 'Search.' }], tools: [] },
    config,
  });
  try {
    const result = await executeWebSearchCalls({
      completion: completion(toolCall('search_1', prepared.webTools.search, { query: 'q' })),
      config,
      webTools: prepared.webTools,
      webCache: prepared.webCache,
      webState: prepared.webState,
    });
    assert.equal(calls, 2);
    assert.match(result.searches[0].error, /fail|fetch/i);
    assert.equal(webSearchDiagnosticsSnapshot(result.webState).operations.find((item) => item.operation === 'search').attempts, 2);
  } finally {
    await close(tavily);
  }
  });
  await scenario('does not retry a provider timeout', async () => {
  let calls = 0;
  const tavily = http.createServer(async (_req, res) => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (res.destroyed) return;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ results: [] }));
  });
  const tavilyBaseUrl = await listen(tavily);
  const config = { tavilyApiKey: 'key', tavilyWebSearchEnabled: true, tavilyBaseUrl, tavilyTimeoutMs: 1000, webSearchTurnTimeoutMs: 100, firecrawlAutoScrapeTopResults: 0 };
  const prepared = prepareWebSearchRequest({
    normalized: { tools: [{ type: 'web_search' }] },
    chatRequest: { messages: [{ role: 'user', content: 'Search.' }], tools: [] },
    config,
  });
  try {
    const result = await executeWebSearchCalls({
      completion: completion(toolCall('search_1', prepared.webTools.search, { query: 'q' })),
      config,
      webTools: prepared.webTools,
      webCache: prepared.webCache,
      webState: prepared.webState,
    });
    assert.equal(calls, 1);
    assert.match(result.searches[0].error, /timed out/i);
    assert.equal(webSearchDiagnosticsSnapshot(result.webState).operations.find((item) => item.operation === 'search').attempts, 1);
  } finally {
    await close(tavily);
  }
  });
  await scenario('skips retry when the turn deadline cannot absorb the backoff', async () => {
  let calls = 0;
  const tavily = http.createServer((_req, res) => {
    calls += 1;
    res.destroy();
  });
  const tavilyBaseUrl = await listen(tavily);
  const config = { tavilyApiKey: 'key', tavilyWebSearchEnabled: true, tavilyBaseUrl, webSearchTurnTimeoutMs: 100, firecrawlAutoScrapeTopResults: 0 };
  const prepared = prepareWebSearchRequest({
    normalized: { tools: [{ type: 'web_search' }] },
    chatRequest: { messages: [{ role: 'user', content: 'Search.' }], tools: [] },
    config,
  });
  try {
    const result = await executeWebSearchCalls({
      completion: completion(toolCall('search_1', prepared.webTools.search, { query: 'q' })),
      config,
      webTools: prepared.webTools,
      webCache: prepared.webCache,
      webState: prepared.webState,
    });
    assert.equal(calls, 1);
    assert.equal(webSearchDiagnosticsSnapshot(result.webState).operations.find((item) => item.operation === 'search').attempts, 1);
  } finally {
    await close(tavily);
  }
  });
  await scenario('records a pre-empted provider deadline as a non-provider call', async () => {
  const config = { tavilyApiKey: 'key', tavilyWebSearchEnabled: true, tavilyBaseUrl: 'http://127.0.0.1:9', firecrawlAutoScrapeTopResults: 0 };
  const prepared = prepareWebSearchRequest({
    normalized: { tools: [{ type: 'web_search' }] },
    chatRequest: { messages: [{ role: 'user', content: 'Search.' }], tools: [] },
    config,
  });
  prepared.webState.deadlineAt = Date.now() - 1000;
  const result = await executeWebSearchCalls({
    completion: completion(toolCall('search_1', prepared.webTools.search, { query: 'q' })),
    config,
    webTools: prepared.webTools,
    webCache: prepared.webCache,
    webState: prepared.webState,
  });
  assert.match(result.searches[0].error, /time budget/i);
  const diagnostics = webSearchDiagnosticsSnapshot(result.webState);
  assert.equal(diagnostics.providerCalls, 0);
  const operation = diagnostics.operations.find((item) => item.operation === 'search');
  assert.equal(operation.providerCall, false);
  assert.equal(operation.errorCategory, 'turn_deadline');
  });
  await scenario('counts the firecrawl weak-text retry as an extra provider call', async () => {
  let firecrawlCalls = 0;
  const firecrawl = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    firecrawlCalls += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    if (firecrawlCalls === 1) {
      res.end(JSON.stringify({
        data: { markdown: 'Just a moment...', metadata: { title: 'Thin', sourceURL: 'https://example.com/weak' } },
      }));
      return;
    }
    res.end(JSON.stringify({
      data: {
        markdown: 'Full article body about the requested topic with plenty of useful evidence and detail. '.repeat(16),
        metadata: { title: 'Full', sourceURL: 'https://example.com/weak', description: 'Useful summary.' },
      },
    }));
  });
  const firecrawlBaseUrl = await listen(firecrawl);
  const config = {
    tavilyApiKey: 'key',
    tavilyWebSearchEnabled: true,
    firecrawlApiKey: 'key',
    firecrawlBaseUrl,
    firecrawlWebFetchEnabled: true,
  };
  const prepared = prepareWebSearchRequest({
    normalized: { tools: [{ type: 'web_search' }] },
    chatRequest: { messages: [{ role: 'user', content: 'Open.' }], tools: [] },
    config,
  });
  try {
    const result = await executeWebSearchCalls({
      completion: completion(toolCall('open_1', prepared.webTools.openPage, { url: 'https://example.com/weak', query: 'topic' })),
      config,
      webTools: prepared.webTools,
      webCache: prepared.webCache,
      webState: prepared.webState,
    });
    assert.equal(firecrawlCalls, 2);
    assert.equal(result.openedPages[0].error, '');
    const diagnostics = webSearchDiagnosticsSnapshot(result.webState);
    const operation = diagnostics.operations.find((item) => item.operation === 'open_page');
    assert.equal(operation.attempts, 1);
    assert.equal(operation.weakTextRetry, true);
    assert.equal(diagnostics.providerCalls, 2);
  } finally {
    await close(firecrawl);
  }
  });
  await scenario('caps the provider Retry-After backoff at the maximum delay', async () => {
    assert.equal(providerRetryDelayMs({ diagnostic: {} }), 500);
    assert.equal(providerRetryDelayMs({ diagnostic: { retryAfterMs: 6000 } }), 6000);
    assert.equal(providerRetryDelayMs({ diagnostic: { retryAfterMs: 60000 } }), 10000);
    assert.equal(providerRetryDelayMs({ result: { diagnostic: { retryAfterMs: 30000 } } }), 10000);
    assert.equal(providerRetryDelayMs({ diagnostic: { retryAfterMs: 10000 } }), 10000);
  });
});

test('web-search cross-freshness page cache reuse', async () => {
  await scenario('reuses a cached page across freshness tiers within a turn but not across independent turns', async () => {
  let firecrawlCalls = 0;
  const tavily = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ results: [{ title: 'Source', url: 'https://example.com/page', content: 'Topic snippet text.' }] }));
  });
  const firecrawl = http.createServer((req, res) => {
    firecrawlCalls += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      data: {
        markdown: 'Opened content for the page. The requested topic is present in this sufficiently long paragraph.',
        metadata: { title: 'Opened Page', sourceURL: 'https://example.com/page' },
      },
    }));
  });
  const tavilyBaseUrl = await listen(tavily);
  const firecrawlBaseUrl = await listen(firecrawl);
  const config = {
    tavilyApiKey: 'key',
    tavilyWebSearchEnabled: true,
    tavilyBaseUrl,
    firecrawlApiKey: 'key',
    firecrawlBaseUrl,
    firecrawlWebFetchEnabled: true,
    firecrawlAutoScrapeTopResults: 1,
  };
  const prepared = prepareWebSearchRequest({
    normalized: { tools: [{ type: 'web_search' }] },
    chatRequest: { messages: [{ role: 'user', content: 'Search.' }], tools: [] },
    config,
  });
  try {
    await executeWebSearchCalls({
      completion: completion(toolCall('search_1', prepared.webTools.search, { query: 'topic', time_range: 'day' })),
      config,
      webTools: prepared.webTools,
      webCache: prepared.webCache,
      webState: prepared.webState,
    });
    assert.equal(firecrawlCalls, 1);
    const explicit = await executeWebSearchCalls({
      completion: completion(toolCall('open_1', prepared.webTools.openPage, { url: 'https://example.com/page', query: 'topic', include_links: false })),
      config,
      webTools: prepared.webTools,
      webCache: prepared.webCache,
      webState: prepared.webState,
    });
    assert.equal(firecrawlCalls, 1);
    assert.equal(explicit.openedPages[0].error, '');
    const second = prepareWebSearchRequest({
      normalized: { tools: [{ type: 'web_search' }] },
      chatRequest: { messages: [{ role: 'user', content: 'Open.' }], tools: [] },
      config,
    });
    const isolated = await executeWebSearchCalls({
      completion: completion(toolCall('open_2', second.webTools.openPage, { url: 'https://example.com/page', query: 'topic', include_links: false })),
      config,
      webTools: second.webTools,
      webCache: second.webCache,
      webState: second.webState,
    });
    assert.equal(firecrawlCalls, 2);
    assert.equal(isolated.openedPages[0].error, '');
  } finally {
    await close(tavily);
    await close(firecrawl);
  }
  });
  await scenario('does not leak an aborted turn single-flight into a concurrent independent turn', async () => {
  let calls = 0;
  const tavily = http.createServer(async (_req, res) => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 200));
    if (res.destroyed) return;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ results: [{ title: 'Source', url: 'https://example.com/s', content: 'Snippet text.' }] }));
  });
  const tavilyBaseUrl = await listen(tavily);
  const config = { tavilyApiKey: 'key', tavilyWebSearchEnabled: true, tavilyBaseUrl, firecrawlAutoScrapeTopResults: 0 };
  const controller = new AbortController();
  const first = prepareWebSearchRequest({
    normalized: { tools: [{ type: 'web_search' }] },
    chatRequest: { messages: [{ role: 'user', content: 'Search.' }], tools: [] },
    config,
  });
  const second = prepareWebSearchRequest({
    normalized: { tools: [{ type: 'web_search' }] },
    chatRequest: { messages: [{ role: 'user', content: 'Search.' }], tools: [] },
    config,
  });
  try {
    const aborted = executeWebSearchCalls({
      completion: completion(toolCall('search_a', first.webTools.search, { query: 'shared query' })),
      config,
      webTools: first.webTools,
      webCache: first.webCache,
      webState: first.webState,
      clientSignal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const healthy = executeWebSearchCalls({
      completion: completion(toolCall('search_b', second.webTools.search, { query: 'shared query' })),
      config,
      webTools: second.webTools,
      webCache: second.webCache,
      webState: second.webState,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    controller.abort();
    await assert.rejects(aborted);
    const healthyResult = await healthy;
    assert.equal(healthyResult.searches[0].error, '');
    assert.equal(healthyResult.searches[0].results.length, 1);
    assert.equal(calls, 2);
  } finally {
    await close(tavily);
  }
  });
  await scenario('does not reuse a loose cached page for a stricter freshness request', async () => {
  let firecrawlCalls = 0;
  const firecrawlBodies = [];
  const tavily = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ results: [{ title: 'Source', url: 'https://example.com/page', content: 'Topic snippet text.' }] }));
  });
  const firecrawl = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    firecrawlCalls += 1;
    firecrawlBodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      data: {
        markdown: 'Opened content for the page. The requested topic is present in this sufficiently long paragraph.',
        metadata: { title: 'Opened Page', sourceURL: 'https://example.com/page' },
      },
    }));
  });
  const tavilyBaseUrl = await listen(tavily);
  const firecrawlBaseUrl = await listen(firecrawl);
  const config = {
    tavilyApiKey: 'key',
    tavilyWebSearchEnabled: true,
    tavilyBaseUrl,
    firecrawlApiKey: 'key',
    firecrawlBaseUrl,
    firecrawlWebFetchEnabled: true,
    firecrawlAutoScrapeTopResults: 1,
  };
  const prepared = prepareWebSearchRequest({
    normalized: { tools: [{ type: 'web_search' }] },
    chatRequest: { messages: [{ role: 'user', content: 'Search.' }], tools: [] },
    config,
  });
  try {
    await executeWebSearchCalls({
      completion: completion(toolCall('open_1', prepared.webTools.openPage, { url: 'https://example.com/page', query: 'topic' })),
      config,
      webTools: prepared.webTools,
      webCache: prepared.webCache,
      webState: prepared.webState,
    });
    assert.equal(firecrawlCalls, 1);
    await executeWebSearchCalls({
      completion: completion(toolCall('search_1', prepared.webTools.search, { query: 'topic', time_range: 'day' })),
      config,
      webTools: prepared.webTools,
      webCache: prepared.webCache,
      webState: prepared.webState,
    });
    assert.equal(firecrawlCalls, 2);
    assert.deepEqual(firecrawlBodies.map((body) => body.maxAge), [172800000, 900000]);
  } finally {
    await close(tavily);
    await close(firecrawl);
  }
  });
});

test('web-search Responses compatibility output', async () => {
  await scenario('builds Codex-compatible web items, citations, and output text', async () => {
  const search = {
    id: 'call_search',
    query: 'release',
    results: [{ index: 1, title: 'Release Notes', url: 'https://example.com/release' }],
    error: '',
  };
  const failedPage = {
    id: 'call_page',
    action: 'open_page',
    url: 'https://example.com/page',
    title: 'Page',
    error: 'failed',
  };
  assert.equal(shouldIncludeSearchSources({ include: ['web_search_call.action.sources'] }), true);
  assert.equal(shouldIncludeSearchSources({ include: [] }), false);
  assert.equal(buildWebSearchCallItem(failedPage).status, 'failed');
  assert.equal(buildWebSearchCallItems([search], { include: [] })[0].action.sources, undefined);
  clearWebSearchEvidenceForTests();
  const rememberedItem = buildWebSearchCallItem(search, { includeSources: false });
  assert.match(webSearchEvidenceNote(rememberedItem.id), /Release Notes/);
  clearWebSearchEvidenceForTests();
  const findItem = buildWebSearchCallItem({
    id: 'call_find',
    action: 'find_in_page',
    url: 'https://example.com/page',
    query: 'needle',
    error: '',
  });
  assert.equal(findItem.action.pattern, 'needle');
  assert.equal(findItem.action.query, undefined);

  const part = { type: 'output_text', text: 'See Release Notes [1].', annotations: [{ type: 'existing' }] };
  annotateMessagePartWithWebCitations(part, [search]);
  assert.equal(part.annotations.length, 2);
  assert.equal(part.annotations[1].url, 'https://example.com/release');

  const ambiguousNumber = {
    type: 'output_text',
    text: 'Final answer after multiple searches [1]. See https://example.com/two and Unique One.',
  };
  annotateMessagePartWithWebCitations(ambiguousNumber, [
    { results: [{ index: 1, title: 'Unique One', url: 'https://example.com/one' }] },
    { results: [{ index: 1, title: 'Unique Two', url: 'https://example.com/two' }] },
  ]);
  assert.deepEqual(ambiguousNumber.annotations.map((item) => item.url).sort(), [
    'https://example.com/one',
    'https://example.com/two',
  ]);
  assert.equal(ambiguousNumber.annotations.some((item) => ambiguousNumber.text.slice(item.start_index, item.end_index) === '[1]'), false);

  const onlyAmbiguousNumber = { type: 'output_text', text: 'Final answer after multiple searches [1].' };
  annotateMessagePartWithWebCitations(onlyAmbiguousNumber, [
    { results: [{ index: 1, title: 'Source A', url: 'https://example.com/a' }] },
    { results: [{ index: 1, title: 'Source B', url: 'https://example.com/b' }] },
  ]);
  assert.equal(onlyAmbiguousNumber.annotations, undefined);

  const payload = {
    normalized: { include: ['web_search_call.action.sources'] },
    output: [
      {
        type: 'function_call',
        name: 'web_search',
        call_id: 'leaked',
        arguments: '{"query":"fallback"}',
        status: 'completed',
      },
      { type: 'message', phase: 'commentary', content: [{ type: 'output_text', text: 'Checking.' }] },
      { type: 'message', phase: 'final_answer', content: [{ type: 'output_text', text: 'See Release Notes [1].' }] },
      { type: 'message', phase: 'final_answer', content: [{ type: 'output_text', text: '   ' }] },
    ],
  };
  const output = applyWebSearchOutputCompatibility(payload, [search], payload.normalized, [
    { ...failedPage, auto: false },
    { ...failedPage, id: 'auto', auto: true },
  ]);

  assert.deepEqual(output.output.map((item) => item.type), [
    'web_search_call',
    'web_search_call',
    'web_search_call',
    'message',
    'message',
  ]);
  assert.equal(output.output.filter((item) => item.type === 'web_search_call').length, 3);
  assert.equal(output.output.at(-1).content[0].text, 'See Release Notes [1].');
  assert.equal(output.output.at(-1).content[0].annotations[0].url, 'https://example.com/release');
  assert.equal(output.output_text, 'See Release Notes [1].');
  });
});

test('web-search per-round routing decisions', async () => {
  const prepared = prepareWebSearchRequest({
    normalized: { tools: [{ type: 'web_search' }] },
    chatRequest: { messages: [{ role: 'user', content: 'Search.' }], tools: [functionTool('lookup')] },
    config: { tavilyApiKey: 'key', tavilyWebSearchEnabled: true },
  });
  const base = {
    commentaryCalls: [],
    round: 0,
    maxRounds: 2,
    tools: prepared.chatRequest.tools,
    webTools: prepared.webTools,
    searches: [],
    openedPages: [],
  };
  const assistantOnly = (content) => ({
    choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
  });

  await scenario('continues internal web rounds until the round budget forces a final answer', async () => {
    const internalOnly = completion(toolCall('call_search', prepared.webTools.search, { query: 'news' }));
    assert.deepEqual(webSearchRoundDecision({ ...base, routingCompletion: internalOnly }), { action: 'continue' });
    assert.deepEqual(
      webSearchRoundDecision({ ...base, routingCompletion: internalOnly, round: 2 }),
      { action: 'final_answer', unsupportedMessages: [] },
    );
  });
  await scenario('forces a final answer when requested web calls cannot add more evidence', async () => {
    const internalOnly = completion(toolCall('call_search', prepared.webTools.search, { query: 'news' }));
    assert.deepEqual(
      webSearchRoundDecision({
        ...base,
        routingCompletion: internalOnly,
        webState: {
          limits: { searches: 20, pages: 30, toolChars: 200000 },
          counts: { searches: 0, pages: 0, toolChars: 199980 },
        },
      }),
      { action: 'final_answer', unsupportedMessages: [] },
    );
    assert.deepEqual(
      webSearchRoundDecision({
        ...base,
        routingCompletion: internalOnly,
        webState: {
          limits: { searches: 1, pages: 30, toolChars: 200000 },
          counts: { searches: 1, pages: 0, toolChars: 1000 },
        },
      }),
      { action: 'final_answer', unsupportedMessages: [] },
    );
    assert.deepEqual(
      webSearchRoundDecision({
        ...base,
        routingCompletion: internalOnly,
        webState: {
          limits: { searches: 20, pages: 30, toolChars: 200000 },
          counts: { searches: 0, pages: 0, toolChars: 1000 },
          deadlineAt: Date.now() - 1000,
        },
      }),
      { action: 'final_answer', unsupportedMessages: [] },
    );
  });
  await scenario('treats commentary-only rounds as internal rounds', async () => {
    const commentaryCalls = [toolCall('call_commentary', 'commentary', { text: 'update' })];
    assert.deepEqual(
      webSearchRoundDecision({ ...base, routingCompletion: assistantOnly(''), commentaryCalls }),
      { action: 'continue' },
    );
    assert.deepEqual(
      webSearchRoundDecision({ ...base, routingCompletion: assistantOnly(''), commentaryCalls, round: 2 }),
      { action: 'final_answer', unsupportedMessages: [] },
    );
  });
  await scenario('prefers known external tool calls over internal and unknown calls', async () => {
    const mixed = completion(
      toolCall('call_search', prepared.webTools.search, { query: 'news' }),
      toolCall('call_known', 'lookup', { q: 'x' }),
      toolCall('call_unknown', 'missing', {}),
    );
    assert.deepEqual(webSearchRoundDecision({ ...base, routingCompletion: mixed }), { action: 'external' });
    assert.deepEqual(webSearchRoundDecision({ ...base, routingCompletion: mixed, round: 2 }), { action: 'external' });
  });
  await scenario('routes invalid apply_patch calls to a correction round before any external handoff', async () => {
    const mixed = completion(
      toolCall('call_bad_patch', 'apply_patch', { edits: [] }),
      toolCall('call_known', 'lookup', { q: 'x' }),
    );
    const invalidApplyPatch = [{ id: 'call_bad_patch', name: 'apply_patch', error: 'edits[0]: unknown type ""' }];
    assert.deepEqual(
      webSearchRoundDecision({ ...base, routingCompletion: mixed, invalidApplyPatch }),
      { action: 'apply_patch_correction' },
    );
    assert.deepEqual(
      webSearchRoundDecision({ ...base, routingCompletion: mixed, invalidApplyPatch, round: 2 }),
      { action: 'apply_patch_exhausted' },
    );
    assert.deepEqual(webSearchRoundDecision({ ...base, routingCompletion: mixed }), { action: 'external' });

    const messages = applyPatchCorrectionMessages(mixed, invalidApplyPatch, {
      commentaryCalls: [toolCall('call_commentary', 'commentary', { text: 'update' })],
      webTools: prepared.webTools,
    });
    assert.equal(messages[0].role, 'assistant');
    assert.deepEqual(
      messages[0].tool_calls.map((call) => call.id),
      ['call_commentary', 'call_bad_patch', 'call_known'],
    );
    assert.deepEqual(
      messages.slice(1).map((message) => message.tool_call_id),
      ['call_commentary', 'call_bad_patch', 'call_known'],
    );
    assert.equal(messages[1].content, 'Delivered to the user.');
    assert.match(messages[2].content, /apply_patch was not executed\. edits\[0\]: unknown type ""/);
    assert.match(messages[2].content, /re-issue all intended tool calls/);
    assert.match(messages[3].content, /No tools were executed this round/);
    assert.match(messages[3].content, /re-issue all intended tool calls/);

    const exhaustedMessages = applyPatchCorrectionMessages(mixed, invalidApplyPatch, { exhausted: true });
    assert.match(exhaustedMessages[1].content, /No correction rounds remain/);
    assert.match(exhaustedMessages[2].content, /No correction rounds remain/);
  });
  await scenario('exhausts apply_patch corrections from the correction budget independent of web rounds', async () => {
    const mixed = completion(
      toolCall('call_bad_patch', 'apply_patch', { edits: [] }),
      toolCall('call_known', 'lookup', { q: 'x' }),
    );
    const invalidApplyPatch = [{ id: 'call_bad_patch', name: 'apply_patch', error: 'edits[0]: unknown type ""' }];
    assert.deepEqual(
      webSearchRoundDecision({ ...base, routingCompletion: mixed, invalidApplyPatch, applyPatchCorrections: 0 }),
      { action: 'apply_patch_correction' },
    );
    assert.deepEqual(
      webSearchRoundDecision({ ...base, routingCompletion: mixed, invalidApplyPatch, applyPatchCorrections: 1 }),
      { action: 'apply_patch_exhausted' },
    );
    assert.deepEqual(
      webSearchRoundDecision({ ...base, routingCompletion: mixed, invalidApplyPatch, applyPatchCorrections: 0, round: 2 }),
      { action: 'apply_patch_exhausted' },
    );
    assert.equal(applyPatchRoundAction({ invalidApplyPatch: [], corrections: 0 }), '');
    assert.equal(applyPatchRoundAction({ invalidApplyPatch: undefined }), '');
    assert.equal(applyPatchRoundAction({ invalidApplyPatch }), 'apply_patch_correction');
    assert.equal(applyPatchRoundAction({ invalidApplyPatch, corrections: APPLY_PATCH_CORRECTION_LIMIT }), 'apply_patch_exhausted');
  });
  await scenario('requests a final answer with recovery messages for unknown external calls', async () => {
    const unknownOnly = completion(toolCall('call_unknown', 'missing', {}));
    const decision = webSearchRoundDecision({ ...base, routingCompletion: unknownOnly });
    assert.equal(decision.action, 'final_answer');
    assert.equal(decision.unsupportedMessages[0].role, 'assistant');
    assert.deepEqual(
      decision.unsupportedMessages.slice(1).map((message) => message.tool_call_id),
      ['call_unknown'],
    );

    const internalAndUnknown = completion(
      toolCall('call_search', prepared.webTools.search, { query: 'news' }),
      toolCall('call_unknown', 'missing', {}),
    );
    const capped = webSearchRoundDecision({ ...base, routingCompletion: internalAndUnknown, round: 2 });
    assert.equal(capped.action, 'final_answer');
    const cappedStubIds = capped.unsupportedMessages.slice(1).map((message) => message.tool_call_id);
    assert.deepEqual(cappedStubIds, ['call_unknown']);
    assert.deepEqual(
      capped.unsupportedMessages[0].tool_calls.map((call) => call.id),
      cappedStubIds,
    );
  });
  await scenario('forces a final answer when web context exists without visible content', async () => {
    assert.deepEqual(
      webSearchRoundDecision({ ...base, routingCompletion: assistantOnly(''), searches: [{ id: 's1' }] }),
      { action: 'final_answer', unsupportedMessages: [] },
    );
    assert.deepEqual(
      webSearchRoundDecision({ ...base, routingCompletion: assistantOnly(''), openedPages: [{ id: 'p1' }] }),
      { action: 'final_answer', unsupportedMessages: [] },
    );
  });
  await scenario('finishes on visible content or when no web context exists', async () => {
    assert.equal(hasVisibleAssistantContent(assistantOnly('Done.')), true);
    assert.equal(hasVisibleAssistantContent(assistantOnly('   ')), false);
    assert.deepEqual(
      webSearchRoundDecision({ ...base, routingCompletion: assistantOnly('Done.'), searches: [{ id: 's1' }] }),
      { action: 'finish' },
    );
    assert.deepEqual(webSearchRoundDecision({ ...base, routingCompletion: assistantOnly('') }), { action: 'finish' });
  });
});
