import { dirname, resolve } from 'node:path';
import { loadModelAliases } from './model-map.js';
import { mergeLocalConfig, readLocalConfigFile, resolveLocalConfigPath } from './local-config.js';
import { parseBoolean, parseList } from './common.js';
import { readCodexConfig } from './codex-config.js';
import { catalogFileForPromptLanguage, normalizePromptLanguage } from './prompt-language.js';
import { DEFAULT_REQUEST_BODY_MAX_BYTES, DEFAULT_SHUTDOWN_TIMEOUT_MS } from './runtime.js';

export const DEFAULT_COMPACT_MAX_TOKENS = 20000;
export const COMPACT_MAX_TOKENS_HARD_LIMIT = 20000;
export const DEFAULT_COMPACT_TIMEOUT_MS = 240000;
export const DEFAULT_UPSTREAM_WIRE_API = 'chat_completions';
export const UPSTREAM_WIRE_APIS = new Set(['chat_completions', 'responses']);

export function normalizeUpstreamWireApi(value) {
  const normalized = String(value || DEFAULT_UPSTREAM_WIRE_API).trim().toLowerCase();
  if (UPSTREAM_WIRE_APIS.has(normalized)) return normalized;
  const error = new Error(`Unsupported upstream wire API ${JSON.stringify(value)}. Expected one of: chat_completions, responses`);
  error.statusCode = 400;
  error.code = 'invalid_upstream_wire_api';
  throw error;
}

export function normalizeCompactReasoningEffort(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === 'max' ? 'max' : 'high';
}

export function normalizeCompactMaxTokens(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return DEFAULT_COMPACT_MAX_TOKENS;
  return Math.min(Math.floor(number), COMPACT_MAX_TOKENS_HARD_LIMIT);
}

export function normalizeCompactTimeoutMs(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return DEFAULT_COMPACT_TIMEOUT_MS;
  return Math.floor(number);
}

export function loadConfig(env = process.env) {
  const localConfigPath = resolveLocalConfigPath(env);
  const stateDir = resolve(dirname(localConfigPath), '..', 'state');
  const mergedEnv = mergeLocalConfig(env);
  const localConfig = readLocalConfigFile(localConfigPath);
  const codexPromptLanguage = normalizePromptLanguage(localConfig.CODEX_PROMPT_LANGUAGE);
  const modelCatalogPath = resolve(dirname(localConfigPath), catalogFileForPromptLanguage(codexPromptLanguage));
  const codexConfig = readCodexConfig(mergedEnv);
  return {
    port: Number(mergedEnv.PORT || 3000),
    host: mergedEnv.HOST || '127.0.0.1',
    upstreamBaseUrl: mergedEnv.UPSTREAM_BASE_URL || 'https://api.deepseek.com',
    upstreamApiKey: mergedEnv.UPSTREAM_API_KEY || mergedEnv.DEEPSEEK_API_KEY || '',
    upstreamModel: mergedEnv.UPSTREAM_MODEL || '',
    upstreamProvider: mergedEnv.UPSTREAM_PROVIDER || 'deepseek',
    upstreamWireApi: normalizeUpstreamWireApi(mergedEnv.UPSTREAM_WIRE_API),
    upstreamTimeoutMs: Number(mergedEnv.UPSTREAM_TIMEOUT_MS || 120000),
    upstreamMaxTokens: Number(mergedEnv.UPSTREAM_MAX_TOKENS || mergedEnv.DEEPSEEK_MAX_TOKENS || 0),
    compactReasoningEffort: normalizeCompactReasoningEffort(mergedEnv.COMPACT_REASONING_EFFORT),
    compactMaxTokens: normalizeCompactMaxTokens(mergedEnv.COMPACT_MAX_TOKENS),
    compactTimeoutMs: normalizeCompactTimeoutMs(mergedEnv.COMPACT_TIMEOUT_MS),
    upstreamModels: parseList(mergedEnv.UPSTREAM_MODELS || mergedEnv.MODELS),
    fetchUpstreamModels: parseBoolean(mergedEnv.FETCH_UPSTREAM_MODELS, false),
    modelsTimeoutMs: Number(mergedEnv.MODELS_TIMEOUT_MS || 5000),
    modelsCacheMs: Number(mergedEnv.MODELS_CACHE_MS || 60000),
    requestBodyMaxBytes: Number(mergedEnv.REQUEST_BODY_MAX_BYTES || DEFAULT_REQUEST_BODY_MAX_BYTES),
    shutdownTimeoutMs: Number(mergedEnv.SHUTDOWN_TIMEOUT_MS || DEFAULT_SHUTDOWN_TIMEOUT_MS),
    proxyApiKey: mergedEnv.PROXY_API_KEY || '',
    debugPayload: parseBoolean(mergedEnv.DEBUG_PAYLOAD || mergedEnv.DEBUG_DEEPSEEK_PAYLOAD, false),
    debugPayloadLogPath: mergedEnv.DEBUG_PAYLOAD_LOG_PATH || 'gateway.debug.log',
    reasoningCacheEnabled: parseBoolean(mergedEnv.REASONING_CACHE_ENABLED, true),
    reasoningCachePath: mergedEnv.REASONING_CACHE_PATH || resolve(stateDir, 'reasoning-cache.jsonl'),
    reasoningCacheMaxMessages: Number(mergedEnv.REASONING_CACHE_MAX_MESSAGES || 1000),
    reasoningCacheMaxBytes: Number(mergedEnv.REASONING_CACHE_MAX_BYTES || 0),
    legacyReasoningCachePath: resolve(stateDir, 'sessions.json'),
    debugPayloadLogMaxBytes: Number(mergedEnv.DEBUG_PAYLOAD_LOG_MAX_BYTES || 0),
    tavilyWebSearchEnabled: parseBoolean(mergedEnv.TAVILY_WEB_SEARCH_ENABLED ?? mergedEnv.ENABLE_TAVILY_WEB_SEARCH, false),
    tavilyApiKey: mergedEnv.TAVILY_API_KEY || '',
    tavilyBaseUrl: mergedEnv.TAVILY_BASE_URL || 'https://api.tavily.com',
    tavilySearchDepth: mergedEnv.TAVILY_SEARCH_DEPTH || 'basic',
    tavilyChunksPerSource: Number(mergedEnv.TAVILY_CHUNKS_PER_SOURCE || 3),
    tavilyMaxResults: Number(mergedEnv.TAVILY_MAX_RESULTS || 5),
    webSearchMaxRounds: Number(mergedEnv.WEB_SEARCH_MAX_ROUNDS || 60),
    tavilyTimeoutMs: Number(mergedEnv.TAVILY_TIMEOUT_MS || 15000),
    tavilySnippetChars: Number(mergedEnv.TAVILY_SNIPPET_CHARS || 650),
    tavilyMinimumSnippetChars: Number(mergedEnv.TAVILY_MINIMUM_SNIPPET_CHARS || 160),
    tavilyResultMaxChars: Number(mergedEnv.TAVILY_RESULT_MAX_CHARS || 12000),
    tavilyIncludeAnswer: parseBoolean(mergedEnv.TAVILY_INCLUDE_ANSWER, true),
    tavilyTopic: mergedEnv.TAVILY_TOPIC || '',
    tavilyTimeRange: mergedEnv.TAVILY_TIME_RANGE || '',
    tavilyStartDate: mergedEnv.TAVILY_START_DATE || '',
    tavilyEndDate: mergedEnv.TAVILY_END_DATE || '',
    tavilyCountry: mergedEnv.TAVILY_COUNTRY || '',
    firecrawlWebFetchEnabled: parseBoolean(mergedEnv.FIRECRAWL_WEB_FETCH_ENABLED ?? mergedEnv.ENABLE_FIRECRAWL_WEB_FETCH, false),
    firecrawlApiKey: mergedEnv.FIRECRAWL_API_KEY || '',
    firecrawlBaseUrl: mergedEnv.FIRECRAWL_BASE_URL || 'https://api.firecrawl.dev',
    firecrawlAutoScrapeTopResults: Number(mergedEnv.FIRECRAWL_AUTO_SCRAPE_TOP_RESULTS || 1),
    firecrawlPageMaxChars: Number(mergedEnv.FIRECRAWL_PAGE_MAX_CHARS || 10000),
    firecrawlResultMaxChars: Number(mergedEnv.FIRECRAWL_RESULT_MAX_CHARS || 20000),
    firecrawlMaxLinks: Number(mergedEnv.FIRECRAWL_MAX_LINKS || 20),
    firecrawlTimeoutMs: Number(mergedEnv.FIRECRAWL_TIMEOUT_MS || 30000),
    firecrawlWaitForMs: Number(mergedEnv.FIRECRAWL_WAIT_FOR_MS || 0),
    firecrawlMaxAgeMs: Number(mergedEnv.FIRECRAWL_MAX_AGE_MS || 172800000),
    firecrawlStoreInCache: parseBoolean(mergedEnv.FIRECRAWL_STORE_IN_CACHE, true),
    firecrawlFormats: mergedEnv.FIRECRAWL_FORMATS || 'markdown,links',
    firecrawlOnlyMainContent: parseBoolean(mergedEnv.FIRECRAWL_ONLY_MAIN_CONTENT, true),
    firecrawlRemoveBase64Images: parseBoolean(mergedEnv.FIRECRAWL_REMOVE_BASE64_IMAGES, true),
    firecrawlIncludeLinks: parseBoolean(mergedEnv.FIRECRAWL_INCLUDE_LINKS, true),
    firecrawlIncludeSummary: parseBoolean(mergedEnv.FIRECRAWL_INCLUDE_SUMMARY, false),
    firecrawlMobile: mergedEnv.FIRECRAWL_MOBILE,
    firecrawlCountry: mergedEnv.FIRECRAWL_COUNTRY || '',
    firecrawlLanguages: mergedEnv.FIRECRAWL_LANGUAGES || '',
    firecrawlAllowPrivateUrls: parseBoolean(mergedEnv.FIRECRAWL_ALLOW_PRIVATE_URLS, false),
    webSearchMaxSearches: Number(mergedEnv.WEB_SEARCH_MAX_SEARCHES || 30),
    webSearchMaxPages: Number(mergedEnv.WEB_SEARCH_MAX_PAGES || 50),
    webSearchMaxToolChars: Number(mergedEnv.WEB_SEARCH_MAX_TOOL_CHARS || 240000),
    webSearchTurnTimeoutMs: Number(mergedEnv.WEB_SEARCH_TURN_TIMEOUT_MS || 180000),
    webSearchConcurrency: Number(mergedEnv.WEB_SEARCH_CONCURRENCY || 3),
    codexModelProvider: codexConfig.modelProvider,
    codexModel: codexConfig.model,
    codexReasoningEffort: mergedEnv.CODEX_REASONING_EFFORT || mergedEnv.MODEL_REASONING_EFFORT || codexConfig.modelReasoningEffort,
    codexReasoningSummary: codexConfig.modelReasoningSummary,
    codexModelSupportsReasoningSummaries: codexConfig.modelSupportsReasoningSummaries,
    codexHideAgentReasoning: codexConfig.hideAgentReasoning,
    codexPromptLanguage,
    modelAliases: loadModelAliases(mergedEnv, process.cwd(), modelCatalogPath),
  };
}
