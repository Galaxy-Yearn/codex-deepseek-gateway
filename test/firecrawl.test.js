import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildFirecrawlScrapeRequest,
  normalizeFirecrawlScrapeResponse,
  normalizeFirecrawlUrl,
} from '../src/firecrawl.js';

test('builds Firecrawl scrape request with safe LLM defaults', () => {
  const request = buildFirecrawlScrapeRequest(
    {
      url: 'https://example.com/page#section',
      query: 'release notes',
      max_chars: 9000,
      include_summary: true,
    },
    { firecrawlTimeoutMs: 45000, firecrawlIncludeLinks: true },
  );

  assert.equal(request.ok, true);
  assert.equal(request.body.url, 'https://example.com/page');
  assert.deepEqual(request.body.formats, ['markdown', 'links', 'summary']);
  assert.equal(request.body.onlyMainContent, true);
  assert.equal(request.body.removeBase64Images, true);
  assert.equal(request.body.timeout, 45000);
  assert.equal(request.normalized.query, 'release notes');
  assert.equal(request.normalized.maxChars, 9000);
});

test('rejects private Firecrawl URLs by default', () => {
  assert.equal(normalizeFirecrawlUrl('http://127.0.0.1:8080/a').ok, false);
  assert.equal(normalizeFirecrawlUrl('http://localhost/a').ok, false);
  assert.equal(normalizeFirecrawlUrl('http://169.254.169.254/latest/meta-data').ok, false);
  assert.equal(normalizeFirecrawlUrl('file:///etc/passwd').ok, false);
});

test('formats Firecrawl response as compact model-readable page text', () => {
  const response = normalizeFirecrawlScrapeResponse(
    {
      data: {
        markdown: '# Heading\n\nRelease notes mention DeepSeek gateway and Firecrawl support.',
        links: [
          { title: 'Docs', url: 'https://example.com/docs' },
          { title: 'Local', url: 'http://localhost/private' },
        ],
        metadata: {
          title: '<b>Page Title</b>',
          sourceURL: 'https://example.com/page',
          description: '**Summary** with [link](https://example.com)',
        },
      },
    },
    {
      normalized: {
        url: 'https://example.com/page',
        query: 'Firecrawl support',
        maxChars: 5000,
        maxLinks: 5,
      },
    },
  );

  assert.equal(response.url, 'https://example.com/page');
  assert.equal(response.title, 'Page Title');
  assert.equal(response.links.length, 1);
  assert.match(response.content, /Opened page: https:\/\/example\.com\/page/);
  assert.match(response.content, /Find in page query: Firecrawl support/);
  assert.match(response.content, /Relevant page matches:/);
  assert.match(response.content, /Page text excerpt:/);
  assert.doesNotMatch(response.content, /localhost|<b>|\*\*/);
});
