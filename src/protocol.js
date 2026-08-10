import { createHash } from 'node:crypto';

import { CODEX_SUMMARY_PREFIX_START, generateId, isObject, normalizeRole, parseJsonObject, safeJsonParse, toText } from './common.js';
import {
  deepseekReasoningPayload,
  resolveModelAlias,
} from './model-map.js';
import { webSearchEvidenceNote } from './web-search-evidence.js';
import {
  applyPatchCustomToolShim,
  applyPatchLoweringFromArguments,
  applyPatchReplayArguments,
  isApplyPatchGrammarTool,
  isApplyPatchInputMode,
} from './apply-patch-bridge.js';

const TEXT_PART_TYPES = new Set(['input_text', 'output_text', 'text']);
const INPUT_CONTENT_PART_TYPES = new Set(['input_text', 'input_image', 'input_file', 'input_audio']);
const TOOL_CALL_TYPES = new Set([
  'function_call',
  'custom_tool_call',
  'local_shell_call',
  'computer_call',
  'mcp_call',
  'web_search_call',
  'tool_search_call',
  'file_search_call',
  'code_interpreter_call',
  'image_generation_call',
]);
const TOOL_OUTPUT_TYPES = new Set([
  'function_call_output',
  'custom_tool_call_output',
  'local_shell_call_output',
  'computer_call_output',
  'mcp_call_output',
  'web_search_call_output',
  'tool_search_output',
  'file_search_call_output',
  'code_interpreter_call_output',
  'image_generation_call_output',
]);
const CHAT_HISTORY_IGNORED_TOOL_ITEM_TYPES = new Set([
  'web_search_call_output',
]);
const EMULATED_HOSTED_TOOL_TYPES = new Set(['web_search', 'web_search_preview']);
const BRIDGED_RESPONSES_TOOL_TYPES = new Set(['tool_search']);
const UNSUPPORTED_HOSTED_TOOL_TYPES = new Set([
  'file_search',
  'code_interpreter',
  'image_generation',
  'computer',
  'computer_use',
  'mcp',
  'local_shell',
]);
const DEEPSEEK_TOOL_INSTRUCTIONS_MARKER = 'The tools in this request are real callable functions available now.';
const DEEPSEEK_TOOL_INSTRUCTIONS = [
  DEEPSEEK_TOOL_INSTRUCTIONS_MARKER,
  'Choose the most direct tool whose declared scope matches the target.',
  'Treat every stated prerequisite and parameter provenance rule as mandatory. Never invent handles, IDs, URIs, resource names, or prior tool results; when a parameter must come from another tool, obtain it first.',
  'When needed, use Chat Completions tool_calls with JSON arguments that match the schema.',
  'Never write tool calls in assistant text, including as XML, DSML, or JSON, or claim a listed function is unavailable merely because its name is unfamiliar.',
].join(' ');
const CUSTOM_TOOL_FORMAT_CONTRACT = 'Follow the declared format exactly. Preserve every required literal token, delimiter, whitespace constraint, and line boundary. Emit no prose or markdown outside that format.';
const DEEPSEEK_CUSTOM_TOOL_INSTRUCTIONS = 'Codex custom tools are callable functions here. Follow each function schema exactly; the runtime will convert your arguments into the native tool input.';
const DEEPSEEK_COMPACTION_INSTRUCTIONS_MARKER = 'A Codex context checkpoint is present in this request.';
const DEEPSEEK_COMPACTION_INSTRUCTIONS = `${DEEPSEEK_COMPACTION_INSTRUCTIONS_MARKER} Read its Execute section as the sole task authority and perform only Next when Status is active. When Status is blocked, wait for Blocker to clear before Next; when idle, no task is active. Working State and Memory preserve context but never create pending work. A later real user message updates or replaces the checkpoint task.`;
export const INTERNAL_COMMENTARY_TOOL = 'commentary';
const DEEPSEEK_COMMENTARY_INSTRUCTIONS = 'When making other tool calls, include exactly one commentary call first in the same tool_calls array. Keep its text concise and user-visible; commentary is progress, not a final answer.';
const INTERNAL_COMMENTARY_TOOL_DEFINITION = {
  type: 'function',
  function: {
    name: INTERNAL_COMMENTARY_TOOL,
    description: 'User-visible progress update for the current operation. When other tools are called, place this call first.',
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'One or two short sentences stating the current action or result.',
        },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
};
const CHAT_FUNCTION_NAME_MAX_CHARS = 64;
const TOOL_NAME_HASH_CHARS = 8;
const DEEPSEEK_TOOL_DESCRIPTION_SOFT_CHARS = 900;
const DEEPSEEK_SCHEMA_DESCRIPTION_SOFT_CHARS = 480;
const DEEPSEEK_MAX_FUNCTION_TOOLS = 128;
const CODEX_TOOL_SEARCH_TOOL_NAME = 'tool_search';

function jsonString(value) {
  if (typeof value === 'string') return value;
  return JSON.stringify(value ?? {});
}

function sanitizeFunctionName(name, fallback = 'tool_call', maxChars = CHAT_FUNCTION_NAME_MAX_CHARS) {
  const fallbackName = String(fallback || 'tool_call')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/^_+/, '')
    .slice(0, maxChars) || 'tool_call';
  const candidate = String(name || fallbackName)
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/^_+/, '')
    .slice(0, maxChars);
  return candidate || fallbackName;
}

function stableToolNameHash(parts) {
  const hashInput = parts.map((part) => String(part ?? '')).join('\0');
  return createHash('sha256').update(hashInput).digest('hex').slice(0, TOOL_NAME_HASH_CHARS);
}

function appendToolNameHash(name, hash, fallback = 'tool_call') {
  const suffix = `__${hash}`;
  const headChars = Math.max(1, CHAT_FUNCTION_NAME_MAX_CHARS - suffix.length);
  return `${sanitizeFunctionName(name, fallback, headChars)}${suffix}`;
}

function toolNamespace(tool) {
  if (!isObject(tool)) return '';
  return String(tool.namespace || tool.function?.namespace || '').trim();
}

function toolBaseName(tool, fallback = 'tool_call') {
  if (!isObject(tool)) return fallback;
  if (isObject(tool.function) && tool.function.name) return tool.function.name;
  return tool.name || tool.tool_name || tool.toolName || tool.server_label || fallback;
}

function encodeToolName(namespace, name, fallback = 'tool_call') {
  const rawNamespace = String(namespace || '').trim();
  const rawName = String(name || fallback);
  const baseName = sanitizeFunctionName(rawName, fallback);
  const encodedNamespace = rawNamespace ? sanitizeFunctionName(rawNamespace, 'namespace') : '';
  const candidate = encodedNamespace ? `${encodedNamespace}__${baseName}` : baseName;
  const encoded = sanitizeFunctionName(candidate, fallback);
  const rawCandidate = rawNamespace ? `${rawNamespace}__${rawName}` : rawName;
  if (encoded === rawCandidate && rawCandidate.length <= CHAT_FUNCTION_NAME_MAX_CHARS) {
    return encoded;
  }
  return appendToolNameHash(candidate, stableToolNameHash([rawNamespace, rawName, fallback]), fallback);
}

function decodedToolName(name, toolNames) {
  const value = String(name || '');
  const known = toolNames?.get(value);
  if (!known) return { name: value };
  return omitUndefined({
    namespace: known.namespace,
    name: known.original_name || known.name,
  });
}

function isCodexToolSearchTool(name) {
  return String(name || '') === CODEX_TOOL_SEARCH_TOOL_NAME;
}

function toolChoiceDisablesTools(toolChoice) {
  if (String(toolChoice || '').toLowerCase() === 'none') return true;
  return isObject(toolChoice) && String(toolChoice.type || '').toLowerCase() === 'none';
}

function hasChatToolCalls(message) {
  return Array.isArray(message?.tool_calls) && message.tool_calls.length > 0;
}

function omitUndefined(value) {
  if (!isObject(value)) return value;
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (child !== undefined) result[key] = child;
  }
  return result;
}

function compactText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function compactStructuredText(value, softChars) {
  const lines = String(value ?? '').replace(/\r\n?/g, '\n').split('\n');
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines.at(-1).trim()) lines.pop();
  const structured = lines.join('\n').replace(/\n(?:[ \t]*\n){2,}/g, '\n\n');
  if (!structured) return '';
  const compact = compactText(structured);
  return compact.length <= softChars ? compact : structured;
}

function shortenText(value, maxChars) {
  const text = compactText(value);
  if (!text || text.length <= maxChars) return text;
  if (maxChars <= 16) return `${text.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
  const marker = ' ... ';
  const contentChars = maxChars - marker.length;
  const headChars = Math.max(24, Math.floor(contentChars * 0.72));
  const tailChars = Math.max(12, contentChars - headChars);
  const headSlice = text.slice(0, headChars);
  const headBreak = Math.max(headSlice.lastIndexOf('. '), headSlice.lastIndexOf('; '), headSlice.lastIndexOf(', '), headSlice.lastIndexOf(' '));
  const head = headSlice.slice(0, headBreak >= Math.floor(headChars * 0.55) ? headBreak : headSlice.length).trimEnd();
  const tailSlice = text.slice(-tailChars);
  const tailBreak = Math.max(tailSlice.indexOf('. '), tailSlice.indexOf('; '), tailSlice.indexOf(', '), tailSlice.indexOf(' '));
  const tail = tailSlice.slice(tailBreak >= 0 && tailBreak <= Math.floor(tailChars * 0.45) ? tailBreak + 1 : 0).trimStart();
  return `${head}${marker}${tail}`.slice(0, maxChars);
}

function textPart(text) {
  return { type: 'text', text: String(text ?? '') };
}

function normalizeImageUrl(value, source = {}) {
  const imageUrl = {};
  if (typeof value === 'string') {
    imageUrl.url = value;
  } else if (isObject(value)) {
    Object.assign(imageUrl, value);
  }
  if (source.url !== undefined && imageUrl.url === undefined) imageUrl.url = source.url;
  if (source.image_url !== undefined && imageUrl.url === undefined && typeof source.image_url === 'string') {
    imageUrl.url = source.image_url;
  }
  if (source.file_id !== undefined && imageUrl.file_id === undefined) imageUrl.file_id = source.file_id;
  if (source.detail !== undefined && imageUrl.detail === undefined) imageUrl.detail = source.detail;
  return Object.keys(imageUrl).length ? imageUrl : null;
}

function normalizeFilePart(value, source = {}) {
  const file = isObject(value) ? { ...value } : {};
  for (const key of ['file_id', 'file_data', 'file_url', 'filename', 'mime_type']) {
    if (source[key] !== undefined && file[key] === undefined) file[key] = source[key];
  }
  if (source.url !== undefined && file.file_url === undefined) file.file_url = source.url;
  return Object.keys(file).length ? file : null;
}

function normalizeAudioPart(value, source = {}) {
  const inputAudio = isObject(value) ? { ...value } : {};
  for (const key of ['data', 'format', 'file_id', 'mime_type']) {
    if (source[key] !== undefined && inputAudio[key] === undefined) inputAudio[key] = source[key];
  }
  return Object.keys(inputAudio).length ? inputAudio : null;
}

function contentPartToChatPart(part) {
  if (typeof part === 'string') return textPart(part);
  if (!isObject(part)) return null;

  if (TEXT_PART_TYPES.has(part.type) || (part.type === undefined && typeof part.text === 'string')) {
    return textPart(part.text ?? part.content ?? '');
  }

  if (part.type === 'input_image' || part.type === 'output_image' || part.type === 'image_url') {
    const imageUrl = normalizeImageUrl(part.image_url, part);
    return imageUrl ? { type: 'image_url', image_url: imageUrl } : null;
  }

  if (part.type === 'input_file' || part.type === 'output_file' || part.type === 'file') {
    const file = normalizeFilePart(part.file, part);
    return file ? { type: 'file', file } : null;
  }

  if (part.type === 'input_audio') {
    const inputAudio = normalizeAudioPart(part.input_audio, part);
    return inputAudio ? { type: 'input_audio', input_audio: inputAudio } : null;
  }

  if (part.type === 'refusal') {
    return { type: 'text', text: String(part.refusal ?? part.text ?? '') };
  }

  return null;
}

function contentToChatContent(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  const parts = Array.isArray(content) ? content.map(contentPartToChatPart).filter(Boolean) : [contentPartToChatPart(content)].filter(Boolean);
  if (!parts.length) return toText(content);
  if (parts.every((part) => part.type === 'text')) {
    return parts.map((part) => part.text).join('');
  }
  return parts;
}

function isInputContentPart(item) {
  return isObject(item) && INPUT_CONTENT_PART_TYPES.has(item.type);
}

function toolCallId(item) {
  return item.call_id || item.callId || item.id || generateId('call');
}

function toolName(item) {
  return encodeToolName(
    toolNamespace(item),
      item.name ||
      item.tool_name ||
      item.toolName ||
      item.server_label ||
      String(item.type || 'tool_call').replace(/_call$/, ''),
  );
}

function toolArguments(item) {
  if (item.type === 'function_call' || item.type === 'tool_search_call') return jsonString(item.arguments ?? {});
  if (item.type === 'custom_tool_call' && typeof item.arguments === 'string' && item.arguments) return item.arguments;
  if (item.type === 'custom_tool_call' && item.input !== undefined) return jsonString({ input: item.input });
  if (item.arguments !== undefined) return jsonString(item.arguments);
  if (item.input !== undefined) return jsonString({ input: item.input });
  if (item.action !== undefined) return jsonString({ action: item.action });
  if (item.query !== undefined) return jsonString({ query: item.query });
  if (item.code !== undefined) return jsonString({ code: item.code });
  if (item.command !== undefined) return jsonString({ command: item.command });
  return jsonString({ type: item.type });
}

function chatToolCallFromResponseItem(item) {
  return {
    id: toolCallId(item),
    type: 'function',
    function: {
      name: toolName(item),
      arguments: toolArguments(item),
    },
  };
}

const GATEWAY_ENCRYPTED_REASONING_PREFIX = 'dsgw1:';

function encodeGatewayReasoning(text) {
  const value = String(text ?? '');
  if (!value) return null;
  return `${GATEWAY_ENCRYPTED_REASONING_PREFIX}${Buffer.from(value, 'utf8').toString('base64')}`;
}

function decodeGatewayReasoning(encryptedContent) {
  if (typeof encryptedContent !== 'string') return '';
  if (!encryptedContent.startsWith(GATEWAY_ENCRYPTED_REASONING_PREFIX)) return '';
  try {
    return Buffer.from(encryptedContent.slice(GATEWAY_ENCRYPTED_REASONING_PREFIX.length), 'base64').toString('utf8');
  } catch {
    return '';
  }
}

function reasoningTextFromItem(item) {
  if (!isObject(item)) return '';
  if (typeof item.reasoning_content === 'string') return normalizeReasoningContent(item.reasoning_content);
  const decoded = decodeGatewayReasoning(item.encrypted_content);
  if (decoded) return normalizeReasoningContent(decoded);
  const rawParts = [];
  if (typeof item.text === 'string') rawParts.push(item.text);
  if (typeof item.content === 'string') rawParts.push(item.content);
  if (Array.isArray(item.content)) {
    for (const part of item.content) {
      if (typeof part === 'string') {
        rawParts.push(part);
        continue;
      }
      if (!isObject(part)) continue;
      if (part.type === 'reasoning_text' || part.type === 'text' || part.type === 'output_text') {
        rawParts.push(String(part.text ?? part.content ?? ''));
      }
    }
  }
  const rawText = rawParts.filter(Boolean).join('');
  return normalizeReasoningContent(rawText);
}

function normalizeReasoningContent(text) {
  return String(text ?? '').replace(/\r\n?/g, '\n').trimEnd();
}

function normalizeReasoningDisplayText(text) {
  const value = normalizeReasoningContent(text);
  if (!value) return '';
  const plain = value
    .split('\n')
    .map((line) => line
      .replace(/^[ \t]{0,3}(?:`{3,}|~{3,}).*$/, '')
      .replace(/^[ \t]{0,3}#{1,6}[ \t]+/, '')
      .replace(/^[ \t]{0,3}>[ \t]?/, '')
      .replace(/^[ \t]*[-*+][ \t]+(?:\[[ xX]\][ \t]+)?/, '• ')
      .replace(/^[ \t]*(\d+)\.[ \t]+/, '$1) ')
      .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/`([^`]*)`/g, '$1')
      .replace(/(\*\*|__)([^*_]+)\1/g, '$2')
      .replace(/(\*|_)([^*_]+)\1/g, '$2')
      .replace(/[*_`~]/g, '')
      .replace(/\\([\\`*_{}[\]()#+\-.!>])/g, '$1')
      .trimEnd())
    .join('\n');
  return plain.replace(/^\n+/, '').trimEnd();
}

function reasoningDisplayText(text) {
  return normalizeReasoningDisplayText(text);
}

function compactToolSearchOutputTool(tool) {
  if (!isObject(tool)) return null;
  const namespace = toolNamespace(tool);
  const name = toolBaseName(tool, '');
  if (!name) return null;
  const schema = normalizeJsonSchemaObject(tool.function?.parameters ?? tool.parameters ?? tool.input_schema);
  const properties = Object.keys(isObject(schema.properties) ? schema.properties : {});
  const required = Array.isArray(schema.required) ? schema.required.map(String) : [];
  const description = tool.function?.description ?? tool.description ?? '';
  return omitUndefined({
    name: encodeToolName(namespace, name),
    description: description ? shortenText(description, 220) : undefined,
    required: required.length ? required : undefined,
    properties: properties.length ? properties : undefined,
  });
}

function toolOutputContent(item) {
  if (item?.type === 'tool_search_output' && Array.isArray(item.tools)) {
    const tools = expandTools(item.tools)
      .map(compactToolSearchOutputTool)
      .filter(Boolean);
    return JSON.stringify(omitUndefined({
      status: item.status || 'completed',
      note: tools.length
        ? 'Discovered tools are loaded into the current tool list and can be called directly by these names.'
        : undefined,
      discovered_tools: tools,
    }));
  }
  const output = item.output ?? item.content ?? item.result ?? item.error ?? '';
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) return contentToChatContent(output);
  if (isObject(output) && (output.type || output.content)) return contentToChatContent(output.content ?? output);
  return JSON.stringify(output ?? '');
}

function responseToolOutputToMessage(item) {
  return {
    role: 'tool',
    content: toolOutputContent(item),
    tool_call_id: toolCallId(item),
  };
}

function normalizeMessage(message) {
  if (!isObject(message)) return null;
  const role = message.role || 'user';
  const content = contentToChatContent(message.content);
  const normalized = {
    role,
    content,
    tool_calls: Array.isArray(message.tool_calls) ? message.tool_calls : undefined,
    tool_call_id: message.tool_call_id,
    name: message.name,
  };
  if (typeof message.reasoning_content === 'string') normalized.reasoning_content = message.reasoning_content;
  return normalized;
}

function assistantMessageIsEmpty(message) {
  if (hasChatToolCalls(message)) return false;
  const content = message?.content;
  if (typeof content === 'string') return content.length === 0;
  if (Array.isArray(content)) return content.length === 0;
  return content == null;
}

function compactWebSearchValue(value, maxChars = 700) {
  if (typeof value === 'string') return shortenText(value, maxChars);
  if (value == null) return '';
  try {
    return shortenText(JSON.stringify(value), maxChars);
  } catch {
    return shortenText(String(value), maxChars);
  }
}

export function normalizeWebSearchCallHistory(item) {
  if (!isObject(item) || item.type !== 'web_search_call') return null;
  const action = isObject(item.action) ? item.action : {};
  const queries = [];
  for (const value of [action.query, ...(Array.isArray(action.queries) ? action.queries : [])]) {
    const query = compactWebSearchValue(value);
    if (query && !queries.includes(query)) queries.push(query);
    if (queries.length >= 8) break;
  }
  const sources = [];
  for (const value of Array.isArray(action.sources) ? action.sources : []) {
    if (!isObject(value)) continue;
    const source = omitUndefined({
      type: compactWebSearchValue(value.type, 80) || undefined,
      title: compactWebSearchValue(value.title, 400) || undefined,
      url: compactWebSearchValue(value.url, 1200) || undefined,
    });
    if (Object.keys(source).length) sources.push(source);
    if (sources.length >= 5) break;
  }
  return omitUndefined({
    id: compactWebSearchValue(item.id || item.call_id, 200) || undefined,
    status: compactWebSearchValue(item.status, 80) || undefined,
    action: compactWebSearchValue(action.type, 80) || 'search',
    queries,
    url: compactWebSearchValue(action.url, 1600) || undefined,
    pattern: compactWebSearchValue(action.pattern, 700) || undefined,
    sources,
    error: compactWebSearchValue(item.error ?? action.error, 1200) || undefined,
  });
}

function webSearchCallNote(item) {
  const history = normalizeWebSearchCallHistory(item);
  if (!history) return '';
  const evidence = webSearchEvidenceNote(history.id);
  const failed = String(history.status || '').toLowerCase() === 'failed' || Boolean(history.error);
  const sourceText = history.sources
    .map((source) => (source.title && source.url ? `${source.title} <${source.url}>` : source.url || source.title))
    .filter(Boolean)
    .join('; ');
  const details = [
    sourceText ? `sources: ${sourceText}` : '',
    history.error ? `error: ${history.error}` : '',
  ].filter(Boolean);
  let note;
  if (history.action === 'open_page') {
    const target = history.url || 'a web page';
    note = failed ? `Failed to open page ${target}.` : `Opened page ${target}.`;
  } else if (history.action === 'find_in_page') {
    const target = history.url || 'a web page';
    const pattern = history.pattern || history.queries[0];
    note = pattern ? `Searched within ${target} for "${pattern}".` : `Searched within ${target}.`;
  } else {
    const query = history.queries.length ? history.queries.map((value) => `"${value}"`).join('; ') : 'the web';
    note = `Searched the web for ${query}.`;
  }
  if (history.status && history.status !== 'completed') details.unshift(`status: ${history.status}`);
  if (details.length) note = `${note.slice(0, -1)} (${details.join('; ')}).`;
  return evidence ? `${note} ${evidence}` : note;
}

function extractMessagesFromResponsesInput(input) {
  if (Array.isArray(input)) {
    const messages = [];
    let pendingUserContent = [];
    let pendingReasoningContent = '';
    let pendingAssistantToolMessage = null;
    let pendingAssistantMessage = null;
    let pendingWebSearchNotes = [];
    const flushPendingUserContent = () => {
      if (!pendingUserContent.length) return;
      messages.push({ role: 'user', content: contentToChatContent(pendingUserContent) });
      pendingUserContent = [];
    };
    const flushPendingWebSearchNotes = () => {
      if (!pendingWebSearchNotes.length) return;
      messages.push({
        role: 'assistant',
        content: `[Earlier web activity] ${pendingWebSearchNotes.join(' ')}`,
      });
      pendingWebSearchNotes = [];
    };
    const flushPendingAssistantToolMessage = () => {
      if (!pendingAssistantToolMessage) return;
      messages.push(pendingAssistantToolMessage);
      pendingAssistantToolMessage = null;
      pendingReasoningContent = '';
    };
    const flushPendingAssistantMessage = () => {
      if (!pendingAssistantMessage) return;
      const message = pendingAssistantMessage;
      pendingAssistantMessage = null;
      if (assistantMessageIsEmpty(message)) {
        if (message.reasoning_content && !pendingReasoningContent) {
          pendingReasoningContent = message.reasoning_content;
        }
        return;
      }
      messages.push(message);
    };
    const flushAssistantState = () => {
      flushPendingAssistantToolMessage();
      flushPendingAssistantMessage();
    };
    const ensurePendingAssistantToolMessage = () => {
      if (!pendingAssistantToolMessage) {
        if (pendingAssistantMessage) {
          pendingAssistantToolMessage = pendingAssistantMessage;
          pendingAssistantMessage = null;
          if (!Array.isArray(pendingAssistantToolMessage.tool_calls)) {
            pendingAssistantToolMessage.tool_calls = [];
          }
        } else {
          pendingAssistantToolMessage = {
            role: 'assistant',
            content: '',
            tool_calls: [],
          };
        }
        if (!pendingAssistantToolMessage.reasoning_content && pendingReasoningContent) {
          pendingAssistantToolMessage.reasoning_content = pendingReasoningContent;
        }
      }
      return pendingAssistantToolMessage;
    };
    const pushRoleMessage = (item) => {
      flushPendingUserContent();
      flushPendingAssistantToolMessage();
      flushPendingWebSearchNotes();
      flushPendingAssistantMessage();
      const normalized = normalizeMessage(item);
      if (!normalized) return;
      if (normalized.role === 'assistant' && !normalized.reasoning_content && pendingReasoningContent) {
        normalized.reasoning_content = pendingReasoningContent;
        pendingReasoningContent = '';
      }
      if (normalized.role === 'assistant' && !hasChatToolCalls(normalized)) {
        pendingAssistantMessage = normalized;
        return;
      }
      messages.push(normalized);
    };

    for (const item of input) {
      if (typeof item === 'string') {
        flushAssistantState();
        flushPendingWebSearchNotes();
        pendingUserContent.push({ type: 'input_text', text: item });
        continue;
      }
      if (!isObject(item)) continue;
      if (isInputContentPart(item)) {
        flushAssistantState();
        flushPendingWebSearchNotes();
        pendingUserContent.push(item);
        continue;
      }
      if (item.type === 'reasoning') {
        pendingReasoningContent += reasoningTextFromItem(item);
        continue;
      }
      if (item.type === 'message' && item.role) {
        pushRoleMessage(item);
        continue;
      }
      if (item.type === 'web_search_call') {
        flushPendingUserContent();
        flushAssistantState();
        pendingWebSearchNotes.push(webSearchCallNote(item));
        continue;
      }
      if (CHAT_HISTORY_IGNORED_TOOL_ITEM_TYPES.has(item.type)) {
        flushPendingUserContent();
        flushAssistantState();
        continue;
      }
      if (TOOL_OUTPUT_TYPES.has(item.type) || String(item.type || '').endsWith('_call_output')) {
        flushPendingUserContent();
        flushPendingWebSearchNotes();
        flushAssistantState();
        messages.push(responseToolOutputToMessage(item));
        continue;
      }
      if (TOOL_CALL_TYPES.has(item.type) || String(item.type || '').endsWith('_call')) {
        flushPendingUserContent();
        flushPendingWebSearchNotes();
        ensurePendingAssistantToolMessage().tool_calls.push(chatToolCallFromResponseItem(item));
        continue;
      }
      if (item.role) {
        pushRoleMessage(item);
      }
    }
    flushPendingUserContent();
    flushAssistantState();
    flushPendingWebSearchNotes();
    return messages;
  }

  if (isObject(input)) {
    if (Array.isArray(input.messages)) {
      return input.messages.map(normalizeMessage).filter(Boolean);
    }
    if (Array.isArray(input.input)) {
      return extractMessagesFromResponsesInput(input.input);
    }
    if (typeof input.input === 'string') {
      return [{ role: 'user', content: input.input }];
    }
    if (isInputContentPart(input.input)) {
      return [{ role: 'user', content: contentToChatContent(input.input) }];
    }
  }

  if (typeof input === 'string') {
    return [{ role: 'user', content: input }];
  }

  return [];
}

const CUSTOM_TOOL_TRANSPORT_DESCRIPTION = 'Codex custom tool callable as a function. Put its complete raw input in the required "input" string.';
const CUSTOM_TOOL_INPUT_HINT = 'Complete raw input for the Codex custom tool. Preserve it exactly and add no transport wrapper or markdown fence unless the declared format requires one.';
function truncateRawText(value, maxChars) {
  const text = String(value ?? '');
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 4))}\n...`;
}

function customToolShimParameters(description) {
  return {
    type: 'object',
    properties: {
      input: {
        type: 'string',
        description,
      },
    },
    required: ['input'],
    additionalProperties: false,
  };
}

function customToolShim(tool) {
  const format = isObject(tool.format) ? tool.format : {};
  const baseName = toolBaseName(tool, 'custom_tool');
  const formatType = typeof format.type === 'string' && format.type.trim() ? format.type.trim() : '';
  const syntax = typeof format.syntax === 'string' && format.syntax.trim() ? format.syntax.trim() : '';
  const definition = typeof format.definition === 'string' && format.definition.trim()
    ? format.definition.trim()
    : '';
  const sourceDescription = compactStructuredText(tool.description, DEEPSEEK_TOOL_DESCRIPTION_SOFT_CHARS)
    || `Freeform tool ${baseName}.`;
  if (isApplyPatchGrammarTool(tool)) {
    return applyPatchCustomToolShim(tool, encodeToolName(toolNamespace(tool), baseName));
  }
  const chunks = [
    CUSTOM_TOOL_TRANSPORT_DESCRIPTION,
    `Tool description: ${sourceDescription}`,
  ];
  const inputContract = [
    CUSTOM_TOOL_INPUT_HINT,
  ];
  const sourceSchema = isObject(tool.input_schema) ? tool.input_schema : isObject(tool.parameters) ? tool.parameters : null;
  const sourceInputDescription = sourceSchema?.properties?.input?.description;
  if (typeof sourceInputDescription === 'string' && sourceInputDescription) {
    inputContract.push(compactStructuredText(sourceInputDescription, DEEPSEEK_SCHEMA_DESCRIPTION_SOFT_CHARS));
  }
  if (formatType) inputContract.push(`Input format: ${formatType}.`);
  if (syntax) inputContract.push(`Input syntax: ${syntax}.`);
  if (formatType || syntax || definition) inputContract.push(CUSTOM_TOOL_FORMAT_CONTRACT);
  if (definition) inputContract.push(`${formatType === 'grammar' ? 'Input grammar' : 'Input format definition'}:\n${definition}`);
  const parameters = customToolShimParameters(inputContract.join('\n'));
  return {
    type: 'function',
    gateway_custom_tool: true,
    gateway_custom_tool_input: 'raw',
    function: {
      name: encodeToolName(toolNamespace(tool), baseName),
      description: chunks.join('\n'),
      parameters,
    },
  };
}

function buildCustomToolNames(tools) {
  const names = new Set();
  for (const tool of expandTools(tools)) {
    if (!isObject(tool) || tool.type !== 'custom') continue;
    const normalizedTool = normalizeTool(tool);
    const fn = normalizedTool?.type === 'function' ? normalizedTool.function : null;
    if (fn?.name) names.add(fn.name);
  }
  return names;
}

function buildCustomToolInputModes(tools) {
  const modes = new Map();
  for (const tool of expandTools(tools)) {
    if (!isObject(tool) || tool.type !== 'custom') continue;
    const normalizedTool = normalizeTool(tool);
    const fn = normalizedTool?.type === 'function' ? normalizedTool.function : null;
    if (fn?.name) modes.set(fn.name, normalizedTool.gateway_custom_tool_input || 'raw');
  }
  return modes;
}

function customToolInputFromArguments(argumentsText, inputMode = 'raw') {
  if (typeof argumentsText !== 'string' || !argumentsText) return '';
  if (isApplyPatchInputMode(inputMode)) {
    const lowering = applyPatchLoweringFromArguments(argumentsText, inputMode);
    return lowering.ok ? lowering.input : '';
  }
  const parsed = safeJsonParse(argumentsText);
  if (parsed.ok && typeof parsed.value === 'string') return parsed.value;
  if (parsed.ok && isObject(parsed.value)) {
    const input = parsed.value.input;
    if (typeof input === 'string') return input;
    if (input !== undefined) return jsonString(input);
    return argumentsText;
  }
  return argumentsText;
}

function stripGatewayToolMarkers(tools) {
  if (!Array.isArray(tools)) return tools;
  return tools.map((tool) => {
    if (!isObject(tool) || tool.gateway_custom_tool === undefined) return tool;
    const { gateway_custom_tool, gateway_custom_tool_input, ...rest } = tool;
    return rest;
  });
}

const UNAVAILABLE_TOOL_GUIDANCE = 'Do not call this tool; if the task depends on it, tell the user it is unavailable.';

function unavailableHostedToolShim(tool, reason) {
  const capability = String(tool.type || 'tool');
  const detail = reason || `Unavailable capability: the requested hosted ${capability} tool is not configured here.`;
  return {
    type: 'function',
    function: {
      name: encodeToolName(toolNamespace(tool), toolBaseName(tool, capability)),
      description: `${detail} ${UNAVAILABLE_TOOL_GUIDANCE}`,
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  };
}

export function unavailableWebSearchToolShims(tools) {
  const shims = [];
  const seen = new Set();
  for (const tool of expandTools(tools)) {
    if (!isObject(tool) || typeof tool.type !== 'string' || !EMULATED_HOSTED_TOOL_TYPES.has(tool.type)) continue;
    const shim = unavailableHostedToolShim(
      tool,
      'Unavailable capability: web search was requested, but no search provider is configured.',
    );
    if (seen.has(shim.function.name)) continue;
    seen.add(shim.function.name);
    shims.push(shim);
  }
  return shims;
}

function normalizeTool(tool) {
  if (!isObject(tool)) return tool;
  if (tool.type === 'namespace') return null;
  if (typeof tool.type === 'string' && EMULATED_HOSTED_TOOL_TYPES.has(tool.type)) {
    return null;
  }
  if (typeof tool.type === 'string' && UNSUPPORTED_HOSTED_TOOL_TYPES.has(tool.type)) {
    return unavailableHostedToolShim(tool);
  }
  if (tool.type === 'custom') {
    return customToolShim(tool);
  }
  if (typeof tool.type === 'string' && BRIDGED_RESPONSES_TOOL_TYPES.has(tool.type)) {
    return {
      type: 'function',
      function: omitUndefined({
        name: encodeToolName(toolNamespace(tool), tool.type),
        description: tool.description,
        parameters: normalizeJsonSchemaObject(tool.parameters || tool.input_schema),
        strict: tool.strict,
      }),
    };
  }
  if (tool.type === 'function' && isObject(tool.function)) {
    const { namespace, defer_loading, ...fn } = tool.function;
    return {
      type: 'function',
      function: omitUndefined({
        ...fn,
        name: encodeToolName(toolNamespace(tool), fn.name),
        description: fn.description ?? tool.description,
        parameters: normalizeJsonSchemaObject(fn.parameters ?? tool.parameters ?? tool.input_schema),
        strict: fn.strict ?? tool.strict,
      }),
    };
  }
  if (tool.type === 'function') {
    return {
      type: 'function',
      function: omitUndefined({
        name: encodeToolName(toolNamespace(tool), toolBaseName(tool, tool.type)),
        description: tool.description,
        parameters: normalizeJsonSchemaObject(tool.parameters || tool.input_schema),
        strict: tool.strict,
      }),
    };
  }
  if (!tool.type && (tool.name || tool.parameters || tool.input_schema)) {
    return {
      type: 'function',
      function: omitUndefined({
        name: encodeToolName(toolNamespace(tool), toolBaseName(tool, 'tool_call')),
        description: tool.description,
        parameters: normalizeJsonSchemaObject(tool.parameters || tool.input_schema),
        strict: tool.strict,
      }),
    };
  }
  return null;
}

function expandNamespaceTool(tool) {
  if (!isObject(tool) || tool.type !== 'namespace') return [tool];
  const namespace = tool.name || tool.namespace || tool.server_label;
  const children = Array.isArray(tool.tools) ? tool.tools : [];
  return children
    .filter(isObject)
    .map((child) => {
      if (child.type === 'function' && isObject(child.function)) {
        return {
          ...child,
          namespace: child.namespace || namespace,
          function: {
            ...child.function,
            namespace: child.function.namespace || child.namespace || namespace,
          },
        };
      }
      return {
        ...child,
        namespace: child.namespace || namespace,
      };
    });
}

function expandTools(tools) {
  if (!Array.isArray(tools)) return [];
  return tools.flatMap(expandNamespaceTool);
}

function normalizeTools(tools) {
  const seen = new Set();
  const normalized = [];
  for (const tool of expandTools(tools).map(normalizeTool).filter(Boolean)) {
    const name = tool?.type === 'function' ? tool.function?.name : '';
    if (name) {
      if (seen.has(name)) continue;
      seen.add(name);
    }
    normalized.push(tool);
  }
  return normalized.length ? normalized : undefined;
}

function hasRunnableChatTools(normalized) {
  return Array.isArray(applyAllowedTools(normalizeTools(normalized?.tools), normalized?.tool_choice));
}

function toolSearchDiscoveryKey(tool) {
  if (tool.type === 'namespace') {
    return `namespace:${tool.name || tool.namespace || tool.server_label || ''}`;
  }
  return `${tool.type || 'function'}:${toolNamespace(tool)}:${toolBaseName(tool, '')}`;
}

function collectToolSearchOutputTools(input) {
  const discovered = new Map();
  const scan = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) scan(item);
      return;
    }
    if (!isObject(value)) return;
    if (value.type === 'tool_search_output' && Array.isArray(value.tools)) {
      for (const tool of value.tools) {
        if (isObject(tool)) discovered.set(toolSearchDiscoveryKey(tool), tool);
      }
      return;
    }
    if (Array.isArray(value.input)) scan(value.input);
    if (Array.isArray(value.content)) scan(value.content);
  };
  scan(input);
  return [...discovered.values()];
}

function mergeToolsWithToolSearchOutput(requestTools, input) {
  const discovered = collectToolSearchOutputTools(input);
  if (!discovered.length) return requestTools;
  const base = Array.isArray(requestTools) ? requestTools : [];
  return base.concat(discovered);
}

function normalizeJsonSchemaObject(schema) {
  if (!isObject(schema)) {
    return { type: 'object', properties: {}, additionalProperties: true };
  }
  if (schema.type === 'object') {
    return {
      ...schema,
      properties: isObject(schema.properties) ? schema.properties : {},
    };
  }
  if (schema.type == null) {
    return {
      ...schema,
      type: 'object',
      properties: isObject(schema.properties) ? schema.properties : {},
    };
  }
  return {
    type: 'object',
    properties: {
      value: schema,
    },
    required: ['value'],
    additionalProperties: false,
  };
}

function normalizeToolChoice(toolChoice) {
  if (toolChoiceDisablesTools(toolChoice)) return 'none';
  if (!isObject(toolChoice)) return toolChoice;
  if (toolChoice.type === 'function' && toolChoice.name) {
    return {
      type: 'function',
      function: { name: encodeToolName(toolNamespace(toolChoice), toolChoice.name) },
    };
  }
  if (toolChoice.type === 'function' && isObject(toolChoice.function)) {
    return {
      ...toolChoice,
      function: {
        ...toolChoice.function,
        name: encodeToolName(toolNamespace(toolChoice), toolChoice.function.name),
      },
    };
  }
  if (toolChoice.type === 'allowed_tools') {
    return toolChoice.mode === 'required' ? 'required' : 'auto';
  }
  if (typeof toolChoice.type === 'string') {
    return {
      type: 'function',
      function: {
        name: encodeToolName(
          toolNamespace(toolChoice),
          toolChoice.name ||
            toolChoice.tool_name ||
            toolChoice.toolName ||
            toolChoice.server_label ||
            toolChoice.type,
        ),
      },
    };
  }
  return toolChoice;
}

function toolChoiceEntryName(entry) {
  if (!isObject(entry)) return '';
  if (entry.type === 'function' && entry.name) return encodeToolName(toolNamespace(entry), entry.name);
  if (entry.type === 'function' && isObject(entry.function)) {
    return encodeToolName(toolNamespace(entry), entry.function.name);
  }
  return encodeToolName(
    toolNamespace(entry),
    entry.name ||
      entry.tool_name ||
      entry.toolName ||
      entry.server_label ||
      entry.type,
  );
}

function allowedToolNames(toolChoice) {
  if (!isObject(toolChoice) || toolChoice.type !== 'allowed_tools') return null;
  const entries = Array.isArray(toolChoice.tools)
    ? toolChoice.tools
    : Array.isArray(toolChoice.allowed_tools)
    ? toolChoice.allowed_tools
    : Array.isArray(toolChoice.names)
    ? toolChoice.names.map((name) => ({ type: 'function', name }))
    : [];
  const names = entries.map(toolChoiceEntryName).filter(Boolean);
  return names.length ? new Set(names) : null;
}

function applyAllowedTools(tools, toolChoice) {
  if (toolChoiceDisablesTools(toolChoice)) return undefined;
  const allowed = allowedToolNames(toolChoice);
  if (!allowed || !Array.isArray(tools)) return tools;
  const filtered = tools.filter((tool) => {
    const name = tool?.type === 'function' ? tool.function?.name : '';
    return !name || allowed.has(name);
  });
  return filtered.length ? filtered : undefined;
}

function unwrapJsonString(value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  const first = trimmed[0];
  if (!['{', '[', '"', 't', 'f', 'n', '-', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9'].includes(first)) {
    return value;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function schemaTypes(schema) {
  if (!isObject(schema)) return [];
  return Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
}

function coerceValueForSchema(value, schema) {
  const types = schemaTypes(schema);
  if (!types.length || typeof value !== 'string') return value;
  const unwrapped = unwrapJsonString(value);
  if (types.includes('array') && Array.isArray(unwrapped)) return unwrapped;
  if (types.includes('object') && isObject(unwrapped)) return unwrapped;
  if (types.includes('boolean') && typeof unwrapped === 'boolean') return unwrapped;
  if (types.includes('number') && typeof unwrapped === 'number') return unwrapped;
  if (types.includes('integer') && Number.isInteger(unwrapped)) return unwrapped;
  return value;
}

function toolSearchArgumentsFromText(argumentsText) {
  const parsed = parseJsonObject(argumentsText);
  const args = {};
  if (parsed.limit !== undefined) {
    const limit = Number(parsed.limit);
    if (Number.isFinite(limit)) args.limit = limit;
  }
  if (parsed.query !== undefined) args.query = String(parsed.query);
  return args;
}

function finalizeToolSearchCallItemArguments(item) {
  if (!item || item.type !== 'tool_search_call') return;
  if (typeof item.arguments === 'string') {
    item.arguments = toolSearchArgumentsFromText(item.arguments);
  } else if (!isObject(item.arguments)) {
    item.arguments = {};
  }
}

function convertItemToToolSearchCall(item) {
  if (!item || item.type === 'tool_search_call') return item;
  item.type = 'tool_search_call';
  item.id = generateId('tsc');
  item.execution = 'client';
  delete item.name;
  delete item.namespace;
  return item;
}

function responseItemFromChatToolCall(toolCall, toolNames, customToolNames, customToolInputModes) {
  const callId = toolCall.id || generateId('call');
  if (isCodexToolSearchTool(toolCall.function?.name)) {
    return {
      type: 'tool_search_call',
      id: generateId('tsc'),
      call_id: callId,
      status: 'completed',
      execution: 'client',
      arguments: toolSearchArgumentsFromText(toolCall.function?.arguments || ''),
    };
  }
  const decoded = decodedToolName(toolCall.function?.name, toolNames);
  if (customToolNames?.has(toolCall.function?.name)) {
    const inputMode = customToolInputModes?.get(toolCall.function?.name);
    const rawArguments = toolCall.function?.arguments || '';
    const nativeInput = customToolInputFromArguments(rawArguments, inputMode);
    const item = omitUndefined({
      type: 'custom_tool_call',
      id: callId,
      call_id: callId,
      name: decoded.name,
      input: nativeInput,
      status: 'completed',
    });
    const replayArguments = isApplyPatchInputMode(inputMode)
      ? applyPatchReplayArguments(rawArguments, inputMode, nativeInput)
      : rawArguments;
    if (replayArguments) {
      Object.defineProperty(item, 'arguments', {
        value: replayArguments,
        enumerable: false,
        configurable: true,
        writable: true,
      });
    }
    return item;
  }
  return omitUndefined({
    type: 'function_call',
    id: callId,
    call_id: callId,
    name: decoded.name,
    namespace: decoded.namespace,
    arguments: toolCall.function?.arguments || '',
    status: 'completed',
  });
}

function buildToolSchemas(tools) {
  const schemas = new Map();
  for (const tool of expandTools(tools)) {
    const normalizedTool = normalizeTool(tool);
    const fn = normalizedTool?.type === 'function' ? normalizedTool.function : null;
    if (!fn?.name) continue;
    schemas.set(fn.name, normalizeJsonSchemaObject(fn.parameters));
  }
  return schemas;
}

function buildToolNames(tools) {
  const names = new Map();
  for (const tool of expandTools(tools)) {
    const namespace = toolNamespace(tool);
    const normalizedTool = normalizeTool(tool);
    const fn = normalizedTool?.type === 'function' ? normalizedTool.function : null;
    if (!fn?.name) continue;
    const baseName = String(toolBaseName(tool, tool.type));
    const sanitizedBaseName = sanitizeFunctionName(baseName);
    if (!namespace && fn.name === baseName) continue;
    names.set(fn.name, omitUndefined({
      namespace: namespace || undefined,
      name: sanitizedBaseName,
      original_name: baseName,
    }));
  }
  return names;
}

function customToolInputModeForItem(item, customToolInputModes) {
  if (!item || item.type !== 'custom_tool_call') return 'raw';
  return customToolInputModes?.get(encodeToolName(item.namespace, item.name)) || 'raw';
}

function simplifyJsonSchemaDescriptions(schema) {
  if (Array.isArray(schema)) return schema.map(simplifyJsonSchemaDescriptions);
  if (!isObject(schema)) return schema;
  const next = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'description' && typeof value === 'string') {
      const description = compactStructuredText(value, DEEPSEEK_SCHEMA_DESCRIPTION_SOFT_CHARS);
      if (description) next.description = description;
      continue;
    }
    next[key] = isObject(value) || Array.isArray(value) ? simplifyJsonSchemaDescriptions(value) : value;
  }
  return next;
}

function readableToolName(name) {
  return compactText(String(name || '').replace(/[_-]+/g, ' '));
}

function requiredParametersText(parameters) {
  const required = Array.isArray(parameters?.required) ? parameters.required.filter((name) => typeof name === 'string') : [];
  return required.length ? ` Required: ${required.join(', ')}.` : '';
}

function defaultDeepSeekToolDescription(name) {
  const readable = readableToolName(name);
  return compactText(`Call ${readable || name || 'this function'} when needed.`);
}

function simplifyToolForDeepSeek(tool) {
  if (tool?.type !== 'function' || !isObject(tool.function)) return tool;
  if (tool.gateway_custom_tool) return tool;
  const fn = tool.function;
  const parameters = simplifyJsonSchemaDescriptions(fn.parameters);
  const requiredText = requiredParametersText(parameters);
  const baseDescription = compactStructuredText(fn.description, DEEPSEEK_TOOL_DESCRIPTION_SOFT_CHARS)
    || defaultDeepSeekToolDescription(fn.name);
  const description = `${baseDescription}${requiredText}`;
  return {
    ...tool,
    function: omitUndefined({
      ...fn,
      description,
      parameters,
    }),
  };
}

function addDeepSeekSystemInstructions(messages, marker, instructions) {
  if (messages.some((message) => message?.role === 'system' && toText(message.content).includes(marker))) return messages;
  if (!messages.length || messages[0]?.role !== 'system') {
    return [{ role: 'system', content: instructions }, ...messages];
  }
  return [
    {
      ...messages[0],
      content: `${toText(messages[0].content)}\n\n${instructions}`,
    },
    ...messages.slice(1),
  ];
}

function addDeepSeekToolInstructions(messages, tools) {
  if (!Array.isArray(tools) || !tools.length) return messages;
  const custom = tools.some((tool) => tool?.gateway_custom_tool);
  const base = requestToolsIncludeCommentary(tools)
    ? `${DEEPSEEK_TOOL_INSTRUCTIONS} ${DEEPSEEK_COMMENTARY_INSTRUCTIONS}`
    : DEEPSEEK_TOOL_INSTRUCTIONS;
  const instructions = custom ? `${base} ${DEEPSEEK_CUSTOM_TOOL_INSTRUCTIONS}` : base;
  return addDeepSeekSystemInstructions(messages, DEEPSEEK_TOOL_INSTRUCTIONS_MARKER, instructions);
}

function addDeepSeekCompactionInstructions(messages) {
  return messages.some((message) => (
    message?.role === 'user'
    && toText(message.content).trim().startsWith(CODEX_SUMMARY_PREFIX_START)
    && toText(message.content).includes('# Context Checkpoint')
  ))
    ? addDeepSeekSystemInstructions(messages, DEEPSEEK_COMPACTION_INSTRUCTIONS_MARKER, DEEPSEEK_COMPACTION_INSTRUCTIONS)
    : messages;
}

function isDeepSeekBetaBaseUrl(baseUrl) {
  return /\/beta\/?$/.test(String(baseUrl || ''));
}

function adaptToolsForProvider(tools, provider, config = {}) {
  if (provider !== 'deepseek' || !Array.isArray(tools)) return tools;
  const keepStrict = isDeepSeekBetaBaseUrl(config.upstreamBaseUrl);
  return tools.map((tool) => {
    const simplified = simplifyToolForDeepSeek(tool);
    if (!keepStrict && simplified?.type === 'function' && isObject(simplified.function) && simplified.function.strict !== undefined) {
      const { strict, ...fn } = simplified.function;
      return { ...simplified, function: fn };
    }
    return simplified;
  });
}

function assertDeepSeekToolCapacity(tools) {
  const count = Array.isArray(tools)
    ? tools.filter((tool) => tool?.type === 'function' && isObject(tool.function)).length
    : 0;
  if (count <= DEEPSEEK_MAX_FUNCTION_TOOLS) return;
  const error = new RangeError(`DeepSeek supports at most ${DEEPSEEK_MAX_FUNCTION_TOOLS} function tools; received ${count} after gateway adaptation.`);
  error.statusCode = 400;
  error.code = 'too_many_tools';
  throw error;
}

function normalizeToolCallArguments(name, argumentsText, toolSchema) {
  if (!argumentsText) return '';
  if (!isObject(toolSchema) || !isObject(toolSchema.properties)) return argumentsText;
  try {
    const parsed = JSON.parse(argumentsText);
    if (!isObject(parsed)) return argumentsText;
    let changed = false;
    const next = { ...parsed };
    for (const [key, schema] of Object.entries(toolSchema.properties)) {
      if (!(key in next)) continue;
      const value = coerceValueForSchema(next[key], schema);
      if (value !== next[key]) {
        next[key] = value;
        changed = true;
      }
    }
    return changed ? JSON.stringify(next) : argumentsText;
  } catch {
    return argumentsText;
  }
}

function normalizeFunctionCallItemArguments(item, toolSchemas) {
  if (!item || item.type !== 'function_call') return;
  const encodedName = encodeToolName(item.namespace, item.name);
  item.arguments = normalizeToolCallArguments(encodedName, item.arguments, toolSchemas?.get(encodedName));
}

function functionCallItemNeedsArgumentNormalization(item, toolSchemas) {
  if (!item || item.type !== 'function_call') return false;
  const encodedName = encodeToolName(item.namespace, item.name);
  return Boolean(toolSchemas?.has(encodedName));
}

function hasToolCallFunctionName(toolCall) {
  return typeof toolCall?.function?.name === 'string' && toolCall.function.name.length > 0;
}

function sanitizeToolCallsForChatCompletion(toolCalls) {
  return toolCalls.map((toolCall) => {
    if (!isObject(toolCall)) return toolCall;
    const fn = isObject(toolCall.function) ? toolCall.function : {};
    const { namespace, ...functionFields } = fn;
    const name = fn.name || toolCall.name || 'tool_call';
    const toolCallNamespace = toolCall.namespace || namespace || '';
    return {
      id: toolCall.id,
      type: toolCall.type || 'function',
      function: {
        ...functionFields,
        name: encodeToolName(toolCallNamespace, name),
      },
    };
  });
}

function multimodalPlaceholder(kind, hint) {
  const cleanHint = compactText(hint);
  const shortHint = cleanHint && !cleanHint.startsWith('data:') ? shortenText(cleanHint, 120) : '';
  return `[${kind} omitted: DeepSeek accepts text input only${shortHint ? `; source: ${shortHint}` : ''}]`;
}

function deepseekTextOnlyContent(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  const parts = Array.isArray(content) ? content : [content];
  const chunks = [];
  for (const part of parts) {
    if (typeof part === 'string') {
      chunks.push(part);
      continue;
    }
    if (!isObject(part)) continue;
    if (part.type === 'text') {
      chunks.push(String(part.text ?? ''));
      continue;
    }
    if (part.type === 'image_url') {
      chunks.push(multimodalPlaceholder('image', part.image_url?.url || part.image_url?.file_id));
      continue;
    }
    if (part.type === 'file') {
      chunks.push(multimodalPlaceholder('file', part.file?.filename || part.file?.file_url || part.file?.file_id));
      continue;
    }
    if (part.type === 'input_audio') {
      chunks.push(multimodalPlaceholder('audio', part.input_audio?.file_id));
      continue;
    }
    const text = toText(part);
    if (text) chunks.push(text);
  }
  return chunks.filter((chunk) => chunk !== '').join('\n');
}

function sanitizeMessageForChatCompletion(message, provider = 'generic') {
  if (!isObject(message)) return message;
  const chatContent = contentToChatContent(message.content);
  const sanitized = {
    role: normalizeRole(message.role, provider),
    content: provider === 'deepseek' ? deepseekTextOnlyContent(chatContent) : chatContent,
  };
  if (message.name !== undefined) sanitized.name = message.name;
  if (Array.isArray(message.tool_calls)) {
    sanitized.tool_calls = sanitizeToolCallsForChatCompletion(message.tool_calls);
  }
  if (message.tool_call_id !== undefined) sanitized.tool_call_id = message.tool_call_id;
  if (provider === 'deepseek' && message.role === 'assistant' && typeof message.reasoning_content === 'string') {
    sanitized.reasoning_content = message.reasoning_content;
  }
  return sanitized;
}

function deepSeekInstructionBlock(message, includePriorityLabels) {
  const content = toText(message?.content).trim();
  if (!content) return '';
  if (!includePriorityLabels) return content;
  const label = message.role === 'developer'
    ? 'Developer instructions (priority below system):'
    : 'System instructions (highest priority):';
  return `${label}\n${content}`;
}

function sanitizeMessagesForChatCompletion(messages, provider = 'generic') {
  const source = Array.isArray(messages) ? messages : [];
  if (provider !== 'deepseek') {
    return source.map((message) => sanitizeMessageForChatCompletion(message, provider));
  }

  const result = [];
  let instructionBlock = [];
  const flushInstructionBlock = () => {
    if (!instructionBlock.length) return;
    const hasDeveloper = instructionBlock.some((message) => message?.role === 'developer');
    const content = instructionBlock
      .map((message) => deepSeekInstructionBlock(message, hasDeveloper))
      .filter(Boolean)
      .join('\n\n');
    if (content) result.push({ role: 'system', content });
    instructionBlock = [];
  };

  for (const message of source) {
    if (message?.role === 'system' || message?.role === 'developer') {
      instructionBlock.push(message);
      continue;
    }
    flushInstructionBlock();
    result.push(sanitizeMessageForChatCompletion(message, provider));
  }
  flushInstructionBlock();
  return result;
}

const DEEPSEEK_DEFAULT_MAX_TOKENS = 100000;

function deepseekDefaultMaxTokens(config = {}) {
  const value = Number(config.upstreamMaxTokens);
  if (Number.isFinite(value) && value > 0) return Math.floor(value);
  return DEEPSEEK_DEFAULT_MAX_TOKENS;
}

const DEEPSEEK_JSON_SCHEMA_INSTRUCTIONS_MARKER = 'Return only one valid JSON object';

function jsonSchemaFromResponseFormat(responseFormat) {
  if (!isObject(responseFormat)) return null;
  const container = isObject(responseFormat.json_schema) ? responseFormat.json_schema : responseFormat;
  return isObject(container.schema) ? container.schema : null;
}

function addDeepSeekJsonSchemaInstructions(messages, responseFormat) {
  if (messages.some((message) => message?.role === 'system' && toText(message.content).includes(DEEPSEEK_JSON_SCHEMA_INSTRUCTIONS_MARKER))) {
    return messages;
  }
  const schema = jsonSchemaFromResponseFormat(responseFormat);
  const schemaText = schema ? truncateRawText(JSON.stringify(schema), 6000) : '';
  const instructions = [
    `${DEEPSEEK_JSON_SCHEMA_INSTRUCTIONS_MARKER}, with no prose or Markdown.`,
    schemaText
      ? `It must match this JSON Schema:\n${schemaText}`
      : 'Use the object shape requested in the conversation.',
  ].join('\n');
  if (!messages.length || messages[0]?.role !== 'system') {
    return [{ role: 'system', content: instructions }, ...messages];
  }
  return [
    {
      ...messages[0],
      content: `${toText(messages[0].content)}\n\n${instructions}`,
    },
    ...messages.slice(1),
  ];
}

function patchDeepSeekThinkingHistory(messages, request) {
  if (request.thinking?.type !== 'enabled' && !request.reasoning_effort) return messages;
  return messages.map((message) => {
    if (message?.role !== 'assistant') return message;
    if (typeof message.reasoning_content === 'string') return message;
    if (!hasChatToolCalls(message)) return message;
    return {
      ...message,
      reasoning_content: '',
    };
  });
}

function normalizeOutputTextPart(text, annotations = []) {
  return {
    type: 'output_text',
    text: String(text ?? ''),
    annotations: Array.isArray(annotations) ? annotations : [],
  };
}

const REASONING_SUMMARY_HEADER = '**Reasoning**\n\n';

function reasoningSummaryText(text) {
  const display = reasoningDisplayText(text);
  if (!display) return '';
  return `${REASONING_SUMMARY_HEADER}${display}`;
}

function normalizeSummaryTextPart(text) {
  return {
    type: 'summary_text',
    text: String(text ?? ''),
  };
}

function normalizeReasoningTextPart(text) {
  return {
    type: 'reasoning_text',
    text: String(text ?? ''),
  };
}

const BUFFERED_REASONING_DELTA_CHARS = 1200;

function splitTextChunks(text, maxChars) {
  const value = String(text ?? '');
  if (!value) return [];
  const chunks = [];
  for (let index = 0; index < value.length; index += maxChars) {
    chunks.push(value.slice(index, index + maxChars));
  }
  return chunks;
}

function splitBufferedReasoningDeltas(text) {
  return splitTextChunks(text, BUFFERED_REASONING_DELTA_CHARS);
}

function snapshotResponsePart(part) {
  if (!isObject(part)) return part;
  return {
    ...part,
    annotations: Array.isArray(part.annotations) ? [...part.annotations] : part.annotations,
  };
}

function snapshotResponseItem(item) {
  if (!isObject(item)) return item;
  if (item.type === 'tool_search_call') {
    return omitUndefined({
      type: item.type,
      id: item.id,
      call_id: item.call_id,
      status: item.status,
      execution: item.execution,
      arguments: isObject(item.arguments) ? { ...item.arguments } : toolSearchArgumentsFromText(item.arguments),
    });
  }
  if (item.type === 'custom_tool_call') {
    return omitUndefined({
      type: item.type,
      id: item.id,
      call_id: item.call_id,
      status: item.status,
      name: item.name,
      input: typeof item.input === 'string' ? item.input : '',
    });
  }
  return {
    ...item,
    content: Array.isArray(item.content) ? item.content.map(snapshotResponsePart) : item.content,
    summary: Array.isArray(item.summary) ? item.summary.map(snapshotResponsePart) : item.summary,
  };
}

function chatContentToResponseOutputParts(content) {
  if (content == null || content === '') return [];
  if (typeof content === 'string') return [normalizeOutputTextPart(content)];
  if (!Array.isArray(content)) {
    const text = toText(content);
    return text ? [normalizeOutputTextPart(text)] : [];
  }

  const output = [];
  for (const part of content) {
    if (typeof part === 'string') {
      output.push(normalizeOutputTextPart(part));
      continue;
    }
    if (!isObject(part)) continue;
    if (part.type === 'text' || part.type === 'output_text') {
      output.push(normalizeOutputTextPart(part.text ?? part.content ?? '', part.annotations));
      continue;
    }
    if (part.type === 'image_url' || part.type === 'output_image') {
      output.push(omitUndefined({
        type: 'output_image',
        image_url: part.image_url,
        url: part.url,
        file_id: part.file_id,
      }));
      continue;
    }
    if (part.type === 'file' || part.type === 'output_file') {
      output.push(omitUndefined({
        type: 'output_file',
        file: part.file,
        file_id: part.file_id,
        filename: part.filename,
      }));
      continue;
    }
    if (part.type === 'refusal') {
      output.push({ type: 'refusal', refusal: String(part.refusal ?? part.text ?? '') });
    }
  }
  return output;
}

function normalizeInstructions(instructions) {
  if (instructions == null) return '';
  if (typeof instructions === 'string') return instructions;
  if (Array.isArray(instructions)) {
    return instructions.map((item) => toText(item)).filter(Boolean).join('\n');
  }
  return toText(instructions);
}

export function normalizeResponsesRequest(request) {
  const messages = extractMessagesFromResponsesInput(request.input ?? request);
  const model = request.model || request.model_id || request.upstream_model || '';
  const instructions = normalizeInstructions(request.instructions);
  const responseFormat = request.response_format || request.text?.format;
  const tools = mergeToolsWithToolSearchOutput(request.tools, request.input ?? request);
  return {
    model,
    messages,
    instructions,
    temperature: request.temperature,
    top_p: request.top_p,
    max_tokens: request.max_output_tokens ?? request.max_tokens,
    stop: request.stop,
    stream: Boolean(request.stream),
    tools,
    tool_choice: request.tool_choice,
    parallel_tool_calls: request.parallel_tool_calls,
    presence_penalty: request.presence_penalty,
    frequency_penalty: request.frequency_penalty,
    metadata: request.metadata,
    reasoning: request.reasoning,
    response_format: responseFormat,
    stream_options: request.stream_options,
    text: request.text,
    truncation: request.truncation,
    user: request.user,
    store: request.store,
    include: request.include,
  };
}

export function toProviderResponsesRequest(request, config = {}) {
  const requestedModel = request.model || request.model_id || request.upstream_model || config.upstreamModel || '';
  const alias = resolveModelAlias(requestedModel, config);
  const model = alias.upstreamModel || config.upstreamModel || requestedModel;
  if (!model) {
    const error = new Error('Missing model');
    error.statusCode = 400;
    error.code = 'missing_model';
    throw error;
  }
  const next = { ...request, model };
  delete next.model_id;
  delete next.upstream_model;
  return next;
}

export function toChatCompletionsRequest(normalized, overrides = {}) {
  const messages = [];
  if (normalized.instructions) {
    messages.push({ role: 'system', content: normalized.instructions });
  }
  messages.push(...normalized.messages);
  const tools = applyAllowedTools(normalizeTools(normalized.tools), normalized.tool_choice);
  const request = {
    model: overrides.model || normalized.model,
    messages,
    temperature: normalized.temperature,
    top_p: normalized.top_p,
    max_tokens: normalized.max_tokens,
    stop: normalized.stop,
    stream: normalized.stream,
    tools,
    tool_choice: normalizeToolChoice(normalized.tool_choice),
    parallel_tool_calls: normalized.parallel_tool_calls,
    presence_penalty: normalized.presence_penalty,
    frequency_penalty: normalized.frequency_penalty,
    response_format: normalized.response_format,
    metadata: normalized.metadata,
    user: normalized.user,
    reasoning: normalized.reasoning,
    stream_options: normalized.stream_options,
  };

  for (const key of Object.keys(request)) {
    if (request[key] === undefined) delete request[key];
  }

  return request;
}

export function assistantMessageFromResponseOutput(output) {
  const messageItems = Array.isArray(output) ? output.filter((item) => item.type === 'message') : [];
  const functionItems = Array.isArray(output)
    ? output.filter((item) => item.type === 'function_call' || item.type === 'custom_tool_call' || item.type === 'tool_search_call')
    : [];
  const reasoningItems = Array.isArray(output) ? output.filter((item) => item.type === 'reasoning') : [];
  const contentParts = messageItems.map((item) => item.content || []).flat();
  const chatParts = contentParts.map(contentPartToChatPart).filter(Boolean);
  const content = !chatParts.length
    ? ''
    : chatParts.every((part) => part.type === 'text')
    ? chatParts.map((part) => part.text).join('')
    : chatParts;
  const assistant = {
    role: 'assistant',
    content,
  };
  const toolCalls = functionItems.map(chatToolCallFromResponseItem);
  if (toolCalls.length) assistant.tool_calls = toolCalls;
  const reasoningContent = reasoningItems
    .map((item) => reasoningTextFromItem(item))
    .filter(Boolean)
    .join('');
  if (reasoningContent) assistant.reasoning_content = reasoningContent;
  return assistant;
}

export function extractToolCallIdsFromMessages(messages) {
  const ids = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (message?.role !== 'assistant' || !Array.isArray(message.tool_calls)) continue;
    for (const toolCall of message.tool_calls) {
      if (toolCall?.id) ids.push(toolCall.id);
    }
  }
  return ids;
}

export function requestToolsIncludeCommentary(tools) {
  for (const tool of Array.isArray(tools) ? tools : []) {
    if (!isObject(tool)) continue;
    const name = isObject(tool.function) ? tool.function.name : tool.name;
    if (String(name || '') === INTERNAL_COMMENTARY_TOOL) return true;
  }
  return false;
}

export function bridgedCommentaryToolCallsFromMessage(message, tools) {
  if (requestToolsIncludeCommentary(tools)) return [];
  const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
  return toolCalls.filter(
    (toolCall) => toolCall?.type === 'function' && String(toolCall?.function?.name || '') === INTERNAL_COMMENTARY_TOOL,
  );
}

export function stripBridgedCommentaryFromCompletion(completion, tools) {
  if (requestToolsIncludeCommentary(tools)) return completion;
  const choice = Array.isArray(completion?.choices) ? completion.choices[0] : null;
  const message = choice?.message;
  if (!Array.isArray(message?.tool_calls)) return completion;
  const kept = message.tool_calls.filter(
    (toolCall) => !(toolCall?.type === 'function' && String(toolCall?.function?.name || '') === INTERNAL_COMMENTARY_TOOL),
  );
  if (kept.length === message.tool_calls.length) return completion;
  const nextMessage = { ...message };
  if (kept.length) nextMessage.tool_calls = kept;
  else delete nextMessage.tool_calls;
  return {
    ...completion,
    choices: [{ ...choice, message: nextMessage }, ...completion.choices.slice(1)],
  };
}

function commentaryTextFromArguments(argumentsText) {
  const args = parseJsonObject(argumentsText);
  const text = String(args.text ?? args.message ?? args.update ?? args.content ?? '').trim();
  if (text) return text;
  const raw = String(argumentsText ?? '').trim();
  if (!raw || raw.startsWith('{') || raw === 'null') return '';
  return raw;
}

function addInternalCommentaryTool(tools, toolChoice) {
  if (!Array.isArray(tools) || !tools.length) return tools;
  if (toolChoiceDisablesTools(toolChoice)) return tools;
  if (requestToolsIncludeCommentary(tools)) return tools;
  return [...tools, JSON.parse(JSON.stringify(INTERNAL_COMMENTARY_TOOL_DEFINITION))];
}

export function toProviderChatCompletionsRequest(chatRequest, config = {}) {
  const provider = config.upstreamProvider || 'generic';
  const modelAlias = resolveModelAlias(chatRequest.model, config);
  const fallbackReasoning = !chatRequest.reasoning && config.codexReasoningEffort
    ? { effort: config.codexReasoningEffort }
    : chatRequest.reasoning;
  const messages = sanitizeMessagesForChatCompletion(chatRequest.messages, provider);
  const request = {
    model: modelAlias.upstreamModel || config.upstreamModel || chatRequest.model,
    messages,
    temperature: chatRequest.temperature,
    top_p: chatRequest.top_p,
    max_tokens: chatRequest.max_tokens,
    stop: chatRequest.stop,
    stream: chatRequest.stream,
    tools: chatRequest.tools,
    tool_choice: chatRequest.tool_choice,
    parallel_tool_calls: chatRequest.parallel_tool_calls,
    presence_penalty: chatRequest.presence_penalty,
    frequency_penalty: chatRequest.frequency_penalty,
    response_format: chatRequest.response_format,
    user: chatRequest.user,
    stream_options: chatRequest.stream_options,
  };

  if (fallbackReasoning && isObject(fallbackReasoning)) {
    const effort = fallbackReasoning.effort;
    if (effort !== undefined) {
      request.reasoning_effort = effort;
    }
  }

  if (provider === 'deepseek') {
    delete request.reasoning_effort;
    delete request.parallel_tool_calls;
    delete request.frequency_penalty;
    delete request.presence_penalty;
    request.tools = addInternalCommentaryTool(adaptToolsForProvider(request.tools, provider, config), chatRequest.tool_choice);
    assertDeepSeekToolCapacity(request.tools);
    request.messages = addDeepSeekToolInstructions(request.messages, request.tools);
    if (!config.compactionRequest) request.messages = addDeepSeekCompactionInstructions(request.messages);
    if (request.user !== undefined) {
      request.user_id = request.user;
      delete request.user;
    }
    if (request.stream) {
      request.stream_options = { include_usage: true };
    } else {
      delete request.stream_options;
    }
    if (request.max_tokens == null) {
      request.max_tokens = deepseekDefaultMaxTokens(config);
    }
    if (request.response_format?.type === 'json_schema') {
      request.messages = addDeepSeekJsonSchemaInstructions(request.messages, request.response_format);
      request.response_format = { type: 'json_object' };
    }
    Object.assign(request, deepseekReasoningPayload({ alias: modelAlias, reasoning: fallbackReasoning }));
  }

  Object.assign(request, modelAlias.extraBody);

  if (provider === 'deepseek') {
    request.messages = patchDeepSeekThinkingHistory(request.messages, request);
  }
  request.tools = stripGatewayToolMarkers(request.tools);

  for (const key of Object.keys(request)) {
    if (request[key] === undefined) delete request[key];
  }

  return request;
}

function extractAssistantTextFromMessage(message) {
  if (!isObject(message)) return '';
  return toText(message.content);
}

function createBaseResponse({
  id,
  model,
  createdAt,
  status = 'in_progress',
  output = [],
  previousResponseId = null,
  usage = null,
  normalized,
  completedAt = null,
  incompleteReason = null,
  error = null,
}) {
  return {
    id,
    object: 'response',
    created_at: Math.floor(createdAt),
    completed_at: completedAt == null ? null : Math.floor(completedAt),
    status,
    background: false,
    error,
    incomplete_details: incompleteReason ? { reason: incompleteReason } : null,
    instructions: normalized?.instructions || null,
    max_output_tokens: normalized?.max_tokens ?? null,
    model,
    output,
    output_text: outputTextFromOutput(output),
    parallel_tool_calls: normalized?.parallel_tool_calls ?? false,
    previous_response_id: previousResponseId,
    reasoning: normalized?.reasoning ?? null,
    store: normalized?.store ?? false,
    temperature: normalized?.temperature ?? null,
    text: normalized?.text ?? null,
    tool_choice: normalized?.tool_choice ?? 'auto',
    tools: normalized?.tools ?? [],
    top_p: normalized?.top_p ?? null,
    truncation: normalized?.truncation ?? 'disabled',
    usage,
    user: normalized?.user ?? null,
    metadata: normalized?.metadata ?? null,
  };
}

function deepSeekFinishReasonOutcome(finishReason) {
  if (finishReason === 'stop' || finishReason === 'tool_calls') {
    return { status: 'completed', incompleteReason: null, error: null };
  }
  if (finishReason === 'length') {
    return { status: 'incomplete', incompleteReason: 'max_output_tokens', error: null };
  }
  if (finishReason === 'content_filter') {
    return { status: 'incomplete', incompleteReason: 'content_filter', error: null };
  }
  if (finishReason === 'insufficient_system_resource') {
    return {
      status: 'failed',
      incompleteReason: null,
      error: {
        code: 'server_is_overloaded',
        message: 'DeepSeek ended the response because upstream resources were insufficient.',
      },
    };
  }
  const label = finishReason == null || finishReason === '' ? 'missing' : String(finishReason);
  return {
    status: 'failed',
    incompleteReason: null,
    error: {
      code: 'upstream_error',
      message: `DeepSeek returned an unsupported finish_reason: ${label}.`,
    },
  };
}

function normalizeResponsesUsage(usage) {
  if (!isObject(usage)) return null;
  const inputTokens = usage.input_tokens ?? usage.prompt_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? usage.completion_tokens ?? 0;
  return {
    input_tokens: inputTokens,
    input_tokens_details: usage.input_tokens_details ?? {
      cached_tokens: usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens ?? 0,
    },
    output_tokens: outputTokens,
    output_tokens_details: usage.output_tokens_details ?? {
      reasoning_tokens: usage.completion_tokens_details?.reasoning_tokens ?? usage.reasoning_tokens ?? 0,
    },
    total_tokens: usage.total_tokens ?? inputTokens + outputTokens,
  };
}

function outputTextFromOutput(output) {
  if (!Array.isArray(output)) return '';
  const chunks = [];
  for (const item of output) {
    if (item?.type !== 'message' || !Array.isArray(item.content)) continue;
    if (item.phase === 'commentary') continue;
    for (const part of item.content) {
      if (part?.type === 'output_text' && typeof part.text === 'string') {
        chunks.push(part.text);
      }
    }
  }
  return chunks.join('');
}

export function createResponseEnvelope({
  id = generateId('resp'),
  model,
  createdAt = Date.now() / 1000,
  status = 'in_progress',
  output = [],
  previousResponseId = null,
  usage = null,
  normalized,
  completedAt = null,
  incompleteReason = null,
  error = null,
}) {
  return createBaseResponse({
    id,
    model,
    createdAt,
    status,
    output,
    previousResponseId,
    usage,
    normalized,
    completedAt,
    incompleteReason,
    error,
  });
}

const PARALLEL_TOOL_WRAPPER_NAMES = new Set(['multi_tool_use.parallel', 'multi_tool_use_parallel']);
const EMITTED_TOOL_NAME_PREFIX = 'functions.';

function isParallelToolWrapperName(name) {
  const raw = String(name || '').toLowerCase();
  const stripped = raw.startsWith(EMITTED_TOOL_NAME_PREFIX) ? raw.slice(EMITTED_TOOL_NAME_PREFIX.length) : raw;
  return PARALLEL_TOOL_WRAPPER_NAMES.has(stripped);
}

function toolNameMatchKey(name) {
  return String(name || '').toLowerCase().replace(/\./g, '__');
}

function resolveEmittedToolName(name, knownNames) {
  const raw = String(name || '');
  if (!raw || !knownNames) return name;
  const known = knownNames instanceof Set ? knownNames : new Set(knownNames);
  if (!known.size || known.has(raw)) return name;
  const candidates = [raw];
  if (raw.startsWith(EMITTED_TOOL_NAME_PREFIX)) candidates.push(raw.slice(EMITTED_TOOL_NAME_PREFIX.length));
  for (const candidate of candidates) {
    if (known.has(candidate)) return candidate;
  }
  const knownByKey = new Map();
  for (const knownName of known) {
    const key = toolNameMatchKey(knownName);
    if (!knownByKey.has(key)) knownByKey.set(key, knownName);
  }
  for (const candidate of candidates) {
    const match = knownByKey.get(toolNameMatchKey(candidate));
    if (match) return match;
  }
  return name;
}

export function chatToolNamesFromTools(tools) {
  const names = [];
  for (const tool of Array.isArray(tools) ? tools : []) {
    if (!isObject(tool)) continue;
    const name = isObject(tool.function) ? tool.function.name : tool.name;
    if (name) names.push(String(name));
  }
  return names;
}

export function ensureToolCallIdsInCompletion(completion) {
  const choice = Array.isArray(completion?.choices) ? completion.choices[0] : null;
  const toolCalls = choice?.message?.tool_calls;
  if (!Array.isArray(toolCalls) || toolCalls.every((toolCall) => !isObject(toolCall) || toolCall.id)) {
    return completion;
  }
  const withIds = toolCalls.map((toolCall) => (
    isObject(toolCall) && !toolCall.id ? { ...toolCall, id: generateId('call') } : toolCall
  ));
  return {
    ...completion,
    choices: completion.choices.map((entry, index) => (index === 0
      ? { ...entry, message: { ...entry.message, tool_calls: withIds } }
      : entry)),
  };
}

export function resolveEmittedToolCallNamesInCompletion(completion, knownNames) {
  const choice = Array.isArray(completion?.choices) ? completion.choices[0] : null;
  const toolCalls = choice?.message?.tool_calls;
  if (!Array.isArray(toolCalls) || !toolCalls.length) return completion;
  let changed = false;
  const resolved = toolCalls.map((toolCall) => {
    const name = toolCall?.function?.name;
    if (!name) return toolCall;
    const resolvedName = resolveEmittedToolName(name, knownNames);
    if (resolvedName === name) return toolCall;
    changed = true;
    return { ...toolCall, function: { ...toolCall.function, name: resolvedName } };
  });
  if (!changed) return completion;
  return {
    ...completion,
    choices: completion.choices.map((entry, index) => (index === 0
      ? { ...entry, message: { ...entry.message, tool_calls: resolved } }
      : entry)),
  };
}

function parallelToolUsesFromArguments(argumentsText) {
  const parsed = safeJsonParse(String(argumentsText || ''));
  if (!parsed.ok || !isObject(parsed.value)) return null;
  const uses = Array.isArray(parsed.value.tool_uses) ? parsed.value.tool_uses : null;
  if (!uses || !uses.length) return null;
  const calls = [];
  for (const use of uses) {
    if (!isObject(use)) return null;
    const name = String(use.recipient_name || use.name || '').replace(/^functions\./, '');
    if (!name) return null;
    const parameters = use.parameters ?? use.arguments ?? {};
    calls.push({
      name,
      arguments: typeof parameters === 'string' ? parameters : JSON.stringify(parameters),
    });
  }
  return calls;
}

function expandParallelToolCalls(toolCalls) {
  if (!Array.isArray(toolCalls)) return toolCalls;
  if (!toolCalls.some((toolCall) => isParallelToolWrapperName(toolCall?.function?.name))) return toolCalls;
  const expanded = [];
  for (const toolCall of toolCalls) {
    const uses = isParallelToolWrapperName(toolCall?.function?.name)
      ? parallelToolUsesFromArguments(toolCall.function?.arguments)
      : null;
    if (!uses) {
      expanded.push(toolCall);
      continue;
    }
    for (const use of uses) {
      expanded.push({
        id: generateId('call'),
        type: 'function',
        function: { name: use.name, arguments: use.arguments },
      });
    }
  }
  return expanded;
}

export function expandParallelToolCallsInCompletion(completion) {
  const choice = Array.isArray(completion?.choices) ? completion.choices[0] : null;
  const toolCalls = choice?.message?.tool_calls;
  if (!Array.isArray(toolCalls)) return completion;
  const expanded = expandParallelToolCalls(toolCalls);
  if (expanded === toolCalls) return completion;
  return {
    ...completion,
    choices: completion.choices.map((entry, index) => (index === 0
      ? { ...entry, message: { ...entry.message, tool_calls: expanded } }
      : entry)),
  };
}

export function convertChatCompletionToResponses({ completion: rawCompletion, model, previousResponseId, normalized, responseId = generateId('resp') }) {
  const toolSchemas = buildToolSchemas(normalized?.tools);
  const knownToolNames = new Set([...toolSchemas.keys(), INTERNAL_COMMENTARY_TOOL]);
  const completion = resolveEmittedToolCallNamesInCompletion(
    expandParallelToolCallsInCompletion(rawCompletion),
    knownToolNames,
  );
  const createdAt = completion.created || Date.now() / 1000;
  const choice = Array.isArray(completion.choices) ? completion.choices[0] : null;
  const outcome = deepSeekFinishReasonOutcome(choice?.finish_reason);
  const message = choice?.message || {};
  const content = chatContentToResponseOutputParts(message.content);
  const messageHasToolCalls = hasChatToolCalls(message);
  const toolNames = buildToolNames(normalized?.tools);
  const customToolNames = buildCustomToolNames(normalized?.tools);
  const customToolInputModes = buildCustomToolInputModes(normalized?.tools);
  const output = [];

  if (content.length) {
    output.push({
      type: 'message',
      id: generateId('msg'),
      role: 'assistant',
      content,
      status: outcome.status,
      phase: message.phase || (messageHasToolCalls ? 'commentary' : 'final_answer'),
    });
  }

  if (messageHasToolCalls) {
    const bridgedCommentary = !requestToolsIncludeCommentary(normalized?.tools);
    for (const toolCall of message.tool_calls) {
      if (bridgedCommentary && toolCall?.type === 'function' && String(toolCall?.function?.name || '') === INTERNAL_COMMENTARY_TOOL) {
        const text = commentaryTextFromArguments(toolCall.function?.arguments);
        if (text) {
          output.push({
            type: 'message',
            id: generateId('msg'),
            role: 'assistant',
            content: [normalizeOutputTextPart(text)],
            status: 'completed',
            phase: 'commentary',
          });
        }
        continue;
      }
      const item = responseItemFromChatToolCall(toolCall, toolNames, customToolNames, customToolInputModes);
      item.status = outcome.status;
      normalizeFunctionCallItemArguments(item, toolSchemas);
      output.push(item);
    }
  }

  if (message.reasoning_content) {
    const reasoningText = normalizeReasoningContent(message.reasoning_content);
    output.unshift({
      type: 'reasoning',
      id: generateId('rs'),
      summary: [normalizeSummaryTextPart(reasoningSummaryText(reasoningText))],
      content: [],
      reasoning_content: reasoningText,
      encrypted_content: encodeGatewayReasoning(reasoningText),
      status: outcome.status,
    });
  }

  return createBaseResponse({
    id: responseId,
    model,
    createdAt,
    status: outcome.status,
    output,
    previousResponseId: previousResponseId ?? null,
    usage: normalizeResponsesUsage(completion.usage),
    normalized,
    completedAt: Date.now() / 1000,
    incompleteReason: outcome.incompleteReason,
    error: outcome.error,
  });
}

export class ResponsesStreamMapper {
  constructor({
    responseId = generateId('resp'),
    model,
    createdAt = Date.now() / 1000,
    previousResponseId = null,
    normalized,
    emitReasoningSummary = true,
    emitReasoningText = false,
    holdToolItemEvents = false,
    knownToolNames,
    config = {},
  } = {}) {
    this.responseId = responseId;
    this.model = model;
    this.createdAt = createdAt;
    this.previousResponseId = previousResponseId;
    this.normalized = normalized;
    this.emitReasoningSummary = Boolean(emitReasoningSummary);
    this.emitReasoningText = Boolean(emitReasoningText);
    this.holdToolItemEvents = Boolean(holdToolItemEvents);
    this.roundStartIndex = 0;
    this.sequenceNumber = 0;
    this.output = [];
    this.messageItem = null;
    this.reasoningItem = null;
    this.toolItems = new Map();
    this.text = '';
    this.reasoningText = '';
    this.reasoningItemDone = false;
    this.finishReason = null;
    this.usage = null;
    this.pendingFinishReason = null;
    this.pendingUsage = null;
    this.completedAt = null;
    this.finalized = false;
    this.terminalStatus = null;
    this.messageItemAdded = false;
    this.messageContentAdded = false;
    this.messageItemClosed = false;
    this.holdVisibleText = false;
    this.reasoningContentAdded = false;
    this.reasoningSummaryAdded = false;
    this.reasoningItemAdded = false;
    this.streamedReasoningSummaryText = '';
    this.toolSchemas = buildToolSchemas(normalized?.tools);
    this.knownToolNames = new Set([
      ...(Array.isArray(knownToolNames) || knownToolNames instanceof Set ? knownToolNames : []),
      ...this.toolSchemas.keys(),
      INTERNAL_COMMENTARY_TOOL,
    ]);
    this.toolNames = buildToolNames(normalized?.tools);
    this.customToolNames = buildCustomToolNames(normalized?.tools);
    this.customToolInputModes = buildCustomToolInputModes(normalized?.tools);
    this.bridgedCommentaryTool = !requestToolsIncludeCommentary(normalized?.tools);
    this.toolItemsAdded = new Set();
    this.toolItemsBufferedArguments = new Set();
    this.toolItemsStreamedArgumentLengths = new Map();
    this.config = config;
  }

  nextSequence() {
    this.sequenceNumber += 1;
    return this.sequenceNumber;
  }

  response(status = 'in_progress') {
    const outcome = deepSeekFinishReasonOutcome(this.finishReason);
    return createBaseResponse({
      id: this.responseId,
      model: this.model,
      createdAt: this.createdAt,
      status,
      output: this.output.map(snapshotResponseItem),
      previousResponseId: this.previousResponseId,
      usage: this.usage,
      normalized: this.normalized,
      completedAt: this.completedAt,
      incompleteReason: status === 'in_progress' ? null : outcome.incompleteReason,
      error: status === 'failed' ? outcome.error : null,
    });
  }

  createdEvent() {
    return {
      type: 'response.created',
      sequence_number: this.nextSequence(),
      response: this.response('in_progress'),
    };
  }

  inProgressEvent() {
    return {
      type: 'response.in_progress',
      sequence_number: this.nextSequence(),
      response: createBaseResponse({
        id: this.responseId,
        model: this.model,
        createdAt: this.createdAt,
        status: 'in_progress',
        previousResponseId: this.previousResponseId,
      }),
    };
  }

  ensureMessageItem() {
    this.ensureMessageItemState();
    if (!this.messageItemAdded) {
      this.messageItemAdded = true;
      return {
        type: 'response.output_item.added',
        sequence_number: this.nextSequence(),
        output_index: this.output.length - 1,
        item: snapshotResponseItem(this.messageItem),
      };
    }
    return null;
  }

  ensureMessageItemState() {
    if (!this.messageItem) {
      this.messageItem = {
        id: generateId('msg'),
        type: 'message',
        status: 'in_progress',
        role: 'assistant',
        phase: this.messageStartsAsCommentary() ? 'commentary' : 'final_answer',
        content: [],
      };
      this.output.push(this.messageItem);
    }
  }

  messageStartsAsCommentary() {
    return this.toolItems.size > 0 || (this.config.upstreamProvider === 'deepseek' && hasRunnableChatTools(this.normalized));
  }

  finalizeMessagePhase() {
    if (!this.messageItem || this.toolItems.size > 0) return;
    this.messageItem.phase = 'final_answer';
  }

  closeMessageItemAsCommentary(status = 'completed') {
    if (!this.messageItem || this.messageItemClosed) return [];
    this.messageItem.phase = 'commentary';
    if (!this.messageItemAdded) return [];
    this.messageItemClosed = true;
    this.messageItem.status = status;
    this.messageItem.content[0].text = this.text;
    const outputIndex = this.output.indexOf(this.messageItem);
    return [
      {
        type: 'response.output_text.done',
        sequence_number: this.nextSequence(),
        output_index: outputIndex,
        content_index: 0,
        item_id: this.messageItem.id,
        text: this.text,
        logprobs: [],
      },
      {
        type: 'response.content_part.done',
        sequence_number: this.nextSequence(),
        output_index: outputIndex,
        content_index: 0,
        item_id: this.messageItem.id,
        part: snapshotResponsePart(this.messageItem.content[0]),
      },
      {
        type: 'response.output_item.done',
        sequence_number: this.nextSequence(),
        output_index: outputIndex,
        item: snapshotResponseItem(this.messageItem),
      },
    ];
  }

  ensureReasoningItem() {
    this.ensureReasoningItemState();
    if (!this.reasoningItemAdded) {
      this.reasoningItemAdded = true;
      return {
        type: 'response.output_item.added',
        sequence_number: this.nextSequence(),
        output_index: this.output.indexOf(this.reasoningItem),
        item: snapshotResponseItem(this.reasoningItem),
      };
    }
    return null;
  }

  ensureReasoningItemState() {
    if (!this.reasoningItem) {
      this.reasoningItem = {
        id: generateId('rs'),
        type: 'reasoning',
        status: 'in_progress',
        summary: [],
        content: this.emitReasoningText ? [normalizeReasoningTextPart('')] : [],
        encrypted_content: null,
      };
      this.output.push(this.reasoningItem);
    }
  }

  ensureReasoningContentPart(events) {
    if (!this.emitReasoningText || this.reasoningContentAdded || !this.reasoningItem) return;
    if (!this.reasoningItem.content[0]) this.reasoningItem.content[0] = normalizeReasoningTextPart('');
    this.reasoningContentAdded = true;
    events.push({
      type: 'response.content_part.added',
      sequence_number: this.nextSequence(),
      output_index: this.output.indexOf(this.reasoningItem),
      content_index: 0,
      item_id: this.reasoningItem.id,
      part: snapshotResponsePart(this.reasoningItem.content[0]),
    });
  }

  syncReasoningItemContent() {
    if (!this.reasoningItem) return;
    const reasoningText = normalizeReasoningContent(this.reasoningText);
    if (this.emitReasoningText) {
      if (!this.reasoningItem.content[0]) this.reasoningItem.content[0] = normalizeReasoningTextPart('');
      this.reasoningItem.content[0].text = reasoningText;
    } else {
      this.reasoningItem.content = [];
    }
    if (reasoningText) this.reasoningItem.reasoning_content = reasoningText;
    else delete this.reasoningItem.reasoning_content;
  }

  reasoningSummarySourceText({ final = false } = {}) {
    if (final) return this.reasoningText;
    const boundary = this.reasoningText.lastIndexOf('\n');
    return boundary < 0 ? '' : this.reasoningText.slice(0, boundary + 1);
  }

  appendReasoningSummaryDelta(events, { final = false } = {}) {
    if (!this.emitReasoningSummary || !this.reasoningItem) return;
    if (!this.reasoningSummaryAdded) {
      this.reasoningSummaryAdded = true;
      this.reasoningItem.summary.push(normalizeSummaryTextPart(''));
      events.push({
        type: 'response.reasoning_summary_part.added',
        sequence_number: this.nextSequence(),
        output_index: this.output.indexOf(this.reasoningItem),
        item_id: this.reasoningItem.id,
        summary_index: 0,
        part: snapshotResponsePart(this.reasoningItem.summary[0]),
      });
    }
    const nextSummaryText = reasoningSummaryText(this.reasoningSummarySourceText({ final }));
    if (final) this.reasoningItem.summary[0].text = nextSummaryText;
    if (nextSummaryText === this.streamedReasoningSummaryText) return;
    if (!nextSummaryText.startsWith(this.streamedReasoningSummaryText)) {
      if (!final) return;
      this.streamedReasoningSummaryText = nextSummaryText;
      return;
    }
    const deltaText = nextSummaryText.slice(this.streamedReasoningSummaryText.length);
    this.streamedReasoningSummaryText = nextSummaryText;
    this.reasoningItem.summary[0].text = nextSummaryText;
    for (const delta of splitBufferedReasoningDeltas(deltaText)) {
      events.push({
        type: 'response.reasoning_summary_text.delta',
        sequence_number: this.nextSequence(),
        output_index: this.output.indexOf(this.reasoningItem),
        item_id: this.reasoningItem.id,
        summary_index: 0,
        delta,
      });
    }
  }

  holdVisibleTextUntilDone() {
    this.holdVisibleText = true;
  }

  textDelta(delta) {
    const events = [...this.closeReasoningItem('completed')];
    if (this.messageItemClosed) return events;
    if (!this.messageItemAdded && (this.holdVisibleText || this.toolItems.size > 0)) {
      this.ensureMessageItemState();
      if (!this.messageItem.content.length) this.messageItem.content.push(normalizeOutputTextPart(''));
      this.text += delta;
      this.messageItem.content[0].text = this.text;
      return events;
    }
    const added = this.ensureMessageItem();
    if (added) events.push(added);
    if (!this.messageContentAdded) {
      this.messageContentAdded = true;
      this.messageItem.content.push(normalizeOutputTextPart(''));
      events.push({
        type: 'response.content_part.added',
        sequence_number: this.nextSequence(),
        output_index: this.output.indexOf(this.messageItem),
        content_index: 0,
        item_id: this.messageItem.id,
        part: snapshotResponsePart(this.messageItem.content[0]),
      });
    }
    this.text += delta;
    this.messageItem.content[0].text = this.text;
    events.push({
      type: 'response.output_text.delta',
      sequence_number: this.nextSequence(),
      output_index: this.output.indexOf(this.messageItem),
      content_index: 0,
      item_id: this.messageItem.id,
      delta,
      logprobs: [],
    });
    return events;
  }

  reasoningDelta(delta) {
    this.reasoningText += delta;
    if (this.reasoningItemDone) {
      this.syncReasoningItemContent();
      return [];
    }
    if (this.messageItem || this.toolItems.size > 0) {
      if (!this.reasoningItem) {
        this.reasoningItem = {
          id: generateId('rs'),
          type: 'reasoning',
          status: 'in_progress',
          summary: [],
          content: this.emitReasoningText ? [normalizeReasoningTextPart('')] : [],
          encrypted_content: null,
        };
        this.output.push(this.reasoningItem);
      }
      this.syncReasoningItemContent();
      return [];
    }

    const events = [];
    const added = this.ensureReasoningItem();
    if (added) events.push(added);
    this.ensureReasoningContentPart(events);
    this.syncReasoningItemContent();
    this.appendReasoningSummaryDelta(events);
    if (this.emitReasoningText) {
      events.push({
        type: 'response.reasoning_text.delta',
        sequence_number: this.nextSequence(),
        output_index: this.output.indexOf(this.reasoningItem),
        item_id: this.reasoningItem.id,
        content_index: 0,
        delta,
      });
    }
    return events;
  }

  createToolItem(toolCall) {
    const callId = toolCall.id || generateId('call');
    const name = toolCall.function?.name;
    if (isCodexToolSearchTool(name)) {
      return {
        id: generateId('tsc'),
        type: 'tool_search_call',
        status: 'in_progress',
        call_id: callId,
        execution: 'client',
        arguments: '',
      };
    }
    if (name && this.customToolNames.has(name)) {
      return {
        id: callId,
        type: 'custom_tool_call',
        status: 'in_progress',
        call_id: callId,
        ...decodedToolName(name, this.toolNames),
        input: '',
        arguments: '',
      };
    }
    return {
      id: callId,
      type: 'function_call',
      status: 'in_progress',
      call_id: callId,
      ...decodedToolName(name, this.toolNames),
      arguments: '',
    };
  }

  applyToolCallName(item, name) {
    if (!name || item.type === 'tool_search_call') return;
    Object.assign(item, decodedToolName(name, this.toolNames));
    if (item.type === 'function_call' && this.customToolNames.has(name)) {
      item.type = 'custom_tool_call';
      if (typeof item.input !== 'string') item.input = '';
    }
  }

  functionDelta(rawToolCall) {
    let toolCall = rawToolCall;
    const emittedName = toolCall.function?.name;
    if (emittedName) {
      const resolvedName = resolveEmittedToolName(emittedName, this.knownToolNames);
      if (resolvedName !== emittedName) {
        toolCall = { ...toolCall, function: { ...toolCall.function, name: resolvedName } };
      }
    }
    const events = [...this.closeReasoningItem('completed')];
    events.push(...this.closeMessageItemAsCommentary('completed'));
    const index = toolCall.index ?? 0;
    let item = this.toolItems.get(index);
    if (!item) {
      item = this.createToolItem(toolCall);
      this.toolItems.set(index, item);
      this.output.push(item);
      if (this.holdToolItemEvents || isParallelToolWrapperName(toolCall.function?.name)) {
        this.toolItemsBufferedArguments.add(index);
      }
      if (!this.holdToolItemEvents && hasToolCallFunctionName(toolCall) && !isParallelToolWrapperName(toolCall.function?.name) && !this.isBridgedCommentaryToolItem(item)) {
        events.push(...this.addToolItemEvents(index));
      }
    }
    if (isCodexToolSearchTool(toolCall.function?.name)) {
      const wasAdded = this.toolItemsAdded.has(index);
      item = convertItemToToolSearchCall(item);
      this.toolItems.set(index, item);
      if (!wasAdded && !this.holdToolItemEvents && hasToolCallFunctionName(toolCall)) {
        events.push(...this.addToolItemEvents(index));
      }
    } else if (toolCall.function?.name) {
      this.applyToolCallName(item, toolCall.function.name);
      if (!this.holdToolItemEvents && !this.toolItemsAdded.has(index) && !isParallelToolWrapperName(item.name) && !this.isBridgedCommentaryToolItem(item)) {
        events.push(...this.addToolItemEvents(index));
      }
    }
    item.arguments += toolCall.function?.arguments || '';
    if (functionCallItemNeedsArgumentNormalization(item, this.toolSchemas)) {
      this.toolItemsBufferedArguments.add(index);
    }
    const streamedLength = this.toolItemsStreamedArgumentLengths.get(index) || 0;
    const argumentDelta = item.arguments.slice(streamedLength);
    if (
      argumentDelta &&
      item.type === 'function_call' &&
      this.toolItemsAdded.has(index) &&
      !this.toolItemsBufferedArguments.has(index)
    ) {
      this.toolItemsStreamedArgumentLengths.set(index, item.arguments.length);
      events.push({
        type: 'response.function_call_arguments.delta',
        sequence_number: this.nextSequence(),
        output_index: this.output.indexOf(item),
        item_id: item.id,
        delta: argumentDelta,
      });
    }
    return events;
  }

  addToolItemEvents(index) {
    if (this.toolItemsAdded.has(index)) return [];
    const item = this.toolItems.get(index);
    if (!item) return [];
    this.toolItemsAdded.add(index);
    return [{
      type: 'response.output_item.added',
      sequence_number: this.nextSequence(),
      output_index: this.output.indexOf(item),
      item: snapshotResponseItem(item),
    }];
  }

  expandParallelToolItems() {
    for (const [index, item] of [...this.toolItems.entries()]) {
      if (item.type !== 'function_call' || !isParallelToolWrapperName(item.name)) continue;
      if (this.toolItemsAdded.has(index)) continue;
      const uses = parallelToolUsesFromArguments(item.arguments);
      if (!uses) continue;
      const at = this.output.indexOf(item);
      this.toolItems.delete(index);
      this.toolItemsBufferedArguments.delete(index);
      this.toolItemsStreamedArgumentLengths.delete(index);
      const expandedItems = uses.map((use, position) => {
        const key = `${index}:${position}`;
        const expanded = this.createToolItem({
          id: generateId('call'),
          function: { name: resolveEmittedToolName(use.name, this.knownToolNames) },
        });
        expanded.arguments = use.arguments;
        this.toolItems.set(key, expanded);
        this.toolItemsBufferedArguments.add(key);
        return expanded;
      });
      if (at >= 0) this.output.splice(at, 1, ...expandedItems);
      else this.output.push(...expandedItems);
    }
  }

  isBridgedCommentaryToolItem(item) {
    return Boolean(this.bridgedCommentaryTool) && item?.type === 'function_call' && item?.name === INTERNAL_COMMENTARY_TOOL;
  }

  convertBridgedCommentaryItems() {
    const events = [];
    for (const [index, item] of [...this.toolItems.entries()]) {
      if (!this.isBridgedCommentaryToolItem(item) || this.toolItemsAdded.has(index)) continue;
      this.toolItems.delete(index);
      this.toolItemsBufferedArguments.delete(index);
      this.toolItemsStreamedArgumentLengths.delete(index);
      const at = this.output.indexOf(item);
      const text = commentaryTextFromArguments(item.arguments);
      if (!text) {
        if (at >= 0) this.output.splice(at, 1);
        continue;
      }
      const messageItem = {
        type: 'message',
        id: generateId('msg'),
        role: 'assistant',
        status: 'completed',
        phase: 'commentary',
        content: [normalizeOutputTextPart(text)],
      };
      if (at >= 0) this.output.splice(at, 1, messageItem);
      else this.output.push(messageItem);
      const outputIndex = this.output.indexOf(messageItem);
      events.push({
        type: 'response.output_item.added',
        sequence_number: this.nextSequence(),
        output_index: outputIndex,
        item: snapshotResponseItem({ ...messageItem, status: 'in_progress', content: [] }),
      });
      events.push({
        type: 'response.content_part.added',
        sequence_number: this.nextSequence(),
        output_index: outputIndex,
        content_index: 0,
        item_id: messageItem.id,
        part: snapshotResponsePart(normalizeOutputTextPart('')),
      });
      events.push({
        type: 'response.output_text.delta',
        sequence_number: this.nextSequence(),
        output_index: outputIndex,
        content_index: 0,
        item_id: messageItem.id,
        delta: text,
        logprobs: [],
      });
      events.push({
        type: 'response.output_text.done',
        sequence_number: this.nextSequence(),
        output_index: outputIndex,
        content_index: 0,
        item_id: messageItem.id,
        text,
        logprobs: [],
      });
      events.push({
        type: 'response.content_part.done',
        sequence_number: this.nextSequence(),
        output_index: outputIndex,
        content_index: 0,
        item_id: messageItem.id,
        part: snapshotResponsePart(messageItem.content[0]),
      });
      events.push({
        type: 'response.output_item.done',
        sequence_number: this.nextSequence(),
        output_index: outputIndex,
        item: snapshotResponseItem(messageItem),
      });
    }
    return events;
  }

  finalize(finishReason = 'stop', usage = null) {
    if (this.finalized) return [];
    this.finalized = true;
    this.expandParallelToolItems();
    const outcome = deepSeekFinishReasonOutcome(finishReason);
    const status = outcome.status;
    this.terminalStatus = status;
    this.finishReason = finishReason;
    this.usage = normalizeResponsesUsage(usage);
    this.completedAt = Date.now() / 1000;
    const events = [];
    if (this.messageItem) {
      this.messageItem.status = status;
      const outputIndex = this.output.indexOf(this.messageItem);
      if (!this.messageItemClosed) {
        this.finalizeMessagePhase();
        if (!this.messageItem.content.length) this.messageItem.content.push(normalizeOutputTextPart(''));
        this.messageItem.content[0].text = this.text;
      }
      if (!this.messageItemAdded) {
        this.messageItemAdded = true;
        this.messageContentAdded = true;
        this.messageItemClosed = true;
        events.push({
          type: 'response.output_item.added',
          sequence_number: this.nextSequence(),
          output_index: outputIndex,
          item: snapshotResponseItem({
            ...this.messageItem,
            status: 'in_progress',
            content: [],
          }),
        });
        events.push({
          type: 'response.content_part.added',
          sequence_number: this.nextSequence(),
          output_index: outputIndex,
          content_index: 0,
          item_id: this.messageItem.id,
          part: snapshotResponsePart(normalizeOutputTextPart('')),
        });
        if (this.text) {
          events.push({
            type: 'response.output_text.delta',
            sequence_number: this.nextSequence(),
            output_index: outputIndex,
            content_index: 0,
            item_id: this.messageItem.id,
            delta: this.text,
            logprobs: [],
          });
        }
        events.push(...this.messageDoneEvents(outputIndex));
      } else if (!this.messageItemClosed) {
        this.messageItemClosed = true;
        events.push(...this.messageDoneEvents(outputIndex));
      }
    }
    events.push(...this.closeReasoningItem(status));
    events.push(...this.convertBridgedCommentaryItems());
    for (const [index, item] of this.toolItems.entries()) {
      item.status = status;
      if (item.type === 'tool_search_call') finalizeToolSearchCallItemArguments(item);
      else if (item.type === 'custom_tool_call') {
        const inputMode = customToolInputModeForItem(item, this.customToolInputModes);
        const rawArguments = item.arguments;
        item.input = customToolInputFromArguments(rawArguments, inputMode);
        const replayArguments = isApplyPatchInputMode(inputMode)
          ? applyPatchReplayArguments(rawArguments, inputMode, item.input)
          : rawArguments;
        if (replayArguments) item.arguments = replayArguments;
        else delete item.arguments;
      }
      else normalizeFunctionCallItemArguments(item, this.toolSchemas);
      const outputIndex = this.output.indexOf(item);
      if (!this.toolItemsAdded.has(index)) {
        this.toolItemsAdded.add(index);
        events.push({
          type: 'response.output_item.added',
          sequence_number: this.nextSequence(),
          output_index: outputIndex,
          item: snapshotResponseItem(item.type === 'tool_search_call' ? {
            ...item,
            status: 'in_progress',
          } : item.type === 'custom_tool_call' ? {
            ...item,
            status: 'in_progress',
            input: '',
          } : {
            ...item,
            status: 'in_progress',
            arguments: '',
          }),
        });
      }
      if (item.type === 'function_call' && this.toolItemsBufferedArguments.has(index) && item.arguments) {
        events.push({
          type: 'response.function_call_arguments.delta',
          sequence_number: this.nextSequence(),
          output_index: outputIndex,
          item_id: item.id,
          delta: item.arguments,
        });
      }
      if (item.type === 'function_call') {
        events.push({
          type: 'response.function_call_arguments.done',
          sequence_number: this.nextSequence(),
          output_index: outputIndex,
          item_id: item.id,
          arguments: item.arguments,
        });
      }
      events.push({
        type: 'response.output_item.done',
        sequence_number: this.nextSequence(),
        output_index: outputIndex,
        item: snapshotResponseItem(item),
      });
    }
    const response = createBaseResponse({
      id: this.responseId,
      model: this.model,
      createdAt: this.createdAt,
      status,
      output: this.output.map(snapshotResponseItem),
      previousResponseId: this.previousResponseId,
      usage: normalizeResponsesUsage(usage),
      normalized: this.normalized,
      completedAt: Date.now() / 1000,
      incompleteReason: outcome.incompleteReason,
      error: outcome.error,
    });
    events.push({
      type: status === 'completed' ? 'response.completed' : status === 'incomplete' ? 'response.incomplete' : 'response.failed',
      sequence_number: this.nextSequence(),
      response,
    });
    return events;
  }

  messageDoneEvents(outputIndex) {
    return [
      {
        type: 'response.output_text.done',
        sequence_number: this.nextSequence(),
        output_index: outputIndex,
        content_index: 0,
        item_id: this.messageItem.id,
        text: this.messageItem.content[0].text,
        logprobs: [],
      },
      {
        type: 'response.content_part.done',
        sequence_number: this.nextSequence(),
        output_index: outputIndex,
        content_index: 0,
        item_id: this.messageItem.id,
        part: snapshotResponsePart(this.messageItem.content[0]),
      },
      {
        type: 'response.output_item.done',
        sequence_number: this.nextSequence(),
        output_index: outputIndex,
        item: snapshotResponseItem(this.messageItem),
      },
    ];
  }

  assistantMessage() {
    return assistantMessageFromResponseOutput(this.output);
  }

  markRoundStart() {
    this.roundStartIndex = this.output.length;
  }

  roundAssistantMessage() {
    return assistantMessageFromResponseOutput(this.output.slice(this.roundStartIndex));
  }

  removeToolItems(predicate = () => true) {
    for (const [index, item] of [...this.toolItems.entries()]) {
      if (!predicate(item)) continue;
      if (this.toolItemsAdded.has(index)) continue;
      this.toolItems.delete(index);
      this.toolItemsBufferedArguments.delete(index);
      this.toolItemsStreamedArgumentLengths.delete(index);
      const at = this.output.indexOf(item);
      if (at >= 0) this.output.splice(at, 1);
    }
  }

  beginNextRound() {
    const events = [...this.closeReasoningItem('completed'), ...this.closeMessageItemAsCommentary('completed')];
    if (this.reasoningItem && !this.reasoningItemAdded) {
      const at = this.output.indexOf(this.reasoningItem);
      if (at >= 0) this.output.splice(at, 1);
    }
    if (this.messageItem && !this.messageItemAdded) {
      const at = this.output.indexOf(this.messageItem);
      if (at >= 0) this.output.splice(at, 1);
    }
    for (const [index, item] of this.toolItems.entries()) {
      if (this.toolItemsAdded.has(index)) continue;
      const at = this.output.indexOf(item);
      if (at >= 0) this.output.splice(at, 1);
    }
    this.messageItem = null;
    this.reasoningItem = null;
    this.toolItems = new Map();
    this.toolItemsAdded = new Set();
    this.toolItemsBufferedArguments = new Set();
    this.toolItemsStreamedArgumentLengths = new Map();
    this.text = '';
    this.reasoningText = '';
    this.reasoningItemDone = false;
    this.messageItemAdded = false;
    this.messageContentAdded = false;
    this.messageItemClosed = false;
    this.holdVisibleText = false;
    this.reasoningContentAdded = false;
    this.reasoningSummaryAdded = false;
    this.reasoningItemAdded = false;
    this.streamedReasoningSummaryText = '';
    this.pendingFinishReason = null;
    this.pendingUsage = null;
    return events;
  }

  replaceBufferedAssistantText(text) {
    if (this.messageItemAdded || this.messageContentAdded) return null;
    if (!this.messageItem) return this.textDelta(String(text ?? ''));
    this.text = String(text ?? '');
    if (this.messageItem.content.length) this.messageItem.content[0].text = this.text;
    return [];
  }

  closeReasoningItem(status = 'completed') {
    if (!this.reasoningItem || this.reasoningItemDone) return [];
    this.reasoningItemDone = true;
    this.reasoningItem.status = status;
    this.syncReasoningItemContent();
    this.reasoningItem.encrypted_content = encodeGatewayReasoning(normalizeReasoningContent(this.reasoningText));
    const events = [];
    if (!this.reasoningItemAdded) {
      this.reasoningItemAdded = true;
      const addedItem = {
        ...this.reasoningItem,
        status: 'in_progress',
        summary: [],
        content: this.emitReasoningText ? [normalizeReasoningTextPart('')] : [],
        encrypted_content: null,
      };
      delete addedItem.reasoning_content;
      events.push({
        type: 'response.output_item.added',
        sequence_number: this.nextSequence(),
        output_index: this.output.indexOf(this.reasoningItem),
        item: snapshotResponseItem(addedItem),
      });
    }
    if (this.emitReasoningSummary && this.reasoningText) {
      this.appendReasoningSummaryDelta(events, { final: true });
    }
    if (this.reasoningSummaryAdded) {
      for (const [summaryIndex, part] of this.reasoningItem.summary.entries()) {
        events.push({
          type: 'response.reasoning_summary_text.done',
          sequence_number: this.nextSequence(),
          output_index: this.output.indexOf(this.reasoningItem),
          item_id: this.reasoningItem.id,
          summary_index: summaryIndex,
          text: part.text,
        });
        events.push({
          type: 'response.reasoning_summary_part.done',
          sequence_number: this.nextSequence(),
          output_index: this.output.indexOf(this.reasoningItem),
          item_id: this.reasoningItem.id,
          summary_index: summaryIndex,
          part: snapshotResponsePart(part),
        });
      }
    }
    if (this.reasoningContentAdded) {
      events.push({
        type: 'response.reasoning_text.done',
        sequence_number: this.nextSequence(),
        output_index: this.output.indexOf(this.reasoningItem),
        item_id: this.reasoningItem.id,
        content_index: 0,
        text: this.reasoningText,
      });
      events.push({
        type: 'response.content_part.done',
        sequence_number: this.nextSequence(),
        output_index: this.output.indexOf(this.reasoningItem),
        content_index: 0,
        item_id: this.reasoningItem.id,
        part: snapshotResponsePart(this.reasoningItem.content[0]),
      });
    }
    events.push({
      type: 'response.output_item.done',
      sequence_number: this.nextSequence(),
      output_index: this.output.indexOf(this.reasoningItem),
      item: snapshotResponseItem(this.reasoningItem),
    });
    return events;
  }

  streamFailed(message) {
    if (this.finalized) return [];
    this.finalized = true;
    this.terminalStatus = 'failed';
    this.completedAt = Date.now() / 1000;
    const response = this.response('failed');
    response.error = { code: 'upstream_error', message: String(message || 'upstream stream failed') };
    return [{
      type: 'response.failed',
      sequence_number: this.nextSequence(),
      response,
    }];
  }

  mapChatEvent(event) {
    if (!event) return [];
    if (event.done) {
      if (this.pendingFinishReason || !event.eof) {
        return this.finalize(this.pendingFinishReason || 'stop', this.pendingUsage);
      }
      return this.streamFailed('upstream stream ended before completion');
    }
    let payload = event.data;
    if (typeof payload === 'string') {
      const parsed = safeJsonParse(payload);
      if (!parsed.ok) return [];
      payload = parsed.value;
    }
    if (!isObject(payload)) return [];
    if (isObject(payload.usage)) this.pendingUsage = payload.usage;
    const choice = Array.isArray(payload.choices) ? payload.choices[0] : null;
    if (!choice) return [];
    const delta = choice.delta || choice.message || {};
    const events = [];
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
      events.push(...this.reasoningDelta(delta.reasoning_content));
    }
    if (typeof delta.content === 'string' && delta.content) {
      events.push(...this.textDelta(delta.content));
    } else if (Array.isArray(delta.content)) {
      const text = toText(delta.content);
      if (text) events.push(...this.textDelta(text));
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const [position, toolCall] of delta.tool_calls.entries()) {
        events.push(...this.functionDelta({ ...toolCall, index: toolCall.index ?? position }));
      }
    }
    if (choice.finish_reason) {
      this.pendingFinishReason = choice.finish_reason;
    }
    return events;
  }
}

export function serializeResponsesSseEvent(event) {
  if (!event) return '';
  if (event.done) return 'data: [DONE]\n\n';
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}
