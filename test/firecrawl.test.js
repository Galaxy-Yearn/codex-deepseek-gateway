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
  findFirecrawlMatches,
  formatFirecrawlScrapeResult,
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
      formats: ['markdown', 'changeTracking'],
    },
    { firecrawlTimeoutMs: 45000, firecrawlIncludeLinks: true },
  );

  assert.equal(request.ok, true);
  assert.equal(request.body.url, 'https://example.com/page');
  assert.deepEqual(request.body.formats, ['markdown', 'links', 'summary']);
  assert.equal(request.body.onlyMainContent, true);
  assert.equal(request.body.removeBase64Images, true);
  assert.equal(request.body.timeout, 45000);
  assert.equal(request.body.maxAge, 172800000);
  assert.equal(request.body.storeInCache, true);
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
  await scenario('preserves find_in_page query syntax instead of stripping it as page content', async () => {
  const request = buildFirecrawlScrapeRequest({ url: 'https://example.com/page', query: 'C# async_tutorial #wow' }, {});
  assert.equal(request.ok, true);
  assert.equal(request.normalized.query, 'C# async_tutorial #wow');
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
  assert.doesNotMatch(response.content, /source number|Assigned source/i);
  assert.doesNotMatch(response.content, /localhost|<b>|\*\*/);
  assert.match(formatFirecrawlScrapeResult({
    url: 'https://example.com/direct',
    title: 'Direct page',
    markdown: 'Direct body',
  }), /Opened page: https:\/\/example\.com\/direct[\s\S]*Page text excerpt:[\s\S]*Direct body/);
  assert.match(formatFirecrawlScrapeResult({
    url: 'https://example.com/weak',
    title: 'Weak page',
    markdown: 'Skip to main content',
    weak: true,
  }), /Page note: Page text appears incomplete/);
  });
  await scenario('finds query matches after the returned page excerpt cutoff', async () => {
  const response = normalizeFirecrawlScrapeResponse(
    {
      data: {
        markdown: `${'A'.repeat(6000)}\n\nThe unique tail needle appears in this sufficiently long paragraph after the old cutoff.`,
        metadata: { sourceURL: 'https://example.com/page' },
      },
    },
    {
      normalized: {
        url: 'https://example.com/page',
        query: 'unique tail needle',
        maxChars: 5000,
        maxLinks: 0,
        findOnly: true,
      },
    },
  );

  assert.equal(response.markdown.length, 5000);
  assert.deepEqual(response.matches, ['The unique tail needle appears in this sufficiently long paragraph after the old cutoff.']);
  assert.match(response.content, /Relevant page matches:[\s\S]*unique tail needle/);
  assert.doesNotMatch(response.content, /Page text excerpt:/);
  assert.doesNotMatch(response.content, /Matches were searched within the first/);
  });
  await scenario('finds query matches after 700 characters within the same paragraph', async () => {
  const response = normalizeFirecrawlScrapeResponse(
    {
      data: {
        markdown: `${'A'.repeat(760)} targetphrase appears in the same long paragraph after the old per-paragraph cutoff and remains relevant enough to return.`,
        metadata: { sourceURL: 'https://example.com/page' },
      },
    },
    {
      normalized: {
        url: 'https://example.com/page',
        query: 'targetphrase',
        maxChars: 5000,
        maxLinks: 0,
        findOnly: true,
      },
    },
  );

  assert.equal(response.matches.length, 1);
  assert.match(response.matches[0], /targetphrase/);
  assert.match(response.content, /Relevant page matches:[\s\S]*targetphrase/);
  });
  await scenario('finds continuous Chinese find-in-page terms', async () => {
  const response = normalizeFirecrawlScrapeResponse(
    {
      data: {
        markdown: `${'前文'.repeat(260)}目标短语出现在同一个中文长段落的靠后位置。后续内容继续说明这个目标短语为什么相关。`,
        metadata: { sourceURL: 'https://example.com/page' },
      },
    },
    {
      normalized: {
        url: 'https://example.com/page',
        query: '目标短语',
        maxChars: 5000,
        maxLinks: 0,
        findOnly: true,
      },
    },
  );

  assert.equal(response.matches.length, 1);
  assert.match(response.matches[0], /目标短语/);
  });
  await scenario('requires sufficient page evidence while preserving distributed relevant paragraphs', async () => {
  assert.deepEqual(
    findFirecrawlMatches(
      'The 2026 federal holiday calendar lists vacation dates and government closures for travelers.',
      '2026 FIFA World Cup final result winner',
    ),
    [],
  );
  const distributed = findFirecrawlMatches(
    'Alpha appears in this first sufficiently long evidence paragraph with supporting context.\n\nBeta appears in this second sufficiently long evidence paragraph with different supporting context.',
    'alpha beta gamma delta',
  );
  assert.equal(distributed.length, 2);
  assert.match(distributed[0], /Alpha|Beta/);
  });
  await scenario('still matches find_in_page queries that contain markdown-like syntax', async () => {
  const response = normalizeFirecrawlScrapeResponse(
    {
      data: {
        markdown: 'This walkthrough is a C# async_tutorial #wow that explains cancellation tokens in depth for beginners.',
        metadata: { sourceURL: 'https://example.com/page' },
      },
    },
    {
      normalized: {
        url: 'https://example.com/page',
        query: 'C# async_tutorial #wow',
        maxChars: 5000,
        maxLinks: 0,
        findOnly: true,
      },
    },
  );

  assert.match(response.content, /Find in page query: C# async_tutorial #wow/);
  assert.equal(response.matches.length, 1);
  assert.match(response.content, /Relevant page matches:/);
  });
  await scenario('discloses find_in_page truncation only when the page text exceeds the search cutoff', async () => {
  const longMarkdown = `${'A'.repeat(31000)}\n\nThe unreachable needle sits past the thirty thousand character search cutoff in this long enough paragraph.`;

  const truncatedResponse = normalizeFirecrawlScrapeResponse(
    {
      data: {
        markdown: longMarkdown,
        metadata: { sourceURL: 'https://example.com/page' },
      },
    },
    {
      normalized: {
        url: 'https://example.com/page',
        query: 'unreachable needle',
        maxChars: 5000,
        maxLinks: 0,
        findOnly: true,
      },
    },
  );
  assert.equal(truncatedResponse.matches.length, 0);
  assert.match(truncatedResponse.content, /Matches were searched within the first 30000 characters of the page text\./);

  const shortResponse = normalizeFirecrawlScrapeResponse(
    {
      data: {
        markdown: 'A short page with only a few words of body text here.',
        metadata: { sourceURL: 'https://example.com/page' },
      },
    },
    {
      normalized: {
        url: 'https://example.com/page',
        query: 'few words',
        maxChars: 5000,
        maxLinks: 0,
        findOnly: true,
      },
    },
  );
  assert.doesNotMatch(shortResponse.content, /Matches were searched within the first/);

  const nonFindResponse = normalizeFirecrawlScrapeResponse(
    {
      data: {
        markdown: longMarkdown,
        metadata: { sourceURL: 'https://example.com/page' },
      },
    },
    {
      normalized: {
        url: 'https://example.com/page',
        query: '',
        maxChars: 5000,
        maxLinks: 0,
        findOnly: false,
      },
    },
  );
  assert.doesNotMatch(nonFindResponse.content, /Matches were searched within the first/);
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
    if (requests.at(-1).body.url.endsWith('/forbidden')) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'blocked' } }));
      return;
    }
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

    const forbidden = await callFirecrawlScrape({
      args: { url: 'https://example.com/forbidden' },
      config: { firecrawlBaseUrl: baseUrl, firecrawlApiKey: 'key' },
    });
    assert.equal(forbidden.status, 403);
    assert.match(forbidden.error, /search limited to the same domain/);
    assert.match(forbidden.content, /use the search snippets/);
  } finally {
    await close(server);
  }
  });
  await scenario('retries weak successful page text once with waitFor and fresh cache', async () => {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push(body);
    res.writeHead(200, { 'content-type': 'application/json' });
    if (requests.length === 1) {
      res.end(JSON.stringify({
        data: {
          markdown: 'Skip to main content (https://example.com/page main-content)',
          metadata: { title: 'Thin page', sourceURL: body.url },
        },
      }));
      return;
    }
    res.end(JSON.stringify({
      data: {
        markdown: 'Actual article text about important topic with enough detail to be useful after waiting for dynamic content.',
        metadata: { title: 'Full page', sourceURL: body.url, description: 'Useful summary.' },
      },
    }));
  });
  const baseUrl = await listen(server);

  try {
    const result = await callFirecrawlScrape({
      args: { url: 'https://example.com/page', query: 'important topic' },
      config: { firecrawlBaseUrl: baseUrl, firecrawlApiKey: 'key' },
    });

    assert.equal(requests.length, 2);
    assert.equal(requests[0].waitFor, undefined);
    assert.equal(requests[0].maxAge, 172800000);
    assert.equal(requests[1].waitFor, 3000);
    assert.equal(requests[1].maxAge, 0);
    assert.equal(result.title, 'Full page');
    assert.equal(result.weak, false);
    assert.equal(result.diagnostic.weakTextRetry, true);
    assert.match(result.content, /Actual article text about important topic/);
    assert.doesNotMatch(result.content, /Page note: Page text appears incomplete/);
  } finally {
    await close(server);
  }
  });
});
