import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildTavilySearchRequest,
  formatTavilySearchResult,
  normalizeTavilySearchResponse,
} from '../src/tavily.js';

test('builds Tavily search request without raw content', () => {
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

test('accepts Codex-style web_search search argument', () => {
  const request = buildTavilySearchRequest({ search: 'crude oil price today' }, { tavilyMaxResults: 5 });
  assert.equal(request.ok, true);
  assert.equal(request.body.query, 'crude oil price today');
});

test('formats Tavily results as compact model-readable snippets', () => {
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

test('formats Tavily search errors without throwing raw payloads at the model', () => {
  const content = formatTavilySearchResult({
    query: 'query',
    error: '<b>rate limited</b>\n\n```json\n{\"x\":1}\n```',
  });

  assert.match(content, /Search error: rate limited/);
  assert.doesNotMatch(content, /```|<b>/);
});
