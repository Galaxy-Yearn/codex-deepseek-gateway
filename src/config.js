import { loadModelAliases } from './model-map.js';
import { mergeLocalConfig } from './local-config.js';
import { parseBoolean, parseList } from './common.js';
import { readCodexConfig } from './codex-config.js';

export function loadConfig(env = process.env) {
  const mergedEnv = mergeLocalConfig(env);
  const codexConfig = readCodexConfig(mergedEnv);
  return {
    port: Number(mergedEnv.PORT || 3000),
    host: mergedEnv.HOST || '127.0.0.1',
    upstreamBaseUrl: mergedEnv.UPSTREAM_BASE_URL || 'https://api.deepseek.com',
    upstreamApiKey: mergedEnv.UPSTREAM_API_KEY || mergedEnv.DEEPSEEK_API_KEY || '',
    upstreamModel: mergedEnv.UPSTREAM_MODEL || '',
    upstreamProvider: mergedEnv.UPSTREAM_PROVIDER || 'deepseek',
    upstreamTimeoutMs: Number(mergedEnv.UPSTREAM_TIMEOUT_MS || 120000),
    upstreamModels: parseList(mergedEnv.UPSTREAM_MODELS || mergedEnv.MODELS),
    fetchUpstreamModels: parseBoolean(mergedEnv.FETCH_UPSTREAM_MODELS, false),
    modelsTimeoutMs: Number(mergedEnv.MODELS_TIMEOUT_MS || 5000),
    modelsCacheMs: Number(mergedEnv.MODELS_CACHE_MS || 60000),
    proxyApiKey: mergedEnv.PROXY_API_KEY || '',
    debugPayload: parseBoolean(mergedEnv.DEBUG_PAYLOAD || mergedEnv.DEBUG_DEEPSEEK_PAYLOAD, false),
    codexModelProvider: codexConfig.modelProvider,
    codexModel: codexConfig.model,
    codexReasoningEffort: mergedEnv.CODEX_REASONING_EFFORT || mergedEnv.MODEL_REASONING_EFFORT || codexConfig.modelReasoningEffort,
    codexReasoningSummary: codexConfig.modelReasoningSummary,
    codexModelSupportsReasoningSummaries: codexConfig.modelSupportsReasoningSummaries,
    codexHideAgentReasoning: codexConfig.hideAgentReasoning,
    modelAliases: loadModelAliases(mergedEnv),
  };
}
