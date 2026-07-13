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
  buildFirecrawlScrapeRequest,
  callFirecrawlScrape,
  normalizeFirecrawlScrapeResponse,
  normalizeFirecrawlUrl,
} from '../src/firecrawl.js';

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test('Firecrawl request and URL safety', async () => {
  await scenario('builds Firecrawl scrape request with safe LLM defaults', async () => {
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
  await scenario('rejects private Firecrawl URLs by default', async () => {
  assert.equal(normalizeFirecrawlUrl('http://127.0.0.1:8080/a').ok, false);
  assert.equal(normalizeFirecrawlUrl('http://localhost/a').ok, false);
  assert.equal(normalizeFirecrawlUrl('http://169.254.169.254/latest/meta-data').ok, false);
  assert.equal(normalizeFirecrawlUrl('http://[fc00::1]/a').ok, false);
  assert.equal(normalizeFirecrawlUrl('http://[fd12::1]/a').ok, false);
  assert.equal(normalizeFirecrawlUrl('file:///etc/passwd').ok, false);
  });
  await scenario('allows public hostnames that begin with IPv6 private-range text', async () => {
  assert.equal(normalizeFirecrawlUrl('https://fda.gov/a').ok, true);
  assert.equal(normalizeFirecrawlUrl('https://fc.example.com/a').ok, true);
  });
});

test('Firecrawl response and provider errors', async () => {
  await scenario('formats Firecrawl response as compact model-readable page text', async () => {
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
  assert.match(response.content, /Link 1: Docs/);
  assert.match(response.content, /include the page title and URL/);
  assert.doesNotMatch(response.content, /source number|Assigned source/i);
  assert.doesNotMatch(response.content, /localhost|<b>|\*\*/);
  });
  await scenario('executes Firecrawl requests and returns safe validation and provider errors', async () => {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({
      authorization: req.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
    });
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: '<b>fetch failed</b>' } }));
  });
  const baseUrl = await listen(server);

  try {
    const blocked = await callFirecrawlScrape({
      args: { url: 'http://127.0.0.1/private' },
      config: { firecrawlBaseUrl: baseUrl, firecrawlApiKey: 'key' },
    });
    assert.equal(blocked.error, 'Private, local, or metadata URLs cannot be fetched.');
    assert.equal(requests.length, 0);

    const failed = await callFirecrawlScrape({
      args: { url: 'https://example.com/page' },
      config: { firecrawlBaseUrl: baseUrl, firecrawlApiKey: 'key' },
    });
    assert.equal(failed.status, 502);
    assert.equal(failed.error, 'fetch failed');
    assert.match(failed.content, /Fetch error: fetch failed/);
    assert.doesNotMatch(failed.content, /<b>/);
    assert.equal(requests[0].authorization, 'Bearer key');
    assert.equal(requests[0].body.url, 'https://example.com/page');
    assert.equal(requests[0].body.onlyMainContent, true);
  } finally {
    await close(server);
  }
  });
});
