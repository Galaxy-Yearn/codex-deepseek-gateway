import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isObject, parseJsonObject } from './common.js';
import { modelAliasesFromCatalog, readModelCatalog } from './model-catalog.js';

const DEEPSEEK_REASONING_EFFORTS = new Set(['none', 'low', 'high', 'max']);
const DEPRECATED_MODEL_PATTERN = /^deepseek-(?:chat|reasoner)$/;
const DEFAULT_MODEL_CATALOG_FILE = new URL('../config/model-catalog.json', import.meta.url);
const NATIVE_RESPONSES_MODELS = new Set(['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4-flash-vision-exp']);

export function supportsNativeVisionModel(requestedModel, config = {}) {
  const model = resolveModelAlias(requestedModel, config).upstreamModel || requestedModel || '';
  return /(?:^|[/:_-])vision(?:$|[/:_-])/iu.test(String(model));
}

export function isDeepSeekModel(requestedModel, config = {}) {
  const model = resolveModelAlias(requestedModel, config).upstreamModel || requestedModel || '';
  return /^(?:deepseek(?:\/|[-_]))/iu.test(String(model));
}

export const DEFAULT_MODEL_ALIASES = modelAliasesFromCatalog(readModelCatalog(DEFAULT_MODEL_CATALOG_FILE));

function readJsonFile(filePath) {
  if (!filePath || !existsSync(filePath)) return {};
  return parseJsonObject(readFileSync(filePath, 'utf8'), { source: filePath, throwOnInvalid: true });
}

export function loadModelAliases(env = process.env, cwd = process.cwd(), catalogFile = resolve(cwd, 'config', 'model-catalog.json')) {
  const catalogAliases = modelAliasesFromCatalog(readModelCatalog(catalogFile));
  const baseAliases = existsSync(catalogFile) ? catalogAliases : DEFAULT_MODEL_ALIASES;
  const fileAliases = env.MODEL_ALIASES_FILE ? readJsonFile(resolve(cwd, env.MODEL_ALIASES_FILE)) : {};
  const envAliases = parseJsonObject(env.MODEL_ALIASES_JSON, { source: 'MODEL_ALIASES_JSON', throwOnInvalid: true });
  return {
    ...baseAliases,
    ...fileAliases,
    ...envAliases,
  };
}

function normalizeThinking(value) {
  if (value === true) return 'enabled';
  if (value === false) return 'disabled';
  if (value == null) return 'auto';
  const normalized = String(value).toLowerCase().replaceAll('_', '-');
  if (normalized === 'on' || normalized === 'true' || normalized === 'yes') return 'enabled';
  if (normalized === 'off' || normalized === 'false' || normalized === 'no') return 'disabled';
  if (normalized === 'non-thinking' || normalized === 'no-thinking') return 'disabled';
  if (normalized === 'thinking') return 'enabled';
  return normalized;
}

function normalizeAlias(alias, aliasName) {
  if (typeof alias === 'string') return { alias: aliasName, upstreamModel: alias, thinking: 'auto', extraBody: {} };
  if (!isObject(alias)) return null;
  return {
    alias: aliasName,
    upstreamModel: alias.upstreamModel || alias.upstream_model || alias.model || aliasName,
    thinking: normalizeThinking(alias.thinking ?? alias.thinking_mode ?? alias.thinkingMode),
    reasoningEffort: alias.reasoning_effort ?? alias.reasoningEffort ?? alias.effort,
    extraBody: isObject(alias.extra_body) ? alias.extra_body : isObject(alias.extraBody) ? alias.extraBody : {},
  };
}

export function resolveModelAlias(requestedModel, config = {}) {
  const model = requestedModel || config.upstreamModel || '';
  const aliases = isObject(config.modelAliases) ? config.modelAliases : {};
  const alias = normalizeAlias(aliases[model], model);
  if (alias) return alias;
  return {
    alias: model,
    upstreamModel: config.upstreamModel || model,
    thinking: 'auto',
    reasoningEffort: undefined,
    extraBody: {},
  };
}

export function supportsNativeResponsesModel(requestedModel, config = {}) {
  return true;
}

function validateDeepSeekReasoningEffort(effort) {
  if (effort == null) return undefined;
  if (DEEPSEEK_REASONING_EFFORTS.has(effort)) return effort;
  const error = new Error(`Unsupported DeepSeek reasoning effort ${JSON.stringify(effort)}. Expected one of: none, low, high, max`);
  error.statusCode = 400;
  error.code = 'invalid_reasoning_effort';
  throw error;
}

export function deepseekReasoningPayload({ alias, reasoning } = {}) {
  const requestEffort = validateDeepSeekReasoningEffort(isObject(reasoning) ? reasoning.effort : undefined);
  const aliasThinking = normalizeThinking(alias?.thinking);
  const aliasEffort = validateDeepSeekReasoningEffort(alias?.reasoningEffort);
  const effort = aliasEffort ?? requestEffort;

  if (aliasThinking === 'disabled' || effort === 'none') {
    return { thinking: { type: 'disabled' } };
  }

  const payload = { thinking: { type: 'enabled' } };
  if (effort === 'low' || effort === 'high' || effort === 'max') payload.reasoning_effort = effort;
  return payload;
}

export function listModels(config = {}) {
  const aliases = isObject(config.modelAliases) ? config.modelAliases : {};
  const configuredModels = Array.isArray(config.upstreamModels) ? config.upstreamModels : [];
  const nativeResponses = config.upstreamWireApi === 'responses';
  return [...new Set([...Object.keys(aliases), ...configuredModels])]
    .filter((id) => id && !isDeprecatedModel(id))
    .filter((id) => !nativeResponses || supportsNativeResponsesModel(id, config))
    .sort()
    .map((id) => ({
      id,
      object: 'model',
      created: 0,
      owned_by: config.upstreamProvider || 'gateway',
    }));
}

export function isDeprecatedModel(model) {
  return DEPRECATED_MODEL_PATTERN.test(String(model || '').trim());
}

export function normalizeModelList(payload, config = {}) {
  const source = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : [];
  return source
    .map((item) => {
      if (typeof item === 'string') return { id: item, object: 'model', created: 0 };
      if (!isObject(item) || !item.id) return null;
      return {
        ...item,
        object: item.object || 'model',
        owned_by: item.owned_by || config.upstreamProvider || 'gateway',
      };
    })
    .filter((item) => item?.id && !isDeprecatedModel(item.id));
}

export function mergeModelLists(...lists) {
  const byId = new Map();
  for (const list of lists) {
    for (const model of Array.isArray(list) ? list : []) {
      if (model?.id && !isDeprecatedModel(model.id) && !byId.has(model.id)) {
        byId.set(model.id, model);
      }
    }
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}
