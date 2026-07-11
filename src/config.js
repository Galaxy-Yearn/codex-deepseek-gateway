import { dirname, resolve } from 'node:path';
import { loadModelAliases } from './model-map.js';
import { mergeLocalConfig, readLocalConfigFile, resolveLocalConfigPath } from './local-config.js';
import { parseBoolean, parseList } from './common.js';
import { readCodexConfig } from './codex-config.js';
import { normalizePromptLanguage } from './prompt-language.js';

export function loadConfig(env = process.env) {
  const localConfigPath = resolveLocalConfigPath(env);
  const stateDir = resolve(dirname(localConfigPath), '..', 'state');
  const mergedEnv = mergeLocalConfig(env);
  const localConfig = readLocalConfigFile(localConfigPath);
  const codexConfig = readCodexConfig(mergedEnv);
  return {
    port: Number(mergedEnv.PORT || 3000),
    host: mergedEnv.HOST || '127.0.0.1',
    upstreamBaseUrl: mergedEnv.UPSTREAM_BASE_URL || 'https://api.deepseek.com',
    upstreamApiKey: mergedEnv.UPSTREAM_API_KEY || mergedEnv.DEEPSEEK_API_KEY || '',
    upstreamModel: mergedEnv.UPSTREAM_MODEL || '',
    upstreamProvider: mergedEnv.UPSTREAM_PROVIDER || 'deepseek',
    upstreamTimeoutMs: Number(mergedEnv.UPSTREAM_TIMEOUT_MS || 120000),
    upstreamMaxTokens: Number(mergedEnv.UPSTREAM_MAX_TOKENS || mergedEnv.DEEPSEEK_MAX_TOKENS || 0),
    upstreamModels: parseList(mergedEnv.UPSTREAM_MODELS || mergedEnv.MODELS),
    fetchUpstreamModels: parseBoolean(mergedEnv.FETCH_UPSTREAM_MODELS, false),
    modelsTimeoutMs: Number(mergedEnv.MODELS_TIMEOUT_MS || 5000),
    modelsCacheMs: Number(mergedEnv.MODELS_CACHE_MS || 60000),
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
    tavilyMaxResults: Number(mergedEnv.TAVILY_MAX_RESULTS || 5),
    tavilyMaxSearchRounds: Number(mergedEnv.TAVILY_MAX_SEARCH_ROUNDS || 20),
    tavilyTimeoutMs: Number(mergedEnv.TAVILY_TIMEOUT_MS || 15000),
    tavilySnippetChars: Number(mergedEnv.TAVILY_SNIPPET_CHARS || 650),
    tavilyResultMaxChars: Number(mergedEnv.TAVILY_RESULT_MAX_CHARS || 6000),
    tavilyIncludeAnswer: parseBoolean(mergedEnv.TAVILY_INCLUDE_ANSWER, true),
    tavilyTopic: mergedEnv.TAVILY_TOPIC || '',
    tavilyTimeRange: mergedEnv.TAVILY_TIME_RANGE || '',
    firecrawlWebFetchEnabled: parseBoolean(mergedEnv.FIRECRAWL_WEB_FETCH_ENABLED ?? mergedEnv.ENABLE_FIRECRAWL_WEB_FETCH, false),
    firecrawlApiKey: mergedEnv.FIRECRAWL_API_KEY || '',
    firecrawlBaseUrl: mergedEnv.FIRECRAWL_BASE_URL || 'https://api.firecrawl.dev',
    firecrawlAutoScrapeTopResults: Number(mergedEnv.FIRECRAWL_AUTO_SCRAPE_TOP_RESULTS || 3),
    firecrawlPageMaxChars: Number(mergedEnv.FIRECRAWL_PAGE_MAX_CHARS || 5000),
    firecrawlResultMaxChars: Number(mergedEnv.FIRECRAWL_RESULT_MAX_CHARS || 12000),
    firecrawlMaxLinks: Number(mergedEnv.FIRECRAWL_MAX_LINKS || 20),
    firecrawlTimeoutMs: Number(mergedEnv.FIRECRAWL_TIMEOUT_MS || 30000),
    firecrawlWaitForMs: Number(mergedEnv.FIRECRAWL_WAIT_FOR_MS || 0),
    firecrawlFormats: mergedEnv.FIRECRAWL_FORMATS || 'markdown,links',
    firecrawlOnlyMainContent: parseBoolean(mergedEnv.FIRECRAWL_ONLY_MAIN_CONTENT, true),
    firecrawlRemoveBase64Images: parseBoolean(mergedEnv.FIRECRAWL_REMOVE_BASE64_IMAGES, true),
    firecrawlIncludeLinks: parseBoolean(mergedEnv.FIRECRAWL_INCLUDE_LINKS, true),
    firecrawlIncludeSummary: parseBoolean(mergedEnv.FIRECRAWL_INCLUDE_SUMMARY, false),
    firecrawlMobile: mergedEnv.FIRECRAWL_MOBILE,
    firecrawlAllowPrivateUrls: parseBoolean(mergedEnv.FIRECRAWL_ALLOW_PRIVATE_URLS, false),
    codexModelProvider: codexConfig.modelProvider,
    codexModel: codexConfig.model,
    codexReasoningEffort: mergedEnv.CODEX_REASONING_EFFORT || mergedEnv.MODEL_REASONING_EFFORT || codexConfig.modelReasoningEffort,
    codexReasoningSummary: codexConfig.modelReasoningSummary,
    codexModelSupportsReasoningSummaries: codexConfig.modelSupportsReasoningSummaries,
    codexHideAgentReasoning: codexConfig.hideAgentReasoning,
    codexPromptLanguage: normalizePromptLanguage(localConfig.CODEX_PROMPT_LANGUAGE),
    modelAliases: loadModelAliases(mergedEnv),
  };
}
