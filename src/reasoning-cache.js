import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { isObject, safeJsonParse } from './common.js';

const CACHE_VERSION = 1;
const DEFAULT_MAX_MESSAGES = 1000;
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;

export class ReasoningCache {
  constructor({
    maxMessages = DEFAULT_MAX_MESSAGES,
    maxBytes = DEFAULT_MAX_BYTES,
    persistPath = '',
    legacyPath = '',
  } = {}) {
    this.map = new Map();
    this.maxMessages = positiveInteger(maxMessages, DEFAULT_MAX_MESSAGES);
    this.maxBytes = positiveInteger(maxBytes, DEFAULT_MAX_BYTES);
    this.persistPath = persistPath || '';
    this.legacyPath = legacyPath || '';
    this.fileBytes = 0;
    this.lastLoadError = null;
    this.lastPersistError = null;
    this.loadFromDisk();
    if (this.persistPath && !existsSync(this.persistPath) && this.legacyPath && existsSync(this.legacyPath)) {
      this.migrateLegacy();
    }
  }

  rememberAssistantMessage(message) {
    const shared = cloneAssistantMessage(message);
    const callIds = toolCallIds(shared);
    if (!callIds.length || callIds.every((callId) => sameJson(this.map.get(callId), shared))) return false;
    this.indexMessage(callIds, shared);
    this.persist(callIds, shared);
    return true;
  }

  getAssistantMessageForToolCall(callId) {
    if (!callId) return null;
    const message = this.map.get(String(callId));
    return message ? cloneAssistantMessage(message) : null;
  }

  loadFromDisk() {
    if (!this.persistPath || !existsSync(this.persistPath)) return;
    try {
      const raw = readFileSync(this.persistPath, 'utf8');
      const complete = !raw || raw.endsWith('\n');
      const content = complete ? raw : raw.slice(0, raw.lastIndexOf('\n') + 1);
      for (const line of content.split('\n')) {
        if (!line) continue;
        const parsed = safeJsonParse(line);
        if (!parsed.ok || !isObject(parsed.value) || parsed.value.version !== CACHE_VERSION) {
          throw new Error('Invalid reasoning cache record');
        }
        const callIds = Array.isArray(parsed.value.callIds) ? parsed.value.callIds.map(String) : [];
        if (!callIds.length || !isObject(parsed.value.message)) continue;
        this.indexMessage(callIds, cloneAssistantMessage(parsed.value.message));
      }
      this.fileBytes = Buffer.byteLength(raw, 'utf8');
      if (!complete || this.fileBytes > this.maxBytes) this.compact();
    } catch (error) {
      this.lastLoadError = error;
      this.map.clear();
      this.fileBytes = 0;
    }
  }

  migrateLegacy() {
    try {
      const parsed = safeJsonParse(readFileSync(this.legacyPath, 'utf8').replace(/^\uFEFF/, ''));
      if (!parsed.ok || !isObject(parsed.value)) return;
      this.loadLegacyPayload(parsed.value);
      const journalPath = `${this.legacyPath}.journal`;
      if (existsSync(journalPath)) this.loadLegacyJournal(journalPath);
      this.compact();
      rmSync(this.legacyPath, { force: true });
      rmSync(journalPath, { force: true });
      this.lastPersistError = null;
    } catch (error) {
      this.lastLoadError = error;
      this.map.clear();
      this.fileBytes = 0;
    }
  }

  loadLegacyPayload(payload) {
    const pool = Array.isArray(payload.assistantMessages) ? payload.assistantMessages : [];
    const stored = entriesFrom(payload.toolCallMessages);
    for (const [callId, value] of stored) {
      const message = resolveLegacyMessage(value, pool);
      if (callId && message) this.indexMessage([String(callId)], cloneAssistantMessage(message));
    }
    if (stored.length) return;
    for (const [, session] of entriesFrom(payload.sessions)) {
      for (const message of Array.isArray(session?.messages) ? session.messages : legacyHistoryMessages(session?.history)) {
        const callIds = toolCallIds(message);
        if (callIds.length) this.indexMessage(callIds, cloneAssistantMessage(message));
      }
    }
  }

  loadLegacyJournal(path) {
    const raw = readFileSync(path, 'utf8');
    const content = raw.endsWith('\n') ? raw : raw.slice(0, raw.lastIndexOf('\n') + 1);
    for (const line of content.split('\n')) {
      if (!line) continue;
      const parsed = safeJsonParse(line);
      if (!parsed.ok || !isObject(parsed.value)) throw new Error('Invalid legacy session journal record');
      if (parsed.value.clear === true) this.map.clear();
      for (const message of Array.isArray(parsed.value.assistantMessages) ? parsed.value.assistantMessages : []) {
        const callIds = toolCallIds(message);
        if (callIds.length) this.indexMessage(callIds, cloneAssistantMessage(message));
      }
      for (const [, session] of entriesFrom(parsed.value.sessions)) {
        for (const message of Array.isArray(session?.messages) ? session.messages : []) {
          const callIds = toolCallIds(message);
          if (callIds.length) this.indexMessage(callIds, cloneAssistantMessage(message));
        }
      }
    }
  }

  indexMessage(callIds, message) {
    for (const callId of callIds) {
      const key = String(callId);
      this.map.delete(key);
      this.map.set(key, message);
      while (this.map.size > this.maxMessages) this.map.delete(this.map.keys().next().value);
    }
  }

  persist(callIds, message) {
    if (!this.persistPath) return;
    try {
      mkdirSync(dirname(this.persistPath), { recursive: true });
      const serialized = serializeRecord(callIds, message);
      const recordBytes = Buffer.byteLength(serialized, 'utf8');
      if (this.fileBytes + recordBytes > this.maxBytes) {
        this.compact();
      } else {
        appendFileSync(this.persistPath, serialized, 'utf8');
        this.fileBytes += recordBytes;
      }
      this.lastPersistError = null;
    } catch (error) {
      this.lastPersistError = error;
    }
  }

  compact() {
    let serialized = this.serialize();
    while (Buffer.byteLength(serialized, 'utf8') > this.maxBytes && this.map.size) {
      this.map.delete(this.map.keys().next().value);
      serialized = this.serialize();
    }
    if (!serialized) {
      rmSync(this.persistPath, { force: true });
      this.fileBytes = 0;
      return;
    }
    mkdirSync(dirname(this.persistPath), { recursive: true });
    const tmpPath = `${this.persistPath}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmpPath, serialized, 'utf8');
    renameSync(tmpPath, this.persistPath);
    this.fileBytes = Buffer.byteLength(serialized, 'utf8');
  }

  serialize() {
    const groups = new Map();
    for (const [callId, message] of this.map.entries()) {
      const fingerprint = JSON.stringify(message);
      if (!groups.has(fingerprint)) groups.set(fingerprint, { callIds: [], message });
      groups.get(fingerprint).callIds.push(callId);
    }
    return Array.from(groups.values(), ({ callIds, message }) => serializeRecord(callIds, message)).join('');
  }
}

function serializeRecord(callIds, message) {
  return `${JSON.stringify({ version: CACHE_VERSION, callIds, message })}\n`;
}

function toolCallIds(message) {
  if (message?.role !== 'assistant' || !Array.isArray(message.tool_calls)) return [];
  return message.tool_calls.filter((toolCall) => toolCall?.id).map((toolCall) => String(toolCall.id));
}

function entriesFrom(value) {
  if (Array.isArray(value)) return value;
  if (isObject(value)) return Object.entries(value);
  return [];
}

function resolveLegacyMessage(value, pool) {
  if (isObject(value)) return value;
  if (Number.isInteger(value) && value >= 0 && value < pool.length && isObject(pool[value])) return pool[value];
  return null;
}

function legacyHistoryMessages(history) {
  const turns = Array.isArray(history) ? history : [];
  if (!turns.length) return [];
  if (turns.every((turn) => Array.isArray(turn?.historyMessages))) return turns.at(-1).historyMessages;
  const messages = [];
  for (const turn of turns) {
    if (Array.isArray(turn?.historyMessages)) messages.push(...turn.historyMessages);
    else if (Array.isArray(turn?.inputMessages)) messages.push(...turn.inputMessages);
    else if (Array.isArray(turn?.chatRequest?.messages)) messages.push(...turn.chatRequest.messages);
    if (turn?.assistantMessage) messages.push(turn.assistantMessage);
  }
  return messages;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function sameJson(left, right) {
  return left !== undefined && JSON.stringify(left) === JSON.stringify(right);
}

function cloneAssistantMessage(message) {
  return {
    ...message,
    tool_calls: Array.isArray(message?.tool_calls)
      ? message.tool_calls.map((toolCall) => ({
          ...toolCall,
          function: toolCall.function ? { ...toolCall.function } : toolCall.function,
        }))
      : undefined,
  };
}
