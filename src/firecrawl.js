import { isIP } from 'node:net';
import { isObject, joinUrl, normalizeSearchQuery, parseBoolean, safeJsonParse } from './common.js';
import { webEvidenceHitCount, webEvidenceRequiredHits, webEvidenceTerms } from './web-search-relevance.js';

const DEFAULT_TOTAL_CHARS = 20000;
const DEFAULT_PAGE_CHARS = 10000;
const HARD_MAX_CHARS = 30000;
const HARD_MAX_TOTAL_CHARS = 100000;
const DEFAULT_MAX_LINKS = 20;
const HARD_MAX_LINKS = 50;
const DEFAULT_MAX_AGE_MS = 172800000;
const HARD_MAX_AGE_MS = 2592000000;
const WEAK_MARKDOWN_CHARS = 500;
const WEAK_RETRY_WAIT_FOR_MS = 3000;
const INCOMPLETE_PAGE_TEXT_NOTICE = 'Page text appears incomplete; use search snippets or a domain-limited search if more detail is needed.';
const WEAK_PAGE_PATTERNS = [
  'skip to main content',
  'enable javascript',
  'please enable javascript',
  'checking your browser',
  'just a moment',
  'access denied',
];
const PRIVATE_IPV4_RANGES = [
  [0x00000000, 0x00ffffff],
  [0x0a000000, 0x0affffff],
  [0x64400000, 0x647fffff],
  [0x7f000000, 0x7fffffff],
  [0xa9fe0000, 0xa9feffff],
  [0xac100000, 0xac1fffff],
  [0xc0000000, 0xc00000ff],
  [0xc0000200, 0xc00002ff],
  [0xc0a80000, 0xc0a8ffff],
  [0xc6336400, 0xc63364ff],
  [0xcb007100, 0xcb0071ff],
  [0xe0000000, 0xffffffff],
];

function clampInteger(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}

function clipText(value, maxChars) {
  const text = String(value || '').trim();
  if (!maxChars || text.length <= maxChars) return text;
  if (maxChars <= 3) return '.'.repeat(maxChars);
  const prefix = text.slice(0, maxChars - 3);
  const boundary = Math.max(prefix.lastIndexOf('\n\n'), prefix.lastIndexOf('. '), prefix.lastIndexOf(' '));
  const clipped = boundary >= Math.floor(maxChars * 0.55) ? prefix.slice(0, boundary) : prefix;
  return `${clipped.trimEnd()}...`;
}

function cleanText(value, maxChars = DEFAULT_PAGE_CHARS) {
  if (value == null) return '';
  const text = String(value)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '$1 ($2)')
    .replace(/[`*_~>#]+/g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return clipText(text, maxChars);
}

function cleanLine(value, maxChars = 300) {
  return cleanText(value, maxChars).replace(/\s+/g, ' ').trim();
}

function normalizedHostname(hostname) {
  return String(hostname || '').trim().replace(/^\[|\]$/g, '').toLowerCase();
}

function ipv4ToNumber(hostname) {
  const parts = normalizedHostname(hostname).split('.');
  if (parts.length !== 4) return null;
  let number = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const byte = Number(part);
    if (byte < 0 || byte > 255) return null;
    number = (number << 8) + byte;
  }
  return number >>> 0;
}

function isPrivateIpv4(hostname) {
  const number = ipv4ToNumber(hostname);
  if (number == null) return false;
  return PRIVATE_IPV4_RANGES.some(([start, end]) => number >= start && number <= end);
}

function isPrivateIpv6(hostname) {
  const host = normalizedHostname(hostname);
  if (isIP(host) !== 6) return false;
  return host === '::1' || host === '0:0:0:0:0:0:0:1' || host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd');
}

function isBlockedHostname(hostname, config = {}) {
  const host = normalizedHostname(hostname);
  if (!host) return true;
  const allowLocal = parseBoolean(config.firecrawlAllowPrivateUrls, false);
  if (allowLocal) return false;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === 'metadata.google.internal') return true;
  return isPrivateIpv4(host) || isPrivateIpv6(host);
}

export function normalizeFirecrawlUrl(value, config = {}) {
  const raw = String(value || '').trim();
  if (!raw) return { ok: false, error: 'Missing URL.' };
  let url;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: 'Invalid URL.' };
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    return { ok: false, error: 'Only http and https URLs can be fetched.' };
  }
  if (isBlockedHostname(url.hostname, config)) {
    return { ok: false, error: 'Private, local, or metadata URLs cannot be fetched.' };
  }
  url.hash = '';
  return { ok: true, url: url.toString() };
}

function normalizeStringList(value, maxItems = HARD_MAX_LINKS) {
  const raw = Array.isArray(value)
    ? value
    : typeof value === 'string'
    ? value.split(',')
    : [];
  return raw
    .map((item) => String(item ?? '').trim())
    .filter(Boolean)
    .slice(0, maxItems);
}

function normalizeFormats(args = {}, config = {}) {
  const formats = normalizeStringList(args.formats ?? args.format ?? config.firecrawlFormats, 8)
    .map((format) => format.toLowerCase())
    .filter((format) => ['markdown', 'links', 'summary'].includes(format));
  if (!formats.includes('markdown')) formats.unshift('markdown');
  if (parseBoolean(args.include_links ?? args.includeLinks ?? config.firecrawlIncludeLinks, true) && !formats.includes('links')) {
    formats.push('links');
  }
  if (parseBoolean(args.include_summary ?? args.includeSummary ?? config.firecrawlIncludeSummary, false) && !formats.includes('summary')) {
    formats.push('summary');
  }
  return [...new Set(formats)];
}

function pickString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function normalizeLocation(source, config) {
  const rawLocation = isObject(source.location) ? source.location : {};
  const country = pickString(rawLocation.country, source.country, config.firecrawlCountry).toUpperCase();
  const languages = normalizeStringList(rawLocation.languages ?? source.languages ?? config.firecrawlLanguages, 8);
  if (!/^[A-Z]{2}$/.test(country) && !languages.length) return undefined;
  const location = {};
  if (/^[A-Z]{2}$/.test(country)) location.country = country;
  if (languages.length) location.languages = languages;
  return location;
}

export function buildFirecrawlScrapeRequest(args = {}, config = {}) {
  const source = isObject(args) ? args : { url: String(args ?? '') };
  const normalizedUrl = normalizeFirecrawlUrl(source.url ?? source.link ?? source.href ?? source.input, config);
  if (!normalizedUrl.ok) return normalizedUrl;

  const maxChars = clampInteger(
    source.max_chars ?? source.maxChars ?? config.firecrawlPageMaxChars,
    500,
    HARD_MAX_CHARS,
    DEFAULT_PAGE_CHARS,
  );
  const maxLinks = clampInteger(
    source.max_links ?? source.maxLinks ?? config.firecrawlMaxLinks,
    0,
    HARD_MAX_LINKS,
    DEFAULT_MAX_LINKS,
  );
  const body = {
    url: normalizedUrl.url,
    formats: normalizeFormats(source, config),
    onlyMainContent: parseBoolean(source.only_main_content ?? source.onlyMainContent ?? config.firecrawlOnlyMainContent, true),
    removeBase64Images: parseBoolean(source.remove_base64_images ?? source.removeBase64Images ?? config.firecrawlRemoveBase64Images, true),
    waitFor: clampInteger(source.wait_for ?? source.waitFor ?? config.firecrawlWaitForMs, 0, 10000, 0),
    timeout: clampInteger(source.timeout ?? config.firecrawlTimeoutMs, 1000, 120000, 30000),
    maxAge: clampInteger(source.max_age ?? source.maxAge ?? config.firecrawlMaxAgeMs, 0, HARD_MAX_AGE_MS, DEFAULT_MAX_AGE_MS),
    storeInCache: parseBoolean(source.store_in_cache ?? source.storeInCache ?? config.firecrawlStoreInCache, true),
  };
  if (!body.waitFor) delete body.waitFor;
  const mobile = source.mobile ?? config.firecrawlMobile;
  if (mobile !== undefined && mobile !== '') body.mobile = parseBoolean(mobile, false);
  const location = normalizeLocation(source, config);
  if (location) body.location = location;

  return {
    ok: true,
    normalized: {
      url: normalizedUrl.url,
      query: normalizeSearchQuery(pickString(source.query, source.q, source.find, source.find_in_page, source.question), 500),
      maxChars,
      maxLinks,
      findOnly: parseBoolean(source.find_only ?? source.findOnly, false),
    },
    body,
  };
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value == null) return [];
  return [value];
}

function normalizeLinks(value, maxLinks, config = {}) {
  return asArray(value)
    .map((link) => {
      const raw = isObject(link) ? link.url ?? link.href ?? link.link : link;
      const normalized = normalizeFirecrawlUrl(raw, config);
      if (!normalized.ok) return null;
      const title = isObject(link) ? cleanLine(link.title ?? link.text ?? link.name, 180) : '';
      return { url: normalized.url, title };
    })
    .filter(Boolean)
    .slice(0, maxLinks);
}

function weakFirecrawlDocument(document) {
  const text = cleanLine(document?.markdown, 0);
  if (text.length >= WEAK_MARKDOWN_CHARS) return false;
  if (!text) return true;
  const lower = text.toLowerCase();
  if (WEAK_PAGE_PATTERNS.some((pattern) => lower.includes(pattern))) return true;
  return false;
}

function firstStringFromObject(object, keys) {
  if (!isObject(object)) return '';
  for (const key of keys) {
    const value = object[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function matchPosition(text, exact, terms) {
  const lower = text.toLowerCase();
  const exactIndex = exact ? lower.indexOf(exact) : -1;
  if (exactIndex >= 0) return exactIndex;
  let index = -1;
  for (const term of terms) {
    const found = lower.indexOf(term);
    if (found >= 0 && (index < 0 || found < index)) index = found;
  }
  return index;
}

function clipMatchWindow(text, position, maxChars = 700) {
  if (text.length <= maxChars) return text;
  const start = position <= Math.floor(maxChars * 0.6) ? 0 : Math.max(0, position - Math.floor(maxChars * 0.35));
  const end = Math.min(text.length, start + maxChars);
  const prefix = start > 0 ? '...' : '';
  const suffix = end < text.length ? '...' : '';
  return `${prefix}${text.slice(start, end).trim()}${suffix}`;
}

export function findFirecrawlMatches(markdown, query, maxMatches = 4) {
  const terms = webEvidenceTerms(query);
  if (!terms.length || !markdown) return [];
  const exact = cleanLine(query, 500).toLowerCase();
  const requiredHits = webEvidenceRequiredHits(terms);
  const pageHits = webEvidenceHitCount(markdown, terms);
  const paragraphs = String(markdown)
    .split(/\n{2,}|(?<=[.!?])\s+|(?<=[。！？])/)
    .map((part, index) => ({ index, text: cleanLine(part, 0) }))
    .filter((part) => part.text.length >= 40);
  const scored = paragraphs
    .map(({ index, text }) => {
      const lower = text.toLowerCase();
      const hits = webEvidenceHitCount(lower, terms);
      const exactMatch = Boolean(exact && lower.includes(exact));
      const position = matchPosition(text, exact, terms);
      return { index, text: clipMatchWindow(text, position), hits, exactMatch, score: hits * 10 + (exactMatch ? 25 : 0) };
    })
    .filter((item) => item.hits > 0);
  const strong = scored.filter((item) => item.exactMatch || item.hits >= requiredHits);
  const matches = (strong.length ? strong : pageHits >= requiredHits ? scored : [])
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, maxMatches)
    .map((item) => item.text);
  return [...new Set(matches)];
}

function extractData(data) {
  return isObject(data?.data) ? data.data : data;
}

function normalizeFirecrawlDocument(data, request, config = {}) {
  const payload = extractData(data);
  const metadata = isObject(payload?.metadata) ? payload.metadata : {};
  const fullMarkdown = cleanText(
    firstStringFromObject(payload, ['markdown', 'content', 'text']) ||
      firstStringFromObject(data, ['markdown', 'content', 'text']),
    0,
  );
  const truncated = fullMarkdown.length > HARD_MAX_CHARS;
  const markdown = truncated ? clipText(fullMarkdown, HARD_MAX_CHARS) : fullMarkdown;
  const summary = cleanText(
    firstStringFromObject(payload, ['summary', 'description']) ||
      firstStringFromObject(metadata, ['description', 'ogDescription', 'twitterDescription']),
    1200,
  );
  const title =
    cleanLine(firstStringFromObject(metadata, ['title', 'ogTitle', 'twitterTitle']) || firstStringFromObject(payload, ['title']), 180) ||
    request.normalized.url;
  const sourceUrl = normalizeFirecrawlUrl(
    firstStringFromObject(metadata, ['sourceURL', 'url']) || firstStringFromObject(payload, ['url']) || request.normalized.url,
    config,
  );
  const document = {
    url: sourceUrl.ok ? sourceUrl.url : request.normalized.url,
    title,
    summary,
    markdown,
    truncated,
    links: normalizeLinks(payload?.links ?? data?.links, HARD_MAX_LINKS, config),
  };
  return {
    ...document,
    weak: weakFirecrawlDocument(document),
  };
}

function appendLineWithin(lines, suffix, line, maxChars, minimumChars = 12) {
  const base = [...lines, ...suffix].join('\n');
  const separator = lines.length ? 1 : 0;
  const available = maxChars - base.length - separator;
  if (available < minimumChars) return false;
  lines.push(clipText(line, available));
  return true;
}

function appendBlockWithin(lines, suffix, prefixLines, finalLine, maxChars, minimumFinalChars = 32) {
  const prefix = prefixLines.filter(Boolean);
  const base = [...lines, ...suffix].join('\n');
  const separator = lines.length ? 1 : 0;
  const prefixText = prefix.join('\n');
  const blockSeparator = prefix.length ? 1 : 0;
  const available = maxChars - base.length - separator - prefixText.length - blockSeparator;
  if (available < minimumFinalChars) return false;
  lines.push(...prefix, clipText(finalLine, available));
  return true;
}

export function formatFirecrawlScrapeResult({ url = '', title = '', summary = '', markdown = '', links = [], query = '', matches = [], error = '', findOnly = false, truncated = false, weak = false } = {}, config = {}) {
  const maxChars = clampInteger(config.firecrawlResultMaxChars, 500, HARD_MAX_TOTAL_CHARS, DEFAULT_TOTAL_CHARS);
  const suffix = [];
  const lines = [`Opened page: ${url || '(unknown)'}`];
  if (title) appendLineWithin(lines, suffix, `Title: ${cleanLine(title, 180)}`, maxChars);
  if (query) appendLineWithin(lines, suffix, `Find in page query: ${query}`, maxChars);
  if (error) {
    appendLineWithin(lines, suffix, `Fetch error: ${cleanLine(error, 600)}`, maxChars);
    return [...lines, ...suffix].join('\n');
  }

  if (summary) appendLineWithin(lines, suffix, `Page summary: ${cleanText(summary, 1200)}`, maxChars);
  if (weak) appendLineWithin(lines, suffix, `Page note: ${INCOMPLETE_PAGE_TEXT_NOTICE}`, maxChars);
  if (matches?.length) {
    for (const [index, match] of matches.entries()) {
      const prefix = index === 0 ? ['Relevant page matches:'] : [];
      if (!appendBlockWithin(lines, suffix, prefix, `- ${cleanText(match, 700)}`, maxChars)) break;
    }
  } else if (findOnly && query) {
    appendLineWithin(lines, suffix, 'No relevant page matches were found in the fetched text.', maxChars);
  }
  if (findOnly && query && truncated) {
    appendLineWithin(lines, suffix, `Matches were searched within the first ${HARD_MAX_CHARS} characters of the page text.`, maxChars);
  }
  if (markdown && !(findOnly && query)) {
    appendBlockWithin(lines, suffix, ['Page text excerpt:'], cleanText(markdown, Number(config.firecrawlPageMaxChars) || DEFAULT_PAGE_CHARS), maxChars, 48);
  } else if (!markdown) {
    appendLineWithin(lines, suffix, 'No useful page text was returned.', maxChars);
  }
  if (links?.length) {
    for (const [index, link] of links.entries()) {
      const prefix = [`Link ${index + 1}: ${cleanLine(link.title || link.url, 180)}`];
      if (!appendBlockWithin(lines, suffix, prefix, `URL: ${link.url}`, maxChars, 16)) break;
    }
  }
  return [...lines, ...suffix].join('\n');
}

export function renderFirecrawlDocument(document, normalized, config = {}) {
  const markdown = clipText(document.markdown, normalized.maxChars);
  const links = document.links.slice(0, normalized.maxLinks);
  const matches = findFirecrawlMatches(document.markdown, normalized.query);
  const payload = {
    url: document.url,
    title: document.title,
    summary: document.summary,
    markdown,
    links,
    query: normalized.query,
    matches,
    findOnly: normalized.findOnly,
    truncated: Boolean(document.truncated),
    weak: Boolean(document.weak),
  };
  return {
    ...payload,
    document,
    content: formatFirecrawlScrapeResult(payload, config),
  };
}

export function normalizeFirecrawlScrapeResponse(data, request, config = {}, diagnostic) {
  const document = normalizeFirecrawlDocument(data, request, config);
  return {
    ...renderFirecrawlDocument(document, request.normalized, config),
    diagnostic,
  };
}

function providerDiagnostic({ status, durationMs, data, response } = {}) {
  const retryAfterHeader = response?.headers?.get?.('retry-after');
  const retryAfter = retryAfterHeader == null || retryAfterHeader === '' ? NaN : Number(retryAfterHeader);
  const requestId = pickString(
    response?.headers?.get?.('x-request-id'),
    data?.requestId,
    data?.request_id,
  );
  return {
    provider: 'firecrawl',
    status,
    durationMs,
    requestId: requestId || undefined,
    retryAfterMs: Number.isFinite(retryAfter) && retryAfter >= 0 ? Math.round(retryAfter * 1000) : undefined,
  };
}

function firecrawlHttpErrorMessage(message, status) {
  const text = cleanLine(message, 600);
  if (Number(status) === 403) {
    return `${text} If the page is important, retry with a search limited to the same domain or use the search snippets if they already contain enough evidence.`;
  }
  return text;
}

async function fetchFirecrawlScrape(request, config, signal) {
  const baseUrl = config.firecrawlBaseUrl || 'https://api.firecrawl.dev';
  const startedAt = Date.now();
  const response = await fetch(joinUrl(baseUrl, '/v2/scrape'), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.firecrawlApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(request.body),
    signal,
  });
  const text = await response.text();
  const parsed = safeJsonParse(text);
  const data = parsed.ok ? parsed.value : { raw: text };
  return {
    response,
    data,
    diagnostic: providerDiagnostic({
      status: response.status,
      durationMs: Date.now() - startedAt,
      data,
      response,
    }),
  };
}

function firecrawlErrorResult(data, request, status, diagnostic, config) {
  const message =
    data?.error?.message ||
    data?.error ||
    data?.message ||
    data?.raw ||
    `Page fetch failed with HTTP ${status}`;
  const error = firecrawlHttpErrorMessage(message, status);
  return {
    url: request.normalized.url,
    title: '',
    summary: '',
    markdown: '',
    links: [],
    matches: [],
    error,
    content: formatFirecrawlScrapeResult({ url: request.normalized.url, error }, config),
    status,
    diagnostic,
  };
}

function firecrawlQuality(result) {
  return cleanLine(result?.markdown, 0).length +
    (result?.summary ? 100 : 0) +
    (result?.title && result.title !== result.url ? 50 : 0) +
    (Array.isArray(result?.matches) ? result.matches.length * 200 : 0);
}

function shouldRetryWeakFirecrawlResult(result, request) {
  if (!result?.weak || result.error) return false;
  const waitFor = Number(request.body.waitFor || 0);
  return !Number.isFinite(waitFor) || waitFor < WEAK_RETRY_WAIT_FOR_MS;
}

function weakRetryRequest(request) {
  return {
    ...request,
    body: {
      ...request.body,
      waitFor: Math.max(Number(request.body.waitFor || 0) || 0, WEAK_RETRY_WAIT_FOR_MS),
      maxAge: 0,
    },
  };
}

export async function callFirecrawlScrape({ args = {}, config = {}, signal } = {}) {
  const request = buildFirecrawlScrapeRequest(args, config);
  if (!request.ok) {
    return {
      url: '',
      title: '',
      summary: '',
      markdown: '',
      links: [],
      matches: [],
      error: request.error,
      diagnostic: { provider: 'firecrawl', errorCategory: 'validation' },
      content: formatFirecrawlScrapeResult({ error: request.error }, config),
    };
  }

  const first = await fetchFirecrawlScrape(request, config, signal);

  if (!first.response.ok) {
    return firecrawlErrorResult(first.data, request, first.response.status, first.diagnostic, config);
  }

  const result = normalizeFirecrawlScrapeResponse(first.data, request, config, first.diagnostic);
  if (!shouldRetryWeakFirecrawlResult(result, request)) return result;

  let retry;
  try {
    retry = await fetchFirecrawlScrape(weakRetryRequest(request), config, signal);
  } catch {
    result.diagnostic = { ...result.diagnostic, weakTextRetry: true, weakTextRetryError: 'network' };
    return result;
  }
  if (!retry.response.ok) {
    result.diagnostic = {
      ...result.diagnostic,
      weakTextRetry: true,
      weakTextRetryStatus: retry.response.status,
      weakTextRetryDurationMs: retry.diagnostic.durationMs,
    };
    return result;
  }

  const retried = normalizeFirecrawlScrapeResponse(retry.data, weakRetryRequest(request), config, {
    ...retry.diagnostic,
    weakTextRetry: true,
    firstStatus: first.diagnostic.status,
    firstDurationMs: first.diagnostic.durationMs,
  });
  return firecrawlQuality(retried) > firecrawlQuality(result) ? retried : {
    ...result,
    diagnostic: {
      ...result.diagnostic,
      weakTextRetry: true,
      weakTextRetryStatus: retry.response.status,
      weakTextRetryDurationMs: retry.diagnostic.durationMs,
    },
  };
}
