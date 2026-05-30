import { generateId, isObject, normalizeRole, toText } from './common.js';
import { deepseekReasoningPayload, resolveModelAlias } from './model-map.js';

const TEXT_PART_TYPES = new Set(['input_text', 'output_text', 'text']);
const INPUT_CONTENT_PART_TYPES = new Set(['input_text', 'input_image', 'input_file', 'input_audio']);
const TOOL_CALL_TYPES = new Set([
  'function_call',
  'custom_tool_call',
  'local_shell_call',
  'computer_call',
  'mcp_call',
  'web_search_call',
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
  'file_search_call_output',
  'code_interpreter_call_output',
  'image_generation_call_output',
]);
const CHAT_HISTORY_IGNORED_TOOL_ITEM_TYPES = new Set(['web_search_call', 'web_search_call_output']);

function jsonString(value) {
  if (typeof value === 'string') return value;
  return JSON.stringify(value ?? {});
}

function sanitizeFunctionName(name, fallback = 'tool_call') {
  const candidate = String(name || fallback)
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/^_+/, '')
    .slice(0, 64);
  return candidate || fallback;
}

function omitUndefined(value) {
  if (!isObject(value)) return value;
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (child !== undefined) result[key] = child;
  }
  return result;
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
  return sanitizeFunctionName(
    item.name ||
      item.tool_name ||
      item.toolName ||
      item.server_label ||
      String(item.type || 'tool_call').replace(/_call$/, ''),
  );
}

function toolArguments(item) {
  if (item.type === 'function_call') return jsonString(item.arguments ?? {});
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

function reasoningTextFromItem(item) {
  if (!isObject(item)) return '';
  const parts = [];
  if (typeof item.reasoning_content === 'string') parts.push(item.reasoning_content);
  if (typeof item.text === 'string') parts.push(item.text);
  if (typeof item.content === 'string') parts.push(item.content);
  if (Array.isArray(item.content)) {
    for (const part of item.content) {
      if (typeof part === 'string') {
        parts.push(part);
        continue;
      }
      if (!isObject(part)) continue;
      if (part.type === 'reasoning_text' || part.type === 'text' || part.type === 'output_text') {
        parts.push(String(part.text ?? part.content ?? ''));
      }
    }
  }
  if (Array.isArray(item.summary)) {
    for (const part of item.summary) {
      if (typeof part === 'string') {
        parts.push(part);
        continue;
      }
      if (!isObject(part)) continue;
      if (part.type === 'summary_text' || part.type === 'text') {
        parts.push(String(part.text ?? part.content ?? ''));
      }
    }
  }
  return parts.filter(Boolean).join('');
}

function toolOutputContent(item) {
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

function extractMessagesFromResponsesInput(input) {
  if (Array.isArray(input)) {
    const messages = [];
    let pendingUserContent = [];
    let pendingReasoningContent = '';
    let pendingAssistantToolMessage = null;
    const flushPendingUserContent = () => {
      if (!pendingUserContent.length) return;
      messages.push({ role: 'user', content: contentToChatContent(pendingUserContent) });
      pendingUserContent = [];
    };
    const flushPendingAssistantToolMessage = () => {
      if (!pendingAssistantToolMessage) return;
      messages.push(pendingAssistantToolMessage);
      pendingAssistantToolMessage = null;
      pendingReasoningContent = '';
    };
    const ensurePendingAssistantToolMessage = () => {
      if (!pendingAssistantToolMessage) {
        pendingAssistantToolMessage = {
          role: 'assistant',
          content: '',
          tool_calls: [],
        };
        if (pendingReasoningContent) {
          pendingAssistantToolMessage.reasoning_content = pendingReasoningContent;
        }
      }
      return pendingAssistantToolMessage;
    };

    for (const item of input) {
      if (typeof item === 'string') {
        flushPendingAssistantToolMessage();
        pendingUserContent.push({ type: 'input_text', text: item });
        continue;
      }
      if (!isObject(item)) continue;
      if (isInputContentPart(item)) {
        flushPendingAssistantToolMessage();
        pendingUserContent.push(item);
        continue;
      }
      if (item.type === 'reasoning') {
        pendingReasoningContent += reasoningTextFromItem(item);
        continue;
      }
      if (item.type === 'message' && item.role) {
        flushPendingUserContent();
        flushPendingAssistantToolMessage();
        const normalized = normalizeMessage(item);
        if (normalized?.role === 'assistant' && !normalized.reasoning_content && pendingReasoningContent) {
          normalized.reasoning_content = pendingReasoningContent;
          pendingReasoningContent = '';
        }
        if (normalized) messages.push(normalized);
        continue;
      }
      if (CHAT_HISTORY_IGNORED_TOOL_ITEM_TYPES.has(item.type)) {
        flushPendingUserContent();
        flushPendingAssistantToolMessage();
        continue;
      }
      if (TOOL_OUTPUT_TYPES.has(item.type) || String(item.type || '').endsWith('_call_output')) {
        flushPendingUserContent();
        flushPendingAssistantToolMessage();
        messages.push(responseToolOutputToMessage(item));
        continue;
      }
      if (TOOL_CALL_TYPES.has(item.type) || String(item.type || '').endsWith('_call')) {
        flushPendingUserContent();
        ensurePendingAssistantToolMessage().tool_calls.push(chatToolCallFromResponseItem(item));
        continue;
      }
      if (item.role) {
        flushPendingUserContent();
        flushPendingAssistantToolMessage();
        const normalized = normalizeMessage(item);
        if (normalized?.role === 'assistant' && !normalized.reasoning_content && pendingReasoningContent) {
          normalized.reasoning_content = pendingReasoningContent;
          pendingReasoningContent = '';
        }
        if (normalized) messages.push(normalized);
      }
    }
    flushPendingUserContent();
    flushPendingAssistantToolMessage();
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

function normalizeTool(tool) {
  if (!isObject(tool)) return tool;
  if (tool.type === 'function' && isObject(tool.function)) {
    return {
      ...tool,
      function: {
        ...tool.function,
        name: sanitizeFunctionName(tool.function.name),
        parameters: normalizeJsonSchemaObject(tool.function.parameters),
      },
    };
  }
  if (tool.type === 'function' || tool.type === 'custom' || tool.name || tool.parameters || tool.input_schema) {
    return {
      type: 'function',
      function: omitUndefined({
        name: sanitizeFunctionName(tool.name || tool.type),
        description: tool.description,
        parameters: normalizeJsonSchemaObject(tool.parameters || tool.input_schema),
        strict: tool.strict,
      }),
    };
  }
  if (typeof tool.type === 'string') {
    return {
      type: 'function',
      function: omitUndefined({
        name: sanitizeFunctionName(tool.name || tool.type),
        description: tool.description || `Gateway shim for Responses tool type ${tool.type}.`,
        parameters: normalizeJsonSchemaObject(tool.parameters || tool.input_schema),
        strict: tool.strict,
      }),
    };
  }
  return null;
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
  if (!isObject(toolChoice)) return toolChoice;
  if (toolChoice.type === 'function' && toolChoice.name) {
    return {
      type: 'function',
      function: { name: sanitizeFunctionName(toolChoice.name) },
    };
  }
  if (toolChoice.type === 'function' && isObject(toolChoice.function)) {
    return {
      ...toolChoice,
      function: {
        ...toolChoice.function,
        name: sanitizeFunctionName(toolChoice.function.name),
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
        name: sanitizeFunctionName(
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

function buildToolSchemas(tools) {
  const schemas = new Map();
  if (!Array.isArray(tools)) return schemas;
  for (const tool of tools) {
    const normalizedTool = normalizeTool(tool);
    const fn = normalizedTool?.type === 'function' ? normalizedTool.function : null;
    if (!fn?.name) continue;
    schemas.set(fn.name, normalizeJsonSchemaObject(fn.parameters));
  }
  return schemas;
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
  item.arguments = normalizeToolCallArguments(item.name, item.arguments, toolSchemas?.get(item.name));
}

function sanitizeMessageForChatCompletion(message, provider = 'generic') {
  if (!isObject(message)) return message;
  const sanitized = {
    role: normalizeRole(message.role, provider),
    content: contentToChatContent(message.content),
  };
  if (message.name !== undefined) sanitized.name = message.name;
  if (Array.isArray(message.tool_calls)) sanitized.tool_calls = message.tool_calls;
  if (message.tool_call_id !== undefined) sanitized.tool_call_id = message.tool_call_id;
  if (provider === 'deepseek' && message.role === 'assistant' && typeof message.reasoning_content === 'string') {
    sanitized.reasoning_content = message.reasoning_content;
  }
  return sanitized;
}

function patchDeepSeekThinkingHistory(messages, request) {
  if (request.thinking?.type !== 'enabled' && !request.reasoning_effort) return messages;
  return messages.map((message) => {
    if (message?.role !== 'assistant') return message;
    if (typeof message.reasoning_content === 'string') return message;
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

function normalizeReasoningSummaryText(text) {
  const value = String(text ?? '').replace(/\r\n?/g, '\n');
  if (!value) return '';
  const plain = value
    .split('\n')
    .map((line) => line
      .replace(/^[ \t]{0,3}(?:`{3,}|~{3,}).*$/, '')
      .replace(/^[ \t]{0,3}#{1,6}[ \t]+/, '')
      .replace(/^[ \t]{0,3}>[ \t]?/, '')
      .replace(/^[ \t]*[-*+][ \t]+(?:\[[ xX]\][ \t]+)?/, '\u2022 ')
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

function reasoningSummaryText(text) {
  const summary = normalizeReasoningSummaryText(text);
  return summary ? `**Reasoning**\n\n${summary}` : '';
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
  return {
    model,
    messages,
    instructions,
    temperature: request.temperature,
    top_p: request.top_p,
    max_tokens: request.max_output_tokens ?? request.max_tokens,
    stop: request.stop,
    stream: Boolean(request.stream),
    tools: request.tools,
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
    previous_response_id: request.previous_response_id,
    store: request.store,
    include: request.include,
    conversation: request.conversation,
  };
}

export function toChatCompletionsRequest(normalized, overrides = {}) {
  const messages = [];
  if (normalized.instructions) {
    messages.push({ role: 'system', content: normalized.instructions });
  }
  messages.push(...normalized.messages);
  const tools = Array.isArray(normalized.tools) ? normalized.tools.map(normalizeTool).filter(Boolean) : undefined;
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
  const functionItems = Array.isArray(output) ? output.filter((item) => item.type === 'function_call') : [];
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
  const toolCalls = functionItems.map((item) => ({
    id: item.call_id || item.id,
    type: 'function',
    function: {
      name: item.name,
      arguments: item.arguments || '',
    },
  }));
  if (toolCalls.length) assistant.tool_calls = toolCalls;
  const reasoningContent = reasoningItems
    .map((item) => item.content || [])
    .flat()
    .filter((part) => part.type === 'reasoning_text')
    .map((part) => part.text)
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

export function toProviderChatCompletionsRequest(chatRequest, config = {}) {
  const provider = config.upstreamProvider || 'generic';
  const modelAlias = resolveModelAlias(chatRequest.model, config);
  const fallbackReasoning = !chatRequest.reasoning && config.codexReasoningEffort
    ? { effort: config.codexReasoningEffort }
    : chatRequest.reasoning;
  const messages = Array.isArray(chatRequest.messages)
    ? chatRequest.messages.map((message) => sanitizeMessageForChatCompletion(message, provider))
    : [];
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
    if (request.user !== undefined) {
      request.user_id = request.user;
      delete request.user;
    }
    if (request.stream) {
      request.stream_options = { include_usage: true };
    } else {
      delete request.stream_options;
    }
    if (request.response_format?.type === 'json_schema') {
      request.response_format = { type: 'json_object' };
    }
    Object.assign(request, deepseekReasoningPayload({ alias: modelAlias, reasoning: fallbackReasoning }));
    request.messages = patchDeepSeekThinkingHistory(request.messages, request);
  }

  Object.assign(request, modelAlias.extraBody);

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
}) {
  return {
    id,
    object: 'response',
    created_at: Math.floor(createdAt),
    completed_at: completedAt == null ? null : Math.floor(completedAt),
    status,
    background: false,
    error: null,
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

function normalizeResponsesUsage(usage) {
  if (!isObject(usage)) return null;
  const inputTokens = usage.input_tokens ?? usage.prompt_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? usage.completion_tokens ?? 0;
  return {
    input_tokens: inputTokens,
    input_tokens_details: usage.input_tokens_details ?? {
      cached_tokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
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
  });
}

export function convertChatCompletionToResponses({ completion, model, previousResponseId, normalized, responseId = generateId('resp') }) {
  const createdAt = completion.created || Date.now() / 1000;
  const choice = Array.isArray(completion.choices) ? completion.choices[0] : null;
  const message = choice?.message || {};
  const content = chatContentToResponseOutputParts(message.content);
  const toolSchemas = buildToolSchemas(normalized?.tools);
  const output = [];

  if (content.length || message.tool_calls?.length) {
    output.push({
      type: 'message',
      id: generateId('msg'),
      role: 'assistant',
      content,
      status: 'completed',
      phase: message.phase || 'final_answer',
    });
  }

  if (Array.isArray(message.tool_calls)) {
    for (const toolCall of message.tool_calls) {
      const callId = toolCall.id || generateId('call');
      const item = {
        type: 'function_call',
        id: callId,
        call_id: callId,
        name: toolCall.function?.name,
        arguments: toolCall.function?.arguments || '',
        status: 'completed',
      };
      normalizeFunctionCallItemArguments(item, toolSchemas);
      output.push(item);
    }
  }

  if (message.reasoning_content) {
    const reasoningText = String(message.reasoning_content);
    output.unshift({
      type: 'reasoning',
      id: generateId('rs'),
      summary: [normalizeSummaryTextPart(reasoningSummaryText(reasoningText))],
      content: [normalizeReasoningTextPart(reasoningText)],
      encrypted_content: null,
      status: 'completed',
    });
  }

  return createBaseResponse({
    id: responseId,
    model,
    createdAt,
    status: choice?.finish_reason === 'length' ? 'incomplete' : 'completed',
    output,
    previousResponseId: previousResponseId ?? null,
    usage: normalizeResponsesUsage(completion.usage),
    normalized,
    completedAt: Date.now() / 1000,
    incompleteReason: choice?.finish_reason === 'length' ? 'max_output_tokens' : null,
  });
}

export class ResponsesStreamMapper {
  constructor({
    responseId = generateId('resp'),
    model,
    createdAt = Date.now() / 1000,
    previousResponseId = null,
    normalized,
    bufferOutputUntilDone = false,
    emitReasoningSummary = true,
    emitReasoningText = false,
  } = {}) {
    this.responseId = responseId;
    this.model = model;
    this.createdAt = createdAt;
    this.previousResponseId = previousResponseId;
    this.normalized = normalized;
    this.bufferOutputUntilDone = Boolean(bufferOutputUntilDone);
    this.emitReasoningSummary = Boolean(emitReasoningSummary);
    this.emitReasoningText = Boolean(emitReasoningText);
    this.sequenceNumber = 0;
    this.output = [];
    this.messageItem = null;
    this.reasoningItem = null;
    this.toolItems = new Map();
    this.text = '';
    this.reasoningText = '';
    this.streamReasoningLive = true;
    this.reasoningItemDone = false;
    this.finishReason = null;
    this.usage = null;
    this.completedAt = null;
    this.finalized = false;
    this.messageContentAdded = false;
    this.reasoningContentAdded = false;
    this.reasoningSummaryAdded = false;
    this.reasoningItemAdded = false;
    this.streamedReasoningSummaryText = '';
    this.toolSchemas = buildToolSchemas(normalized?.tools);
  }

  nextSequence() {
    this.sequenceNumber += 1;
    return this.sequenceNumber;
  }

  response(status = 'in_progress') {
    return createBaseResponse({
      id: this.responseId,
      model: this.model,
      createdAt: this.createdAt,
      status,
      output: this.output,
      previousResponseId: this.previousResponseId,
      usage: this.usage,
      normalized: this.normalized,
      completedAt: this.completedAt,
      incompleteReason: this.finishReason === 'length' ? 'max_output_tokens' : null,
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
      response: this.response('in_progress'),
    };
  }

  ensureMessageItem() {
    if (!this.messageItem) {
      this.messageItem = {
        id: generateId('msg'),
        type: 'message',
        status: 'in_progress',
        role: 'assistant',
        phase: 'final_answer',
        content: [],
      };
      this.output.push(this.messageItem);
      return {
        type: 'response.output_item.added',
        sequence_number: this.nextSequence(),
        output_index: this.output.length - 1,
        item: snapshotResponseItem(this.messageItem),
      };
    }
    return null;
  }

  ensureReasoningItem() {
    if (!this.reasoningItem) {
      this.reasoningItem = {
        id: generateId('rs'),
        type: 'reasoning',
        status: 'in_progress',
        summary: [],
        content: [normalizeReasoningTextPart('')],
        encrypted_content: null,
      };
      this.output.push(this.reasoningItem);
    }
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

  ensureReasoningContentPart(events) {
    if (!this.emitReasoningText || this.reasoningContentAdded || !this.reasoningItem) return;
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

  appendReasoningSummaryDelta(events) {
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
    const nextSummaryText = reasoningSummaryText(this.reasoningText);
    this.reasoningItem.summary[0].text = nextSummaryText;
    if (!nextSummaryText.startsWith(this.streamedReasoningSummaryText)) {
      this.streamedReasoningSummaryText = nextSummaryText;
      return;
    }
    const deltaText = nextSummaryText.slice(this.streamedReasoningSummaryText.length);
    this.streamedReasoningSummaryText = nextSummaryText;
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

  textDelta(delta) {
    if (this.bufferOutputUntilDone) {
      if (!this.messageItem) {
        this.messageItem = {
          id: generateId('msg'),
          type: 'message',
          status: 'in_progress',
          role: 'assistant',
          phase: 'final_answer',
          content: [normalizeOutputTextPart('')],
        };
        this.output.push(this.messageItem);
      }
      this.text += delta;
      this.messageItem.content[0].text = this.text;
      return [];
    }
    const events = [];
    if (this.streamReasoningLive) {
      events.push(...this.closeReasoningItem('completed'));
    }
    this.streamReasoningLive = false;
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
    if (this.bufferOutputUntilDone) {
      const events = [];
      const added = this.ensureReasoningItem();
      if (added) events.push(added);
      this.reasoningItem.content[0].text = this.reasoningText;
      this.appendReasoningSummaryDelta(events);
      return events;
    }
    if (!this.streamReasoningLive) {
      if (!this.reasoningItem) {
        this.reasoningItem = {
          id: generateId('rs'),
          type: 'reasoning',
          status: 'in_progress',
          summary: [],
          content: [normalizeReasoningTextPart('')],
          encrypted_content: null,
        };
        this.output.push(this.reasoningItem);
      }
      this.reasoningItem.content[0].text = this.reasoningText;
      return [];
    }

    const events = [];
    const added = this.ensureReasoningItem();
    if (added) events.push(added);
    this.ensureReasoningContentPart(events);
    this.reasoningItem.content[0].text = this.reasoningText;
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

  functionDelta(toolCall) {
    if (this.bufferOutputUntilDone) {
      const index = toolCall.index ?? 0;
      let item = this.toolItems.get(index);
      if (!item) {
        const callId = toolCall.id || generateId('call');
        item = {
          id: callId,
          type: 'function_call',
          status: 'in_progress',
          call_id: callId,
          name: toolCall.function?.name || '',
          arguments: '',
        };
        this.toolItems.set(index, item);
        this.output.push(item);
      }
      if (toolCall.function?.name) item.name = toolCall.function.name;
      item.arguments += toolCall.function?.arguments || '';
      return [];
    }
    const events = [];
    if (this.streamReasoningLive) {
      events.push(...this.closeReasoningItem('completed'));
    }
    this.streamReasoningLive = false;
    const index = toolCall.index ?? 0;
    let item = this.toolItems.get(index);
    if (!item) {
      const callId = toolCall.id || generateId('call');
      item = {
        id: callId,
        type: 'function_call',
        status: 'in_progress',
        call_id: callId,
        name: toolCall.function?.name || '',
        arguments: '',
      };
      this.toolItems.set(index, item);
      this.output.push(item);
      events.push({
        type: 'response.output_item.added',
        sequence_number: this.nextSequence(),
        output_index: this.output.length - 1,
        item: snapshotResponseItem(item),
      });
    }
    if (toolCall.function?.name) item.name = toolCall.function.name;
    const delta = toolCall.function?.arguments || '';
    item.arguments += delta;
    if (delta) {
      events.push({
        type: 'response.function_call_arguments.delta',
        sequence_number: this.nextSequence(),
        output_index: this.output.indexOf(item),
        item_id: item.id,
        delta,
      });
    }
    return events;
  }

  finalize(finishReason = 'stop', usage = null) {
    if (this.finalized) return [];
    this.finalized = true;
    const status = finishReason === 'length' ? 'incomplete' : 'completed';

    if (this.bufferOutputUntilDone) {
      this.finishReason = finishReason;
      this.usage = normalizeResponsesUsage(usage);
      this.completedAt = Date.now() / 1000;

      if (this.reasoningItem) {
        this.reasoningItem.status = status;
        this.reasoningItem.content[0].text = this.reasoningText;
      }
      if (this.messageItem) {
        this.messageItem.status = status;
        if (!this.messageItem.content.length) {
          this.messageItem.content.push(normalizeOutputTextPart(''));
        }
        this.messageItem.content[0].text = this.text;
      }

      const events = [];
      if (this.reasoningItem && this.bufferOutputUntilDone) {
        events.push(...this.flushBufferedReasoning(status));
      }
      events.push(...this.closeReasoningItem(status));

      if (this.messageItem) {
        const outputIndex = this.output.indexOf(this.messageItem);
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
        events.push({
          type: 'response.output_text.done',
          sequence_number: this.nextSequence(),
          output_index: outputIndex,
          content_index: 0,
          item_id: this.messageItem.id,
          text: this.text,
          logprobs: [],
        });
        events.push({
          type: 'response.content_part.done',
          sequence_number: this.nextSequence(),
          output_index: outputIndex,
          content_index: 0,
          item_id: this.messageItem.id,
          part: snapshotResponsePart(this.messageItem.content[0]),
        });
        events.push({
          type: 'response.output_item.done',
          sequence_number: this.nextSequence(),
          output_index: outputIndex,
          item: snapshotResponseItem(this.messageItem),
        });
      }

      for (const item of this.toolItems.values()) {
        item.status = status;
        item.arguments = normalizeToolCallArguments(item.name, item.arguments, this.toolSchemas.get(item.name));
        const outputIndex = this.output.indexOf(item);
        events.push({
          type: 'response.output_item.added',
          sequence_number: this.nextSequence(),
          output_index: outputIndex,
          item: snapshotResponseItem({
            ...item,
            status: 'in_progress',
            arguments: '',
          }),
        });
        if (item.arguments) {
          events.push({
            type: 'response.function_call_arguments.delta',
            sequence_number: this.nextSequence(),
            output_index: outputIndex,
            item_id: item.id,
            delta: item.arguments,
          });
        }
        events.push({
          type: 'response.function_call_arguments.done',
          sequence_number: this.nextSequence(),
          output_index: outputIndex,
          item_id: item.id,
          arguments: item.arguments,
        });
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
        output: this.output,
        previousResponseId: this.previousResponseId,
        usage: normalizeResponsesUsage(usage),
        normalized: this.normalized,
        completedAt: Date.now() / 1000,
        incompleteReason: finishReason === 'length' ? 'max_output_tokens' : null,
      });
      events.push({
        type: status === 'incomplete' ? 'response.incomplete' : 'response.completed',
        sequence_number: this.nextSequence(),
        response,
      });
      return events;
    }

    const events = [];
    this.finishReason = finishReason;
    this.usage = normalizeResponsesUsage(usage);
    this.completedAt = Date.now() / 1000;
    if (this.reasoningItem) {
      this.reasoningItem.status = finishReason === 'length' ? 'incomplete' : 'completed';
      if (this.emitReasoningSummary && this.reasoningText && !this.reasoningSummaryAdded) {
        this.reasoningSummaryAdded = true;
        this.reasoningItem.summary.push(normalizeSummaryTextPart(reasoningSummaryText(this.reasoningText)));
      }
      this.reasoningItem.content[0].text = this.reasoningText;
      if (this.reasoningItem.summary[0]) {
        this.reasoningItem.summary[0].text = reasoningSummaryText(this.reasoningText);
      }
    }
    if (this.messageItem) {
      this.messageItem.status = finishReason === 'length' ? 'incomplete' : 'completed';
      this.messageItem.content[0].text = this.text;
      if (!this.messageContentAdded) {
        this.messageContentAdded = true;
        events.push({
          type: 'response.content_part.added',
          sequence_number: this.nextSequence(),
          output_index: this.output.indexOf(this.messageItem),
          content_index: 0,
          item_id: this.messageItem.id,
          part: snapshotResponsePart(this.messageItem.content[0]),
        });
      }
      events.push({
        type: 'response.output_text.done',
        sequence_number: this.nextSequence(),
        output_index: this.output.indexOf(this.messageItem),
        content_index: 0,
        item_id: this.messageItem.id,
        text: this.text,
        logprobs: [],
      });
      events.push({
        type: 'response.content_part.done',
        sequence_number: this.nextSequence(),
        output_index: this.output.indexOf(this.messageItem),
        content_index: 0,
        item_id: this.messageItem.id,
        part: snapshotResponsePart(this.messageItem.content[0]),
      });
      events.push({
        type: 'response.output_item.done',
        sequence_number: this.nextSequence(),
        output_index: this.output.indexOf(this.messageItem),
        item: snapshotResponseItem(this.messageItem),
      });
    }
    events.push(...this.closeReasoningItem(finishReason === 'length' ? 'incomplete' : 'completed'));
    for (const item of this.toolItems.values()) {
      item.status = finishReason === 'length' ? 'incomplete' : 'completed';
      normalizeFunctionCallItemArguments(item, this.toolSchemas);
      events.push({
        type: 'response.function_call_arguments.done',
        sequence_number: this.nextSequence(),
        output_index: this.output.indexOf(item),
        item_id: item.id,
        arguments: item.arguments,
      });
      events.push({
        type: 'response.output_item.done',
        sequence_number: this.nextSequence(),
        output_index: this.output.indexOf(item),
        item: snapshotResponseItem(item),
      });
    }
    const response = createBaseResponse({
      id: this.responseId,
      model: this.model,
      createdAt: this.createdAt,
      status,
      output: this.output,
      previousResponseId: this.previousResponseId,
      usage: normalizeResponsesUsage(usage),
      normalized: this.normalized,
      completedAt: Date.now() / 1000,
      incompleteReason: finishReason === 'length' ? 'max_output_tokens' : null,
    });
    events.push({
      type: status === 'incomplete' ? 'response.incomplete' : 'response.completed',
      sequence_number: this.nextSequence(),
      response,
    });
    return events;
  }

  assistantMessage() {
    return assistantMessageFromResponseOutput(this.output);
  }

  flushBufferedReasoning(status = 'completed') {
    if (!this.reasoningItem || this.reasoningItemDone) return [];
    const events = [];
    const outputIndex = this.output.indexOf(this.reasoningItem);
    const summaryText = reasoningSummaryText(this.reasoningText);
    if (!this.reasoningItemAdded) {
      this.reasoningItemAdded = true;
      events.push({
        type: 'response.output_item.added',
        sequence_number: this.nextSequence(),
        output_index: outputIndex,
        item: snapshotResponseItem({
          ...this.reasoningItem,
          status: 'in_progress',
          summary: [],
          content: [normalizeReasoningTextPart('')],
        }),
      });
    }
    if (this.emitReasoningText) {
      this.reasoningContentAdded = true;
      events.push({
        type: 'response.content_part.added',
        sequence_number: this.nextSequence(),
        output_index: outputIndex,
        content_index: 0,
        item_id: this.reasoningItem.id,
        part: snapshotResponsePart(normalizeReasoningTextPart('')),
      });
      if (this.reasoningText) {
        for (const delta of splitBufferedReasoningDeltas(this.reasoningText)) {
          events.push({
            type: 'response.reasoning_text.delta',
            sequence_number: this.nextSequence(),
            output_index: outputIndex,
            item_id: this.reasoningItem.id,
            content_index: 0,
            delta,
          });
        }
      }
    }
    if (this.emitReasoningSummary && !this.reasoningSummaryAdded) {
      this.reasoningSummaryAdded = true;
      this.reasoningItem.summary = [normalizeSummaryTextPart(summaryText)];
      events.push({
        type: 'response.reasoning_summary_part.added',
        sequence_number: this.nextSequence(),
        output_index: outputIndex,
        item_id: this.reasoningItem.id,
        summary_index: 0,
        part: snapshotResponsePart(normalizeSummaryTextPart('')),
      });
      for (const delta of splitBufferedReasoningDeltas(summaryText)) {
        events.push({
          type: 'response.reasoning_summary_text.delta',
          sequence_number: this.nextSequence(),
          output_index: outputIndex,
          item_id: this.reasoningItem.id,
          summary_index: 0,
          delta,
        });
      }
      this.streamedReasoningSummaryText = summaryText;
    } else if (this.emitReasoningSummary && this.reasoningItem.summary[0]) {
      this.reasoningItem.summary[0].text = summaryText;
    }
    this.reasoningItem.status = status;
    this.reasoningItem.content[0].text = this.reasoningText;
    return events;
  }

  closeReasoningItem(status = 'completed') {
    if (!this.reasoningItem || this.reasoningItemDone) return [];
    this.reasoningItemDone = true;
    this.reasoningItem.status = status;
    this.reasoningItem.content[0].text = this.reasoningText;
    const summaryText = reasoningSummaryText(this.reasoningText);
    if (this.emitReasoningSummary && this.reasoningText && !this.reasoningSummaryAdded) {
      this.reasoningSummaryAdded = true;
      this.reasoningItem.summary.push(normalizeSummaryTextPart(summaryText));
    }
    const events = [];
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

  mapChatEvent(event) {
    if (!event) return [];
    if (event.done) return this.finalize(this.finishReason || 'stop', this.usage);
    const payload = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
    if (!isObject(payload)) return [];
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
      events.push(...this.finalize(choice.finish_reason, payload.usage ?? null));
    }
    return events;
  }
}

export function serializeResponsesSseEvent(event) {
  if (!event) return '';
  if (event.done) return 'data: [DONE]\n\n';
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}
