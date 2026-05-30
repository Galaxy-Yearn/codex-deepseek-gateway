import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

function unquoteTomlString(value) {
  const trimmed = String(value || '').trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function stripInlineTomlComment(value) {
  let quote = '';
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quote) {
      if (quote === '"' && char === '\\' && !escaped) {
        escaped = true;
        continue;
      }
      if (char === quote && !escaped) {
        quote = '';
      }
      escaped = false;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      escaped = false;
      continue;
    }
    if (char === '#' && (index === 0 || /\s/.test(value[index - 1]))) {
      return value.slice(0, index).trimEnd();
    }
  }
  return value.trimEnd();
}

function defaultCodexConfigPath(env = process.env) {
  if (env.CODEX_CONFIG_FILE) return resolve(env.CODEX_CONFIG_FILE);
  const home = env.CODEX_HOME || join(env.USERPROFILE || env.HOME || '', '.codex');
  return join(home, 'config.toml');
}

export function readCodexConfig(env = process.env) {
  const filePath = defaultCodexConfigPath(env);
  const result = {
    modelProvider: '',
    model: '',
    modelReasoningEffort: '',
    modelReasoningSummary: '',
    modelSupportsReasoningSummaries: '',
    hideAgentReasoning: '',
  };
  if (!filePath || !existsSync(filePath)) return result;

  const text = readFileSync(filePath, 'utf8');
  let inTopLevel = true;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('[')) {
      inTopLevel = false;
      continue;
    }
    if (!inTopLevel) continue;
    const match = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    const value = unquoteTomlString(stripInlineTomlComment(rawValue));
    if (key === 'model_provider') result.modelProvider = value;
    if (key === 'model') result.model = value;
    if (key === 'model_reasoning_effort') result.modelReasoningEffort = value;
    if (key === 'model_reasoning_summary') result.modelReasoningSummary = value;
    if (key === 'model_supports_reasoning_summaries') result.modelSupportsReasoningSummaries = value;
    if (key === 'hide_agent_reasoning') result.hideAgentReasoning = value;
  }
  return result;
}
