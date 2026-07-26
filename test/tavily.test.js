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
  buildTavilySearchRequest,
  callTavilySearch,
  formatTavilySearchResult,
  normalizeTavilySearchArgs,
  normalizeTavilySearchResponse,
} from '../src/tavily.js';

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test('Tavily request normalization', async () => {
  await scenario('builds Tavily search request without raw content', async () => {
  const request = buildTavilySearchRequest(
    {
      query: ' latest Codex release ',
      max_results: 20,
      search_depth: 'basic',
      include_domains: ['openai.com', ' developers.openai.com '],
      exclude_domains: 'example.com, spam.test',
      time_range: 'week',
    },
    {
      tavilySearchDepth: 'advanced',
      tavilyMaxResults: 4,
    },
  );

  assert.equal(request.ok, true);
  assert.equal(request.body.query, 'latest Codex release');
  assert.equal(request.body.search_depth, 'basic');
  assert.equal(request.body.chunks_per_source, undefined);
  assert.equal(request.body.max_results, 4);
  assert.equal(request.body.include_raw_content, false);
  assert.equal(request.body.include_usage, true);
  assert.deepEqual(request.body.include_domains, ['openai.com', 'developers.openai.com']);
  assert.deepEqual(request.body.exclude_domains, ['example.com', 'spam.test']);
  assert.equal(request.body.time_range, 'week');
  assert.equal(buildTavilySearchRequest({ query: 'dense', search_depth: 'advanced' }).body.chunks_per_source, 3);
  assert.deepEqual(normalizeTavilySearchArgs(' direct query ', { tavilyMaxResults: 3 }), {
    ok: true,
    query: 'direct query',
    searchDepth: 'basic',
    chunksPerSource: 3,
    maxResults: 3,
    topic: undefined,
    timeRange: undefined,
    startDate: undefined,
    endDate: undefined,
    country: undefined,
    includeDomains: [],
    excludeDomains: [],
  });
  });
  await scenario('accepts Codex-style web_search search argument', async () => {
  const request = buildTavilySearchRequest({ search: 'crude oil price today' }, { tavilyMaxResults: 5 });
  assert.equal(request.ok, true);
  assert.equal(request.body.query, 'crude oil price today');
  });
  await scenario('preserves query syntax instead of stripping it as page content', async () => {
  assert.equal(buildTavilySearchRequest({ query: 'C# async tutorial' }, {}).body.query, 'C# async tutorial');
  assert.equal(buildTavilySearchRequest({ query: '__init__ method' }, {}).body.query, '__init__ method');
  assert.equal(buildTavilySearchRequest({ query: 'a <b> c *d* `e`' }, {}).body.query, 'a <b> c *d* `e`');
  const controlled = buildTavilySearchRequest({ query: `weird${String.fromCharCode(1)}query${String.fromCharCode(127)}text` }, {}).body.query;
  assert.equal(controlled, 'weird query text');
  const long = buildTavilySearchRequest({ query: 'q'.repeat(600) }, {}).body.query;
  assert.equal(long.length, 500);
  assert.doesNotMatch(long, /\.\.\.$/);
  });
  await scenario('supports current Tavily depth, exact-date, and country contracts', async () => {
  const request = buildTavilySearchRequest({
    query: 'release',
    start_date: '2026-07-01',
    end_date: '2026-07-20',
    country: 'china',
  }, {
    tavilySearchDepth: 'fast',
  });

  assert.equal(request.ok, true);
  assert.equal(request.body.search_depth, 'fast');
  assert.equal(request.body.start_date, '2026-07-01');
  assert.equal(request.body.end_date, '2026-07-20');
  assert.equal(request.body.country, 'china');
  assert.equal(request.body.chunks_per_source, undefined);
  assert.equal(buildTavilySearchRequest({
    query: 'release',
    start_date: '2026-07-20',
    end_date: '2026-07-01',
  }).error, 'Search start_date must not be after end_date.');
  });
});

test('Tavily response formatting and provider errors', async () => {
  await scenario('formats Tavily results as compact model-readable snippets', async () => {
  const response = normalizeTavilySearchResponse(
    {
      answer: '**Answer** with [link](https://example.com)',
      results: [
        {
          title: '<b>Title</b>',
          url: 'https://example.com/a',
          content: 'Text with **markdown** and <script>bad()</script> HTML.',
          published_date: '2026-05-20',
          raw_content: 'SHOULD NOT APPEAR',
          favicon: 'https://example.com/favicon.ico',
          score: 0.9,
        },
      ],
    },
    {
      normalized: {
        query: 'query',
        maxResults: 5,
      },
    },
  );

  assert.match(response.content, /Web search results for: query/);
  assert.match(response.content, /Source 1: Title/);
  assert.match(response.content, /URL: https:\/\/example\.com\/a/);
  assert.match(response.content, /Date: 2026-05-20/);
  assert.match(response.content, /Score: 0\.9/);
  assert.match(response.content, /Text with markdown and HTML/);
  assert.doesNotMatch(response.content, /raw_content|SHOULD NOT APPEAR|favicon|<script>|\*\*/);
  });
  await scenario('preserves every source before allocating page-enrichment text', async () => {
  const results = Array.from({ length: 5 }, (_, index) => ({
    index: index + 1,
    title: `Source ${index + 1}`,
    url: `https://example.com/${index + 1}`,
    publishedDate: '2026-07-20',
    score: 1,
    snippet: 'S'.repeat(650),
    page: index === 0 ? { title: 'Opened', markdown: 'P'.repeat(5000), links: [], matches: [], error: '', weak: true } : undefined,
  }));
  const content = formatTavilySearchResult({ query: 'query', results }, {
    tavilyResultMaxChars: 6000,
    firecrawlPageMaxChars: 5000,
  });

  assert.equal(content.length <= 6000, true);
  for (let index = 1; index <= 5; index += 1) {
    assert.match(content, new RegExp(`Source ${index}:`));
    assert.match(content, new RegExp(`https://example\\.com/${index}`));
  }
  assert.match(content, /Opened page excerpt:/);
  assert.match(content, /Opened page note: Page text appears incomplete/);
  assert.doesNotMatch(content, /include each relevant source title and URL/);
  });
  await scenario('uses matches instead of repeating auto-opened page markdown', async () => {
  const content = formatTavilySearchResult({
    query: 'query',
    results: [{
      index: 1,
      title: 'Source',
      url: 'https://example.com/source',
      snippet: 'Search snippet.',
      page: {
        title: 'Opened Source',
        summary: 'Concise page summary.',
        matches: ['Directly relevant opened-page match.'],
        markdown: 'FULL_MARKDOWN_SHOULD_NOT_BE_INCLUDED '.repeat(100),
        links: [],
      },
    }],
  }, { tavilyResultMaxChars: 6000, firecrawlPageMaxChars: 5000 });

  assert.match(content, /Opened page summary: Concise page summary/);
  assert.match(content, /Opened page matches:/);
  assert.match(content, /Directly relevant opened-page match/);
  assert.doesNotMatch(content, /Opened page excerpt:/);
  assert.doesNotMatch(content, /FULL_MARKDOWN_SHOULD_NOT_BE_INCLUDED/);
  });
  await scenario('limits auto-opened page fallback excerpts independently of explicit page reads', async () => {
  const content = formatTavilySearchResult({
    query: 'query',
    results: [{
      index: 1,
      title: 'Source',
      url: 'https://example.com/source',
      snippet: 'Search snippet.',
      page: { markdown: `START ${'P'.repeat(5000)} END`, matches: [], links: [] },
    }],
  }, {
    tavilyResultMaxChars: 6000,
    firecrawlPageMaxChars: 5000,
  });

  assert.match(content, /Opened page excerpt:/);
  assert.match(content, /START/);
  assert.doesNotMatch(content, / END/);
  assert.equal(content.length < 2000, true);
  });
  await scenario('formats Tavily search errors without throwing raw payloads at the model', async () => {
  const content = formatTavilySearchResult({
    query: 'query',
    error: '<b>rate limited</b>\n\n```json\n{\"x\":1}\n```',
  });

  assert.match(content, /Search error: rate limited/);
  assert.doesNotMatch(content, /```|<b>/);
  });
  await scenario('includes concise search status lines inside the result budget', async () => {
  const content = formatTavilySearchResult({
    query: 'query',
    status: [
      'Opened page evidence from 1 search result.',
      'Page read limit reached; remaining search candidates are snippets only.',
    ],
    results: [{ index: 1, title: 'Source', url: 'https://example.com/a', snippet: 'Snippet evidence.' }],
  }, { tavilyResultMaxChars: 1000 });

  assert.match(content, /Search status: Opened page evidence from 1 search result/);
  assert.match(content, /Search status: Page read limit reached/);
  assert.equal(content.length <= 1000, true);
  });
  await scenario('executes Tavily requests and normalizes provider errors', async () => {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({
      authorization: req.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
    });
    if (requests.at(-1).body.query === 'success') {
      res.writeHead(200, { 'content-type': 'application/json', 'x-request-id': 'header-id' });
      res.end(JSON.stringify({
        results: [],
        request_id: 'request-id',
        response_time: 1.25,
        usage: { credits: 1 },
      }));
      return;
    }
    if (requests.at(-1).body.query === 'detail error') {
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ detail: { error: 'Monthly limit exceeded' } }));
      return;
    }
    res.writeHead(503, { 'content-type': 'text/plain' });
    res.end('temporarily unavailable');
  });
  const baseUrl = await listen(server);

  try {
    const missing = await callTavilySearch({ args: {}, config: { tavilyBaseUrl: baseUrl, tavilyApiKey: 'key' } });
    assert.equal(missing.error, 'Missing search query.');
    assert.equal(requests.length, 0);

    const failed = await callTavilySearch({
      args: { query: 'latest release' },
      config: { tavilyBaseUrl: baseUrl, tavilyApiKey: 'key' },
    });
    assert.equal(failed.status, 503);
    assert.equal(failed.error, 'temporarily unavailable');
    assert.match(failed.content, /Search error: temporarily unavailable/);
    assert.equal(requests[0].authorization, 'Bearer key');
    assert.equal(requests[0].body.include_raw_content, false);
    assert.equal(requests[0].body.include_usage, true);

    const detailError = await callTavilySearch({
      args: { query: 'detail error' },
      config: { tavilyBaseUrl: baseUrl, tavilyApiKey: 'key' },
    });
    assert.equal(detailError.status, 429);
    assert.equal(detailError.error, 'Monthly limit exceeded');

    const succeeded = await callTavilySearch({
      args: { query: 'success' },
      config: { tavilyBaseUrl: baseUrl, tavilyApiKey: 'key' },
    });
    assert.equal(succeeded.diagnostic.requestId, 'request-id');
    assert.equal(succeeded.diagnostic.responseTimeMs, 1250);
    assert.deepEqual(succeeded.diagnostic.usage, { credits: 1 });
  } finally {
    await close(server);
  }
  });
});
