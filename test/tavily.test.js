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
  assert.equal(request.body.search_depth, 'advanced');
  assert.equal(request.body.max_results, 4);
  assert.equal(request.body.include_raw_content, false);
  assert.deepEqual(request.body.include_domains, ['openai.com', 'developers.openai.com']);
  assert.deepEqual(request.body.exclude_domains, ['example.com', 'spam.test']);
  assert.equal(request.body.time_range, 'week');
  });
  await scenario('accepts Codex-style web_search search argument', async () => {
  const request = buildTavilySearchRequest({ search: 'crude oil price today' }, { tavilyMaxResults: 5 });
  assert.equal(request.ok, true);
  assert.equal(request.body.query, 'crude oil price today');
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

  assert.match(response.content, /Search query: query/);
  assert.match(response.content, /Source 1: Title/);
  assert.match(response.content, /URL: https:\/\/example\.com\/a/);
  assert.match(response.content, /Date: 2026-05-20/);
  assert.match(response.content, /Score: 0\.9/);
  assert.match(response.content, /Text with markdown and HTML/);
  assert.doesNotMatch(response.content, /raw_content|SHOULD NOT APPEAR|favicon|<script>|\*\*/);
  });
  await scenario('formats Tavily search errors without throwing raw payloads at the model', async () => {
  const content = formatTavilySearchResult({
    query: 'query',
    error: '<b>rate limited</b>\n\n```json\n{\"x\":1}\n```',
  });

  assert.match(content, /Search error: rate limited/);
  assert.doesNotMatch(content, /```|<b>/);
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
  } finally {
    await close(server);
  }
  });
});
