import { randomUUID } from 'node:crypto';

export function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function generateId(prefix) {
  return `${prefix}_${randomUUID().replaceAll('-', '')}`;
}

export function normalizeRole(role, provider = 'generic') {
  if (provider === 'deepseek' && role === 'developer') return 'system';
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

export function mapDeepSeekReasoningEffort(effort) {
  if (!effort) return undefined;
  const normalized = String(effort).toLowerCase().replaceAll('_', '-');
  if (normalized === 'low') return undefined;
  if (normalized === 'none' || normalized === 'disabled' || normalized === 'off' || normalized === 'false') return undefined;
  if (normalized === 'xhigh' || normalized === 'max') return 'max';
  if (normalized === 'medium' || normalized === 'high') return 'high';
  return undefined;
}

export function joinUrl(baseUrl, path) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const suffix = String(path || '').startsWith('/') ? String(path || '') : `/${String(path || '')}`;
  return `${base}${suffix}`;
}

export class SseParser {
  constructor() {
    this.decoder = new TextDecoder();
    this.buffer = '';
  }

  push(chunk) {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    this.buffer = this.buffer.replace(/\r\n/g, '\n');
    return this.drain(false);
  }

  end() {
    this.buffer += this.decoder.decode();
    this.buffer = this.buffer.replace(/\r\n/g, '\n');
    return this.drain(true);
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
    if (data === '[DONE]') return { done: true };
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
