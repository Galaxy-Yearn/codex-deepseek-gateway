import { isObject, joinUrl, normalizeSearchQuery, parseBoolean, safeJsonParse } from './common.js';

const DEFAULT_MAX_RESULTS = 5;
const HARD_MAX_RESULTS = 10;
const DEFAULT_SNIPPET_CHARS = 650;
const DEFAULT_TOTAL_CHARS = 12000;
const HARD_MAX_TOTAL_CHARS = 100000;
const DEFAULT_MIN_SNIPPET_CHARS = 160;
const DEFAULT_AUTO_PAGE_EXCERPT_CHARS = 1200;
const INCOMPLETE_PAGE_TEXT_NOTICE = 'Page text appears incomplete; use search snippets or a domain-limited search if more detail is needed.';
const ALLOWED_SEARCH_DEPTHS = new Set(['basic', 'advanced', 'fast', 'ultra-fast']);
const ALLOWED_TOPICS = new Set(['general', 'news', 'finance']);
const ALLOWED_TIME_RANGES = new Set(['day', 'week', 'month', 'year', 'd', 'w', 'm', 'y']);

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

function cleanText(value, maxChars = DEFAULT_SNIPPET_CHARS) {
  if (value == null) return '';
  const text = String(value)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '$1 ($2)')
    .replace(/[`*_~>#]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clipText(text, maxChars);
}

function cleanUrl(value) {
  if (typeof value !== 'string') return '';
  const url = value.trim();
  if (!/^https?:\/\//i.test(url)) return '';
  return url;
}

function normalizeStringList(value, maxItems = 20) {
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

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function tavilyErrorMessage(data, fallback) {
  return firstString(
    data?.error?.message,
    data?.error,
    data?.detail?.error,
    data?.detail?.message,
    data?.message,
    data?.raw,
    fallback,
  );
}

function normalizeTopic(value) {
  const topic = String(value || '').trim().toLowerCase();
  return ALLOWED_TOPICS.has(topic) ? topic : undefined;
}

function normalizeTimeRange(value) {
  const range = String(value || '').trim().toLowerCase();
  return ALLOWED_TIME_RANGES.has(range) ? range : undefined;
}

function normalizeSearchDepth(value, fallback = 'basic') {
  const depth = String(value || fallback).trim().toLowerCase();
  return ALLOWED_SEARCH_DEPTHS.has(depth) ? depth : fallback;
}

function normalizeDate(value) {
  const date = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return undefined;
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date ? undefined : date;
}

function normalizeCountry(value) {
  const country = String(value || '').trim();
  if (!country) return undefined;
  if (/^[a-z]{2}$/i.test(country)) {
    try {
      return new Intl.DisplayNames(['en'], { type: 'region' }).of(country.toUpperCase()).toLowerCase();
    } catch {
      return country.toLowerCase();
    }
  }
  return country.toLowerCase();
}

function sanitizeUsage(value) {
  if (!isObject(value)) return undefined;
  const usage = {};
  for (const [key, raw] of Object.entries(value)) {
    const number = Number(raw);
    if (Number.isFinite(number)) usage[key] = number;
  }
  return Object.keys(usage).length ? usage : undefined;
}

function providerDiagnostic({ status, durationMs, data, response } = {}) {
  const responseTime = Number(data?.response_time);
  const requestId = firstString(data?.request_id, response?.headers?.get?.('x-request-id'));
  const retryAfterHeader = response?.headers?.get?.('retry-after');
  const retryAfter = retryAfterHeader == null || retryAfterHeader === '' ? NaN : Number(retryAfterHeader);
  return {
    provider: 'tavily',
    status,
    durationMs,
    requestId: requestId || undefined,
    responseTimeMs: Number.isFinite(responseTime) ? Math.round(responseTime * 1000) : undefined,
    usage: sanitizeUsage(data?.usage),
    retryAfterMs: Number.isFinite(retryAfter) && retryAfter >= 0 ? Math.round(retryAfter * 1000) : undefined,
  };
}

export function normalizeTavilySearchArgs(args = {}, config = {}) {
  const source = isObject(args) ? args : { query: String(args ?? '') };
  const query = normalizeSearchQuery(firstString(source.query, source.q, source.search, source.search_query, source.input, source.value), 500);
  if (!query) {
    return { ok: false, error: 'Missing search query.' };
  }

  const configuredMax = clampInteger(config.tavilyMaxResults, 1, HARD_MAX_RESULTS, DEFAULT_MAX_RESULTS);
  const defaultMax = clampInteger(config.tavilyDefaultMaxResults, 1, configuredMax, configuredMax);
  const maxResults = clampInteger(source.max_results ?? source.maxResults, 1, configuredMax, defaultMax);
  const topic = normalizeTopic(source.topic ?? config.tavilyTopic);
  const timeRange = normalizeTimeRange(source.time_range ?? source.timeRange ?? config.tavilyTimeRange);
  const startDate = normalizeDate(source.start_date ?? source.startDate ?? config.tavilyStartDate);
  const endDate = normalizeDate(source.end_date ?? source.endDate ?? config.tavilyEndDate);
  if (startDate && endDate && startDate > endDate) {
    return { ok: false, error: 'Search start_date must not be after end_date.' };
  }

  return {
    ok: true,
    query,
    searchDepth: normalizeSearchDepth(source.search_depth ?? source.searchDepth ?? config.tavilySearchDepth, 'basic'),
    chunksPerSource: clampInteger(config.tavilyChunksPerSource, 1, 3, 3),
    maxResults,
    topic,
    timeRange,
    startDate,
    endDate,
    country: normalizeCountry(source.country ?? config.tavilyCountry),
    includeDomains: normalizeStringList(source.include_domains ?? source.includeDomains ?? config.tavilyIncludeDomains),
    excludeDomains: normalizeStringList(source.exclude_domains ?? source.excludeDomains ?? config.tavilyExcludeDomains),
  };
}

export function buildTavilySearchRequest(args = {}, config = {}) {
  const normalized = normalizeTavilySearchArgs(args, config);
  if (!normalized.ok) return normalized;

  const body = {
    query: normalized.query,
    search_depth: normalized.searchDepth,
    max_results: normalized.maxResults,
    include_answer: parseBoolean(config.tavilyIncludeAnswer, true),
    include_raw_content: false,
    include_usage: true,
  };
  if (normalized.searchDepth === 'advanced') body.chunks_per_source = normalized.chunksPerSource;
  if (normalized.topic) body.topic = normalized.topic;
  if (normalized.timeRange) body.time_range = normalized.timeRange;
  if (normalized.startDate) body.start_date = normalized.startDate;
  if (normalized.endDate) body.end_date = normalized.endDate;
  if (normalized.country && (!normalized.topic || normalized.topic === 'general')) body.country = normalized.country;
  if (normalized.includeDomains.length) body.include_domains = normalized.includeDomains;
  if (normalized.excludeDomains.length) body.exclude_domains = normalized.excludeDomains;

  return { ok: true, normalized, body };
}

function normalizeTavilyResultItem(item, index, config = {}) {
  const title = cleanText(firstString(item?.title, item?.name, item?.url), 180) || `Source ${index}`;
  const url = cleanUrl(item?.url);
  const snippet = cleanText(firstString(item?.content, item?.snippet, item?.description), Number(config.tavilySnippetChars) || DEFAULT_SNIPPET_CHARS);
  const publishedDate = cleanText(firstString(item?.published_date, item?.publishedDate), 80);
  const score = Number.isFinite(Number(item?.score)) ? Number(item.score) : undefined;
  return {
    index,
    title,
    url,
    snippet,
    publishedDate,
    score,
  };
}

function textFromParts(header, answer, records, footer) {
  const lines = [...header];
  if (answer) lines.push(answer);
  if (records.length) {
    lines.push('Sources:');
    for (const record of records) lines.push(...record);
  }
  lines.push(...footer);
  return lines.filter(Boolean).join('\n');
}

function addFieldWithin(lines, label, value, maxChars, minimumValueChars = 1) {
  if (!value) return;
  const separatorChars = lines.length ? 1 : 0;
  const available = maxChars - lines.join('\n').length - separatorChars - label.length;
  if (available < minimumValueChars) return;
  lines.push(`${label}${clipText(value, available)}`);
}

function sourceSkeleton(result, maxChars, minimumSnippetChars) {
  const lines = [];
  const urlReserve = result.url ? Math.min(Math.max(24, result.url.length + 5), Math.floor(maxChars * 0.55)) : 0;
  addFieldWithin(lines, `Source ${result.index}: `, result.title, Math.max(1, maxChars - urlReserve - 1), 1);
  addFieldWithin(lines, 'URL: ', result.url, maxChars, 12);
  addFieldWithin(lines, 'Date: ', result.publishedDate, maxChars, 4);
  if (result.score !== undefined) addFieldWithin(lines, 'Score: ', String(result.score), maxChars, 1);
  addFieldWithin(lines, 'Snippet: ', clipText(result.snippet, minimumSnippetChars), maxChars, 20);
  return lines;
}

function appendOptionalLine({ header, answer, records, footer, maxChars }, record, line, minimumChars = 24) {
  const current = textFromParts(header, answer, records, footer);
  const extraSeparator = record.length ? 1 : 0;
  const available = maxChars - current.length - extraSeparator;
  if (available < minimumChars) return false;
  record.push(clipText(line, available));
  return true;
}

function appendOptionalBlock(state, record, prefixLines, finalLine, minimumFinalChars = 40) {
  const before = textFromParts(state.header, state.answer, state.records, state.footer);
  const prefix = prefixLines.filter(Boolean);
  const prefixText = prefix.join('\n');
  const separators = record.length ? 1 : 0;
  const blockSeparator = prefix.length ? 1 : 0;
  const available = state.maxChars - before.length - separators - prefixText.length - blockSeparator;
  if (available < minimumFinalChars) return false;
  record.push(...prefix, clipText(finalLine, available));
  return true;
}

function appendOpenedPage(state, record, result, config = {}) {
  const page = result.page;
  if (!page) return;
  if (page.error) {
    appendOptionalLine(state, record, `Opened page error: ${cleanText(page.error, 500)}`);
    return;
  }
  if (page.title && page.title !== result.title) {
    appendOptionalLine(state, record, `Opened page title: ${cleanText(page.title, 180)}`);
  }
  if (page.summary) {
    appendOptionalLine(state, record, `Opened page summary: ${cleanText(page.summary, 900)}`);
  }
  if (page.weak) {
    appendOptionalLine(state, record, `Opened page note: ${INCOMPLETE_PAGE_TEXT_NOTICE}`);
  }
  const matches = Array.isArray(page.matches) ? page.matches : [];
  if (matches.length) {
    for (const [matchIndex, match] of matches.entries()) {
      const prefix = matchIndex === 0 ? ['Opened page matches:'] : [];
      if (!appendOptionalBlock(state, record, prefix, `- ${cleanText(match, 700)}`, 32)) break;
    }
  }
  if (page.markdown && !matches.length) {
    appendOptionalBlock(state, record, ['Opened page excerpt:'], cleanText(page.markdown, DEFAULT_AUTO_PAGE_EXCERPT_CHARS), 48);
  }
  if (Array.isArray(page.links) && page.links.length) {
    for (const [linkIndex, link] of page.links.entries()) {
      const title = cleanText(link.title || link.url, 180);
      const prefix = [`Source ${result.index} link ${linkIndex + 1}: ${title}`];
      if (!appendOptionalBlock(state, record, prefix, `URL: ${link.url}`, 16)) break;
    }
  }
}

function normalizeSearchStatusLines(status) {
  const lines = Array.isArray(status) ? status : status ? [status] : [];
  return lines
    .map((line) => cleanText(line, 300))
    .filter(Boolean)
    .slice(0, 5)
    .map((line) => `Search status: ${line}`);
}

export function formatTavilySearchResult({ query, answer = '', results = [], error = '', status = [] } = {}, config = {}) {
  const maxChars = clampInteger(config.tavilyResultMaxChars, 1000, HARD_MAX_TOTAL_CHARS, DEFAULT_TOTAL_CHARS);
  const header = [`Web search results for: ${query || '(unknown)'}`];
  const footer = normalizeSearchStatusLines(status);

  if (error) {
    const errorLine = `Search error: ${cleanText(error, 500)}`;
    return textFromParts(header, clipText(errorLine, Math.max(1, maxChars - textFromParts(header, '', [], footer).length - 1)), [], footer);
  }

  if (!results.length) {
    return textFromParts(header, '', [], [...footer, 'No useful search results were returned.']);
  }

  const fixed = textFromParts(header, '', [], footer);
  const recordBudget = Math.max(1, maxChars - fixed.length - 'Sources:'.length - results.length - 1);
  const perRecordBudget = Math.max(1, Math.floor(recordBudget / results.length));
  const minimumSnippetChars = clampInteger(config.tavilyMinimumSnippetChars, 40, DEFAULT_SNIPPET_CHARS, DEFAULT_MIN_SNIPPET_CHARS);
  const records = results.map((result) => sourceSkeleton(result, perRecordBudget, minimumSnippetChars));
  const state = { header, answer: '', records, footer, maxChars };

  for (const [resultIndex, result] of results.entries()) {
    appendOpenedPage(state, records[resultIndex], result, config);
  }

  if (answer) {
    const current = textFromParts(header, '', records, footer);
    const available = maxChars - current.length - 1;
    if (available >= 24) state.answer = clipText(`Answer summary: ${cleanText(answer, 900)}`, available);
  }

  for (const [resultIndex, result] of results.entries()) {
    const record = records[resultIndex];
    const currentSnippet = record.find((line) => line.startsWith('Snippet: '));
    if (result.snippet && (!currentSnippet || currentSnippet !== `Snippet: ${result.snippet}`)) {
      const current = textFromParts(header, state.answer, records, footer);
      const available = maxChars - current.length;
      if (available > 0 && currentSnippet) {
        const index = record.indexOf(currentSnippet);
        const expanded = clipText(`Snippet: ${result.snippet}`, currentSnippet.length + available);
        record[index] = expanded;
      } else if (available >= 32) {
        appendOptionalLine(state, record, `Snippet: ${result.snippet}`, 32);
      }
    }
  }

  return textFromParts(header, state.answer, records, footer);
}

export function normalizeTavilySearchResponse(data, request, config = {}, diagnostic) {
  const rawResults = Array.isArray(data?.results) ? data.results : [];
  const results = rawResults
    .slice(0, request.normalized.maxResults)
    .map((item, index) => normalizeTavilyResultItem(item, index + 1, config))
    .filter((item) => item.url || item.snippet || item.title);
  const answer = cleanText(data?.answer, 1000);
  const payload = {
    query: request.normalized.query,
    answer,
    results,
  };
  return {
    ...payload,
    diagnostic,
    content: formatTavilySearchResult(payload, config),
  };
}

export async function callTavilySearch({ args = {}, config = {}, signal } = {}) {
  const request = buildTavilySearchRequest(args, config);
  if (!request.ok) {
    return {
      query: '',
      answer: '',
      results: [],
      error: request.error,
      diagnostic: { provider: 'tavily', errorCategory: 'validation' },
      content: formatTavilySearchResult({ error: request.error }, config),
    };
  }

  const baseUrl = config.tavilyBaseUrl || 'https://api.tavily.com';
  const startedAt = Date.now();
  const response = await fetch(joinUrl(baseUrl, '/search'), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.tavilyApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(request.body),
    signal,
  });
  const text = await response.text();
  const parsed = safeJsonParse(text);
  const data = parsed.ok ? parsed.value : { raw: text };
  const diagnostic = providerDiagnostic({
    status: response.status,
    durationMs: Date.now() - startedAt,
    data,
    response,
  });

  if (!response.ok) {
    const message = tavilyErrorMessage(data, `Web search failed with HTTP ${response.status}`);
    return {
      query: request.normalized.query,
      answer: '',
      results: [],
      error: cleanText(message, 500),
      content: formatTavilySearchResult({ query: request.normalized.query, error: message }, config),
      status: response.status,
      diagnostic,
    };
  }

  return normalizeTavilySearchResponse(data, request, config, diagnostic);
}
