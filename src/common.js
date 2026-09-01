import { randomUUID } from 'node:crypto';

export const CODEX_SUMMARY_PREFIX_START = 'Another language model started to solve this problem and produced a summary of its thinking process.';
const CODEX_CONTEXTUAL_USER_WRAPPERS = [
  ['# AGENTS.md instructions', '</INSTRUCTIONS>'],
  ['<environment_context>', '</environment_context>'],
  ['<skill>', '</skill>'],
  ['<user_shell_command>', '</user_shell_command>'],
  ['<turn_aborted>', '</turn_aborted>'],
  ['<subagent_notification>', '</subagent_notification>'],
  ['<recommended_plugins>', '</recommended_plugins>'],
];
const LEGACY_EXEC_LIMIT_PREFIX = 'Warning: The maximum number of unified exec processes you can keep open is';
const LEGACY_APPLY_PATCH_PREFIX = 'Warning: apply_patch was requested via ';
const LEGACY_APPLY_PATCH_SUFFIX = 'Use the apply_patch tool instead of exec_command.';
const LEGACY_MODEL_MISMATCH_PREFIX = 'Warning: Your account was flagged for potentially high-risk cyber activity';

function contextualWrapperLength(value) {
  const text = String(value || '');
  const lower = text.toLowerCase();
  for (const [start, end] of CODEX_CONTEXTUAL_USER_WRAPPERS) {
    if (!lower.startsWith(start.toLowerCase())) continue;
    const endIndex = lower.indexOf(end.toLowerCase(), start.length);
    return endIndex < 0 ? 0 : endIndex + end.length;
  }
  const external = text.match(/^<external_([^>]+)>/);
  if (external) {
    const end = `</external_${external[1]}>`;
    const endIndex = lower.indexOf(end.toLowerCase(), external[0].length);
    return endIndex < 0 ? 0 : endIndex + end.length;
  }
  const hook = text.match(/^<hook_prompt\s+hook_run_id="[^"]+">/);
  if (hook) {
    const end = '</hook_prompt>';
    const endIndex = lower.indexOf(end, hook[0].length);
    return endIndex < 0 ? 0 : endIndex + end.length;
  }
  const internal = text.match(/^<codex_internal_context source="[a-z][a-z0-9_]*">/);
  if (internal) {
    const end = '</codex_internal_context>';
    const endIndex = lower.indexOf(end, internal[0].length);
    return endIndex < 0 ? 0 : endIndex + end.length;
  }
  if (lower.startsWith('<goal_context>')) {
    const end = '</goal_context>';
    const endIndex = lower.indexOf(end, '<goal_context>'.length);
    return endIndex < 0 ? 0 : endIndex + end.length;
  }
  return 0;
}

export function isCodexContextualUserText(value) {
  let text = String(value || '').trim();
  if (!text) return false;
  if (text.startsWith(LEGACY_EXEC_LIMIT_PREFIX) || text.startsWith(LEGACY_MODEL_MISMATCH_PREFIX)) return true;
  if (text.startsWith(LEGACY_APPLY_PATCH_PREFIX) && text.endsWith(LEGACY_APPLY_PATCH_SUFFIX)) return true;
  let matched = false;
  while (text) {
    const length = contextualWrapperLength(text);
    if (!length) return false;
    matched = true;
    text = text.slice(length).trim();
  }
  return matched;
}

export function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function generateId(prefix) {
  return `${prefix}_${randomUUID().replaceAll('-', '')}`;
}

export function normalizeRole(role) {
  if (role === 'developer') return 'system';
  return role || 'user';
}

export function toText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (!isObject(part)) return '';
        if (part.type === 'input_text' || part.type === 'output_text' || part.type === 'text') {
          return String(part.text ?? part.content ?? '');
        }
        if (typeof part.text === 'string') return part.text;
        if (part.type === 'message') return toText(part.content);
        return '';
      })
      .filter(Boolean)
      .join('');
  }
  if (isObject(content)) {
    if (content.type === 'message') return toText(content.content);
    if (content.type === 'input_text' || content.type === 'output_text' || content.type === 'text') {
      return String(content.text ?? content.content ?? '');
    }
    if (typeof content.text === 'string') return content.text;
  }
  return '';
}

export function hasPseudoToolCallMarkup(value) {
  const text = toText(value).trim();
  if (!text) return false;
  if (/<[^>]*DSML[^>]*(?:tool_calls|invoke)/i.test(text)) return true;
  if (/<[^>]*invoke\s+name\s*=/i.test(text)) return true;
  if (/^\s*```(?:json|xml|dsml)?\s*[\s\S]*\btool_calls\b/i.test(text)) return true;
  return /^\s*\{[\s\S]*"tool_calls"\s*:/i.test(text);
}

export function neutralizePseudoToolCallMarkup(value) {
  return String(value ?? '')
    .replace(/<([^>]*(?:DSML|\/?invoke\b|tool_calls)[^>]*)>/gi, '⟦$1⟧')
    .replace(/DSML/gi, 'D·S·M·L');
}

export function parseBoolean(value, defaultValue = false) {
  if (value == null || value === '') return defaultValue;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return defaultValue;
}

export function parseList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  if (value == null || value === '') return [];
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function isControlCodePoint(codePoint) {
  return (codePoint >= 0 && codePoint <= 31) || (codePoint >= 127 && codePoint <= 159);
}

export function normalizeSearchQuery(value, maxChars) {
  const source = String(value ?? '');
  let stripped = '';
  for (const character of source) {
    stripped += isControlCodePoint(character.codePointAt(0)) ? ' ' : character;
  }
  const text = stripped.replace(/\s+/g, ' ').trim();
  if (!maxChars || text.length <= maxChars) return text;
  return text.slice(0, maxChars).trim();
}

export function joinUrl(baseUrl, path) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const suffix = String(path || '').startsWith('/') ? String(path || '') : `/${String(path || '')}`;
  return `${base}${suffix}`;
}

export const SSE_PARSER_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

export class SseParser {
  constructor({ maxBufferBytes, preserveDone = false } = {}) {
    this.decoder = new TextDecoder();
    this.buffer = '';
    this.preserveDone = Boolean(preserveDone);
    this.maxBufferBytes = Number.isFinite(maxBufferBytes) && maxBufferBytes > 0
      ? maxBufferBytes
      : SSE_PARSER_MAX_BUFFER_BYTES;
  }

  push(chunk) {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    this.buffer = this.buffer.replace(/\r\n/g, '\n');
    this.enforceBufferLimit();
    return this.drain(false);
  }

  end() {
    this.buffer += this.decoder.decode();
    this.buffer = this.buffer.replace(/\r\n/g, '\n');
    this.enforceBufferLimit();
    return this.drain(true);
  }

  enforceBufferLimit() {
    if (this.buffer.length <= this.maxBufferBytes) return;
    this.buffer = '';
    const error = new Error(`SSE buffer exceeded ${this.maxBufferBytes} bytes without a frame boundary`);
    error.code = 'sse_buffer_overflow';
    throw error;
  }

  drain(flush) {
    const events = [];
    while (true) {
      const boundary = this.buffer.indexOf('\n\n');
      if (boundary < 0) break;
      const frame = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 2);
      const parsed = this.parseFrame(frame);
      if (parsed) events.push(parsed);
    }
    if (flush && this.buffer.trim()) {
      const parsed = this.parseFrame(this.buffer);
      if (parsed) events.push(parsed);
      this.buffer = '';
    }
    return events;
  }

  parseFrame(frame) {
    const lines = String(frame).replace(/\r\n/g, '\n').split('\n');
    let event = 'message';
    const dataLines = [];
    for (const line of lines) {
      if (!line) continue;
      if (line.startsWith('event:')) {
        event = line.slice(6).trim();
        continue;
      }
      if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).replace(/^\s/, ''));
      }
    }
    if (dataLines.length === 0) return null;
    const data = dataLines.join('\n');
    if (data === '[DONE]' && !this.preserveDone) return { done: true };
    return { event, data };
  }
}

export function safeJsonParse(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, error };
  }
}

export function parseJsonObject(value, { source = 'JSON value', throwOnInvalid = false } = {}) {
  if (isObject(value)) return value;
  if (!value || typeof value !== 'string') {
    if (throwOnInvalid && value) throw new Error(`${source} must be a JSON object`);
    return {};
  }
  const parsed = safeJsonParse(value);
  if (parsed.ok && isObject(parsed.value)) return parsed.value;
  if (throwOnInvalid) {
    if (parsed.ok) throw new Error(`${source} must be a JSON object`);
    throw parsed.error;
  }
  return {};
}
