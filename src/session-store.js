import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { isObject, safeJsonParse } from './common.js';

const SESSION_STORE_VERSION = 4;
const DEFAULT_MAX_SESSIONS = 500;
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;

export class SessionStore {
  constructor({
    maxToolCallMessages = 1000,
    maxSessions = DEFAULT_MAX_SESSIONS,
    maxBytes = DEFAULT_MAX_BYTES,
    persistPath = '',
  } = {}) {
    this.map = new Map();
    this.toolCallMessages = new Map();
    this.conversations = new Map();
    this.maxToolCallMessages = positiveInteger(maxToolCallMessages, 1000);
    this.maxSessions = positiveInteger(maxSessions, DEFAULT_MAX_SESSIONS);
    this.maxBytes = positiveInteger(maxBytes, DEFAULT_MAX_BYTES);
    this.persistPath = persistPath || '';
    this.lastLoadError = null;
    this.lastPersistError = null;
    this.loadFromDisk();
  }

  get(id) {
    if (!id) return null;
    return this.map.get(String(id)) || null;
  }

  set(id, value) {
    if (!id) return value;
    const session = normalizeSession(id, value);
    this.map.set(String(id), session);
    for (const message of session.messages) this.indexAssistantMessage(message);
    this.pruneSessions();
    this.persist();
    return value;
  }

  getConversation(id) {
    if (!id) return null;
    const responseId = this.conversations.get(String(id));
    return responseId ? this.get(responseId) : null;
  }

  setConversation(id, responseId) {
    if (!id || !responseId) return;
    this.conversations.set(String(id), String(responseId));
    this.dropDanglingConversations();
    this.persist();
  }

  indexAssistantMessage(message) {
    if (message?.role !== 'assistant' || !Array.isArray(message.tool_calls)) return false;
    const shared = cloneAssistantMessage(message);
    let indexed = false;
    for (const toolCall of message.tool_calls) {
      if (!toolCall?.id) continue;
      const key = String(toolCall.id);
      this.toolCallMessages.delete(key);
      this.toolCallMessages.set(key, shared);
      indexed = true;
      while (this.toolCallMessages.size > this.maxToolCallMessages) {
        const oldestKey = this.toolCallMessages.keys().next().value;
        this.toolCallMessages.delete(oldestKey);
      }
    }
    return indexed;
  }

  rememberAssistantMessage(message) {
    if (!this.indexAssistantMessage(message)) return false;
    this.persist();
    return true;
  }

  getAssistantMessageForToolCall(callId) {
    if (!callId) return null;
    const message = this.toolCallMessages.get(String(callId));
    return message ? cloneAssistantMessage(message) : null;
  }

  delete(id) {
    if (!id) return false;
    const deleted = this.map.delete(String(id));
    if (deleted) {
      this.dropDanglingConversations();
      this.persist();
    }
    return deleted;
  }

  clear() {
    this.map.clear();
    this.toolCallMessages.clear();
    this.conversations.clear();
    this.persist();
  }

  loadFromDisk() {
    if (!this.persistPath || !existsSync(this.persistPath)) return;
    try {
      const parsed = safeJsonParse(readFileSync(this.persistPath, 'utf8').replace(/^﻿/, ''));
      if (!parsed.ok || !isObject(parsed.value)) return;
      this.map.clear();
      this.conversations.clear();
      this.toolCallMessages.clear();
      for (const [id, session] of entriesFrom(parsed.value.sessions)) {
        if (!id || !isObject(session)) continue;
        this.map.set(String(id), normalizeSession(id, session));
      }
      for (const [id, responseId] of entriesFrom(parsed.value.conversations)) {
        if (!id || !responseId) continue;
        const normalizedResponseId = String(responseId);
        if (this.map.has(normalizedResponseId)) this.conversations.set(String(id), normalizedResponseId);
      }
      const messagePool = Array.isArray(parsed.value.assistantMessages) ? parsed.value.assistantMessages : [];
      const storedToolCallMessages = entriesFrom(parsed.value.toolCallMessages);
      const sharedMessages = new Map();
      for (const [callId, stored] of storedToolCallMessages) {
        if (!callId) continue;
        const message = resolveStoredToolCallMessage(stored, messagePool);
        if (!message) continue;
        const fingerprint = JSON.stringify(message);
        if (!sharedMessages.has(fingerprint)) sharedMessages.set(fingerprint, message);
        this.toolCallMessages.set(String(callId), sharedMessages.get(fingerprint));
        while (this.toolCallMessages.size > this.maxToolCallMessages) {
          this.toolCallMessages.delete(this.toolCallMessages.keys().next().value);
        }
      }
      this.pruneSessions();
      if (!storedToolCallMessages.length) this.rebuildToolCallIndex();
    } catch (error) {
      this.lastLoadError = error;
      this.map.clear();
      this.conversations.clear();
      this.toolCallMessages.clear();
    }
  }

  persist() {
    if (!this.persistPath) return;
    try {
      mkdirSync(dirname(this.persistPath), { recursive: true });
      let serialized = this.serializePayload();
      while (serialized.length > this.maxBytes && this.map.size > 1) {
        this.map.delete(this.map.keys().next().value);
        this.dropDanglingConversations();
        serialized = this.serializePayload();
      }
      while (serialized.length > this.maxBytes && this.toolCallMessages.size > 0) {
        this.toolCallMessages.delete(this.toolCallMessages.keys().next().value);
        serialized = this.serializePayload();
      }
      const tmpPath = `${this.persistPath}.tmp-${process.pid}-${Date.now()}`;
      writeFileSync(tmpPath, serialized, 'utf8');
      renameSync(tmpPath, this.persistPath);
      this.lastPersistError = null;
    } catch (error) {
      this.lastPersistError = error;
    }
  }

  serializePayload() {
    return `${JSON.stringify(this.persistPayload(), null, 2)}\n`;
  }

  persistPayload() {
    const assistantMessages = [];
    const poolIndexes = new Map();
    const toolCallMessages = [];
    for (const [callId, message] of this.toolCallMessages.entries()) {
      const fingerprint = JSON.stringify(message);
      let index = poolIndexes.get(fingerprint);
      if (index === undefined) {
        index = assistantMessages.length;
        poolIndexes.set(fingerprint, index);
        assistantMessages.push(message);
      }
      toolCallMessages.push([callId, index]);
    }
    return {
      version: SESSION_STORE_VERSION,
      sessions: Array.from(this.map.entries()),
      conversations: Array.from(this.conversations.entries()),
      assistantMessages,
      toolCallMessages,
    };
  }

  pruneSessions() {
    while (this.map.size > this.maxSessions) {
      const oldestKey = this.map.keys().next().value;
      this.map.delete(oldestKey);
    }
    this.dropDanglingConversations();
  }

  dropDanglingConversations() {
    for (const [conversationId, responseId] of this.conversations.entries()) {
      if (!this.map.has(responseId)) this.conversations.delete(conversationId);
    }
  }

  rebuildToolCallIndex() {
    this.toolCallMessages.clear();
    for (const session of this.map.values()) {
      for (const message of Array.isArray(session?.messages) ? session.messages : []) {
        this.indexAssistantMessage(message);
      }
    }
  }
}

function normalizeSession(id, value) {
  const messages = Array.isArray(value?.messages) ? value.messages : legacyHistoryMessages(value?.history);
  return { id: String(value?.id || id), messages: stripLeadingSystemMessages(messages) };
}

function legacyHistoryMessages(history) {
  const turns = Array.isArray(history) ? history : [];
  if (!turns.length) return [];
  if (turns.every((turn) => Array.isArray(turn?.historyMessages))) {
    return turns[turns.length - 1].historyMessages.slice();
  }
  const messages = [];
  for (const turn of turns) {
    if (Array.isArray(turn?.historyMessages)) {
      messages.push(...turn.historyMessages);
      continue;
    }
    if (Array.isArray(turn?.inputMessages)) {
      messages.push(...turn.inputMessages);
    } else if (Array.isArray(turn?.chatRequest?.messages)) {
      messages.push(...turn.chatRequest.messages);
    }
    if (turn?.assistantMessage) messages.push(turn.assistantMessage);
  }
  return messages;
}

function stripLeadingSystemMessages(messages) {
  let start = 0;
  while (start < messages.length && (messages[start]?.role === 'system' || messages[start]?.role === 'developer')) {
    start += 1;
  }
  return start ? messages.slice(start) : messages;
}

function entriesFrom(value) {
  if (Array.isArray(value)) return value;
  if (isObject(value)) return Object.entries(value);
  return [];
}

function resolveStoredToolCallMessage(stored, messagePool) {
  if (isObject(stored)) return stored;
  if (Number.isInteger(stored) && stored >= 0 && stored < messagePool.length && isObject(messagePool[stored])) {
    return messagePool[stored];
  }
  return null;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function cloneAssistantMessage(message) {
  return {
    ...message,
    tool_calls: Array.isArray(message.tool_calls)
      ? message.tool_calls.map((toolCall) => ({
          ...toolCall,
          function: toolCall.function ? { ...toolCall.function } : toolCall.function,
        }))
      : undefined,
  };
}
