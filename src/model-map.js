import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isObject, mapDeepSeekReasoningEffort } from './common.js';

const DEEPSEEK_V4_MODELS = ['deepseek-v4-flash', 'deepseek-v4-pro'];
const DEPRECATED_MODEL_PATTERN = /^deepseek-(?:chat|reasoner)$/;

function deepseekV4Aliases() {
  const aliases = {};
  for (const model of DEEPSEEK_V4_MODELS) {
    aliases[model] = { model, thinking: 'auto' };
  }
  return aliases;
}

export const DEFAULT_MODEL_ALIASES = deepseekV4Aliases();

function parseJsonObject(value, source) {
  if (!value) return {};
  const parsed = JSON.parse(value);
  if (!isObject(parsed)) {
    throw new Error(`${source} must be a JSON object`);
  }
  return parsed;
}

function readJsonFile(filePath) {
  if (!filePath || !existsSync(filePath)) return {};
  return parseJsonObject(readFileSync(filePath, 'utf8'), filePath);
}

export function loadModelAliases(env = process.env, cwd = process.cwd()) {
  const defaultFile = resolve(cwd, 'config', 'model-aliases.json');
  const filePath = env.MODEL_ALIASES_FILE ? resolve(cwd, env.MODEL_ALIASES_FILE) : defaultFile;
  const fileAliases = readJsonFile(filePath);
  const envAliases = parseJsonObject(env.MODEL_ALIASES_JSON, 'MODEL_ALIASES_JSON');
  return {
    ...DEFAULT_MODEL_ALIASES,
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

function effortDisablesThinking(effort) {
  if (effort == null) return false;
  const normalized = String(effort).toLowerCase().replaceAll('_', '-');
  return normalized === 'low' || normalized === 'none' || normalized === 'disabled' || normalized === 'off' || normalized === 'false';
}

export function deepseekReasoningPayload({ alias, reasoning } = {}) {
  const requestEffort = isObject(reasoning) ? reasoning.effort : undefined;
  const aliasThinking = normalizeThinking(alias?.thinking);
  const aliasEffort = alias?.reasoningEffort;

  if (aliasThinking === 'disabled' || (aliasThinking === 'auto' && effortDisablesThinking(requestEffort))) {
    return { thinking: { type: 'disabled' } };
  }

  const payload = {};
  const effort = aliasEffort ?? (effortDisablesThinking(requestEffort) ? undefined : requestEffort);
  if (aliasThinking === 'enabled' || effort) {
    payload.thinking = { type: 'enabled' };
  }
  if (effort) {
    const reasoningEffort = mapDeepSeekReasoningEffort(effort);
    if (reasoningEffort) payload.reasoning_effort = reasoningEffort;
  }
  return payload;
}

export function listModels(config = {}) {
  const aliases = isObject(config.modelAliases) ? config.modelAliases : {};
  const configuredModels = Array.isArray(config.upstreamModels) ? config.upstreamModels : [];
  return [...new Set([...Object.keys(aliases), ...configuredModels])]
    .filter((id) => id && !isDeprecatedModel(id))
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
