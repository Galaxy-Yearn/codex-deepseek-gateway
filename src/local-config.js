import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isObject, safeJsonParse } from './common.js';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function normalizeEnvName(key) {
  return String(key)
    .replace(/[A-Z]/g, (letter) => `_${letter}`)
    .replace(/[-.\s]+/g, '_')
    .replace(/^_+/, '')
    .toUpperCase();
}

function flattenConfig(value, prefix = '') {
  const entries = {};
  if (!isObject(value)) return entries;
  for (const [key, child] of Object.entries(value)) {
    const childKey = prefix ? `${prefix}_${normalizeEnvName(key)}` : normalizeEnvName(key);
    if (isObject(child)) {
      Object.assign(entries, flattenConfig(child, childKey));
    } else if (child !== undefined && child !== null) {
      entries[childKey] = String(child);
    }
  }
  return entries;
}

export function readLocalConfigFile(path = resolve(PROJECT_ROOT, 'config', 'gateway.local.json')) {
  if (!path || !existsSync(path)) return {};
  const parsed = safeJsonParse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
  if (!parsed.ok || !isObject(parsed.value)) {
    throw new Error(`${path} must contain a JSON object`);
  }
  return flattenConfig(parsed.value);
}

export function mergeLocalConfig(env = process.env, cwd = PROJECT_ROOT) {
  const configPath = env.GATEWAY_CONFIG_FILE
    ? resolve(cwd, env.GATEWAY_CONFIG_FILE)
    : resolve(cwd, 'config', 'gateway.local.json');
  const fileConfig = readLocalConfigFile(configPath);
  if (fileConfig.UPSTREAM_API_KEY === 'sk-REPLACE_ME') {
    delete fileConfig.UPSTREAM_API_KEY;
  }
  return {
    ...fileConfig,
    ...env,
  };
}
