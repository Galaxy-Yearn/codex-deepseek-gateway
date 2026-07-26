import { gzipSync } from 'node:zlib';
import { generateId, isObject, safeJsonParse } from './common.js';

function jsonString(value) {
  if (typeof value === 'string') return value;
  return JSON.stringify(value ?? {});
}

export const CUSTOM_TOOL_INPUT_MODE_APPLY_PATCH = 'apply_patch';
export const CUSTOM_TOOL_INPUT_MODE_APPLY_PATCH_ENVIRONMENT = 'apply_patch_environment';
const APPLY_PATCH_TRANSPORT_DESCRIPTION = 'Edit files by sending structured edits; the runtime applies them through native apply_patch.';
const APPLY_PATCH_EDITS_HINT = 'Structured file edits. Use high-level operations for ordinary edits; use update_hunk only when exact native chunks, EOF, or move-and-edit are needed. List edits touching the same file in top-to-bottom file order; an empty-string content or new inserts one blank line.';
const APPLY_PATCH_HUNK_LINE_SCHEMA = {
  type: 'object',
  properties: {
    op: {
      type: 'string',
      enum: ['context', 'add', 'delete'],
      description: 'Native update line kind.',
    },
    text: {
      type: 'string',
      description: 'Line text without the native prefix.',
    },
  },
  required: ['op', 'text'],
  additionalProperties: false,
};
const APPLY_PATCH_HUNK_CHUNK_SCHEMA = {
  type: 'object',
  properties: {
    anchor: {
      type: 'string',
      minLength: 1,
      description: 'Optional exact current line for the native @@ context.',
    },
    lines: {
      type: 'array',
      minItems: 1,
      description: 'Ordered native context/add/delete lines.',
      items: APPLY_PATCH_HUNK_LINE_SCHEMA,
    },
    eof: {
      type: 'boolean',
      description: 'Apply this chunk at end of file.',
    },
  },
  required: ['lines'],
  additionalProperties: false,
};
const APPLY_PATCH_EDIT_SCHEMA = {
  type: 'object',
  properties: {
    type: {
      type: 'string',
      enum: ['add_file', 'delete_file', 'replace_text', 'delete_text', 'append_text', 'insert_text_before', 'insert_text_after', 'update_hunk'],
      description: 'Edit operation.',
    },
    file: {
      type: 'string',
      minLength: 1,
      description: 'Target file path.',
    },
    move_to: {
      type: 'string',
      minLength: 1,
      description: 'Destination path for update_hunk move-and-edit.',
    },
    old: {
      type: 'string',
      minLength: 1,
      description: 'Exact current text for replace_text or delete_text.',
    },
    new: {
      type: 'string',
      description: 'Replacement text for replace_text.',
    },
    content: {
      type: 'string',
      description: 'Content for add_file, append_text, insert_text_before, or insert_text_after.',
    },
    anchor: {
      type: 'string',
      minLength: 1,
      description: 'One exact current line for insert_text_before or insert_text_after.',
    },
    chunks: {
      type: 'array',
      minItems: 1,
      description: 'Ordered native chunks for update_hunk.',
      items: APPLY_PATCH_HUNK_CHUNK_SCHEMA,
    },
  },
  required: ['type', 'file'],
  additionalProperties: false,
};
const APPLY_PATCH_EDIT_FIELDS = new Set(['type', 'file', 'move_to', 'old', 'new', 'content', 'anchor', 'chunks']);
const APPLY_PATCH_CHUNK_FIELDS = new Set(['anchor', 'lines', 'eof']);
const APPLY_PATCH_LINE_FIELDS = new Set(['op', 'text']);
const APPLY_PATCH_ARGUMENTS_ERROR = 'apply_patch arguments must be {"edits": [...]}; raw patch text is not accepted.';
const APPLY_PATCH_EDIT_DISALLOWED_FIELDS = {
  add_file: ['old', 'new', 'move_to', 'anchor', 'chunks'],
  delete_file: ['old', 'new', 'content', 'move_to', 'anchor', 'chunks'],
  append_text: ['old', 'new', 'move_to', 'anchor', 'chunks'],
  insert_text_before: ['old', 'new', 'move_to', 'chunks'],
  insert_text_after: ['old', 'new', 'move_to', 'chunks'],
  replace_text: ['content', 'move_to', 'chunks'],
  delete_text: ['new', 'content', 'move_to', 'chunks'],
  update_hunk: ['old', 'new', 'content', 'anchor'],
};
const APPLY_PATCH_ERROR_MAX_LINES = 5;
const APPLY_PATCH_ERROR_MAX_CHARS = 700;
const APPLY_PATCH_BOM_COMMAND_MAX_CHARS = 24000;
export const APPLY_PATCH_BOM_COMPAT_CALL_PREFIX = 'call_dsgw_bom_';

function applyPatchToolParameters(includeEnvironmentId = false) {
  const properties = {
    edits: {
      type: 'array',
      description: APPLY_PATCH_EDITS_HINT,
      minItems: 1,
      items: APPLY_PATCH_EDIT_SCHEMA,
    },
  };
  if (includeEnvironmentId) {
    properties.environment_id = {
      type: 'string',
      description: 'Codex environment id for this patch when the tool schema includes that field.',
    };
  }
  return {
    type: 'object',
    properties,
    required: ['edits'],
    additionalProperties: false,
  };
}

function applyPatchGrammarDefinition(tool) {
  const format = isObject(tool?.format) ? tool.format : {};
  return String(format.definition || '');
}

export function isApplyPatchGrammarTool(tool) {
  const format = isObject(tool?.format) ? tool.format : {};
  const definition = applyPatchGrammarDefinition(tool);
  return String(format.type || '').toLowerCase() === 'grammar'
    && String(format.syntax || '').toLowerCase() === 'lark'
    && /\bstart\s*:\s*begin_patch\s+(?:environment_id\?\s+)?hunk\+\s+end_patch\b/.test(definition)
    && /\bbegin_patch\b/.test(definition)
    && /\bend_patch\b/.test(definition);
}

function applyPatchGrammarSupportsEnvironmentId(tool) {
  const definition = applyPatchGrammarDefinition(tool);
  return /\bstart\s*:\s*begin_patch\s+environment_id\?\s+hunk\+\s+end_patch\b/.test(definition)
    && /\benvironment_id\b/.test(definition);
}

export function applyPatchCustomToolShim(tool, name) {
  const includeEnvironmentId = applyPatchGrammarSupportsEnvironmentId(tool);
  return {
    type: 'function',
    gateway_custom_tool: true,
    gateway_custom_tool_input: includeEnvironmentId
      ? CUSTOM_TOOL_INPUT_MODE_APPLY_PATCH_ENVIRONMENT
      : CUSTOM_TOOL_INPUT_MODE_APPLY_PATCH,
    function: {
      name,
      description: APPLY_PATCH_TRANSPORT_DESCRIPTION,
      parameters: applyPatchToolParameters(includeEnvironmentId),
    },
  };
}

function normalizedTextLines(value) {
  if (value === undefined || value === null) return [];
  const lines = String(value).replace(/\r\n?/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

function applyPatchPath(value) {
  if (typeof value !== 'string') return '';
  const path = value.trim();
  return path && !/[\r\n]/.test(path) ? path : '';
}

function applyPatchAnchor(value) {
  if (typeof value !== 'string') return '';
  const anchor = value.replace(/\r\n?/g, '\n');
  return anchor && !anchor.includes('\n') ? anchor : '';
}

function applyPatchLineText(value) {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\r\n?/g, '\n');
  return text.includes('\n') ? null : text;
}

function prefixedPatchLines(prefix, value) {
  return normalizedTextLines(value).map((line) => `${prefix}${line}`);
}

function hasApplyPatchField(edit, name) {
  return Object.prototype.hasOwnProperty.call(edit, name);
}

function additivePatchLines(prefix, value) {
  if (value === '') return [prefix];
  return prefixedPatchLines(prefix, value);
}

function applyPatchContentReason(edit) {
  if (edit.content === undefined) return '"content" is required';
  if (typeof edit.content !== 'string') return '"content" must be a string';
  return '';
}

function structuredApplyPatchLine(line) {
  if (!isObject(line)) return { error: 'each line must be an object with "op" and "text"' };
  const unknownField = Object.keys(line).find((key) => !APPLY_PATCH_LINE_FIELDS.has(key));
  if (unknownField !== undefined) return { error: `unknown field ${JSON.stringify(unknownField)}` };
  const op = String(line.op || '').trim().toLowerCase();
  const text = applyPatchLineText(line.text);
  if (text === null) return { error: '"text" must be one line of text' };
  if (op === 'context') return { line: ` ${text}` };
  if (op === 'add') return { line: `+${text}` };
  if (op === 'delete') return { line: `-${text}` };
  return { error: `unknown op ${JSON.stringify(String(line.op ?? ''))}` };
}

function structuredApplyPatchChunk(chunk) {
  if (!isObject(chunk)) return { error: 'each chunk must be an object with "lines"' };
  const unknownField = Object.keys(chunk).find((key) => !APPLY_PATCH_CHUNK_FIELDS.has(key));
  if (unknownField !== undefined) return { error: `unknown field ${JSON.stringify(unknownField)}` };
  const anchor = hasApplyPatchField(chunk, 'anchor') ? applyPatchAnchor(chunk.anchor) : '';
  if (hasApplyPatchField(chunk, 'anchor') && !anchor) return { error: '"anchor" must be one exact current line' };
  if (hasApplyPatchField(chunk, 'eof') && chunk.eof !== true && chunk.eof !== false) return { error: '"eof" must be true or false' };
  const sourceLines = Array.isArray(chunk.lines) ? chunk.lines : [];
  if (!sourceLines.length) return { error: '"lines" must be a non-empty array' };
  const lines = [anchor ? `@@ ${anchor}` : '@@'];
  for (const [lineIndex, line] of sourceLines.entries()) {
    const lowered = structuredApplyPatchLine(line);
    if (lowered.error) return { error: `lines[${lineIndex}]: ${lowered.error}` };
    lines.push(lowered.line);
  }
  if (chunk.eof === true) lines.push('*** End of File');
  return { lines, eof: chunk.eof === true };
}

function structuredApplyPatchOperation(edit, index) {
  if (!isObject(edit)) return { error: `edits[${index}]: each edit must be an object with "type" and "file"` };
  const type = String(edit.type || '').trim().toLowerCase();
  const disallowedFields = APPLY_PATCH_EDIT_DISALLOWED_FIELDS[type];
  if (!disallowedFields) return { error: `edits[${index}]: unknown type ${JSON.stringify(String(edit.type ?? ''))}` };
  const fail = (reason) => ({ error: `edits[${index}] ${type}: ${reason}` });
  const unknownField = Object.keys(edit).find((key) => !APPLY_PATCH_EDIT_FIELDS.has(key))
    ?? disallowedFields.find((name) => hasApplyPatchField(edit, name));
  if (unknownField !== undefined) return fail(`unknown field ${JSON.stringify(unknownField)}`);
  const file = applyPatchPath(edit.file);
  if (!file) return fail('"file" must be a non-empty single-line path');
  if (type === 'add_file') {
    const contentReason = applyPatchContentReason(edit);
    if (contentReason) return fail(contentReason);
    return { operation: { kind: 'add', file, lines: [`*** Add File: ${file}`, ...additivePatchLines('+', edit.content)] } };
  }
  if (type === 'delete_file') {
    return { operation: { kind: 'delete', file, lines: [`*** Delete File: ${file}`] } };
  }
  if (type === 'append_text') {
    const contentReason = applyPatchContentReason(edit);
    if (contentReason) return fail(contentReason);
    return { operation: { kind: 'update', file, eof: true, changeLines: ['@@', ...additivePatchLines('+', edit.content), '*** End of File'] } };
  }
  if (type === 'insert_text_before' || type === 'insert_text_after') {
    const anchor = applyPatchAnchor(edit.anchor);
    if (!anchor) return fail('"anchor" must be one exact existing line');
    const contentReason = applyPatchContentReason(edit);
    if (contentReason) return fail(contentReason);
    const content = additivePatchLines('+', edit.content);
    const changeLines = type === 'insert_text_before'
      ? ['@@', ...content, ` ${anchor}`]
      : ['@@', ` ${anchor}`, ...content];
    return { operation: { kind: 'update', file, changeLines } };
  }
  if (type === 'replace_text') {
    if (edit.old !== undefined && typeof edit.old !== 'string') return fail('"old" must be a string');
    const oldLines = prefixedPatchLines('-', edit.old);
    if (!oldLines.length) return fail('"old" must be non-empty exact current file text; to remove lines use delete_text with the exact lines');
    if (edit.new === undefined) return fail('"new" is required; to remove lines use delete_text');
    if (typeof edit.new !== 'string') return fail('"new" must be a string');
    return { operation: { kind: 'update', file, changeLines: ['@@', ...oldLines, ...additivePatchLines('+', edit.new)] } };
  }
  if (type === 'delete_text') {
    if (edit.old !== undefined && typeof edit.old !== 'string') return fail('"old" must be a string');
    const oldLines = prefixedPatchLines('-', edit.old);
    if (!oldLines.length) return fail('"old" must be non-empty exact current file text; delete_text removes exactly those lines');
    return { operation: { kind: 'update', file, changeLines: ['@@', ...oldLines] } };
  }
  const moveTo = hasApplyPatchField(edit, 'move_to') ? applyPatchPath(edit.move_to) : '';
  if (hasApplyPatchField(edit, 'move_to') && !moveTo) return fail('"move_to" must be a non-empty single-line path');
  const chunks = Array.isArray(edit.chunks) ? edit.chunks : [];
  if (!chunks.length) return fail('"chunks" must be a non-empty array');
  const changeLines = [];
  let eof = false;
  for (const [chunkIndex, chunk] of chunks.entries()) {
    if (eof) return fail(`chunks[${chunkIndex}]: no chunk can follow an "eof": true chunk`);
    const lowered = structuredApplyPatchChunk(chunk);
    if (lowered.error) return fail(`chunks[${chunkIndex}]: ${lowered.error}`);
    changeLines.push(...lowered.lines);
    eof = lowered.eof;
  }
  return { operation: { kind: 'update', file, moveTo, eof, changeLines } };
}

function boundedApplyPatchErrors(errors) {
  const lines = errors.slice(0, APPLY_PATCH_ERROR_MAX_LINES);
  if (errors.length > lines.length) lines.push(`and ${errors.length - lines.length} more invalid edits`);
  const text = lines.join('\n');
  if (text.length <= APPLY_PATCH_ERROR_MAX_CHARS) return text;
  return `${text.slice(0, APPLY_PATCH_ERROR_MAX_CHARS - 3)}...`;
}

function structuredApplyPatchLowering(edits, environmentId = '') {
  if (!Array.isArray(edits) || !edits.length) return { ok: false, error: APPLY_PATCH_ARGUMENTS_ERROR };
  const sections = new Map();
  const order = [];
  const errors = [];
  for (const [index, edit] of edits.entries()) {
    const result = structuredApplyPatchOperation(edit, index);
    if (result.error) {
      errors.push(result.error);
      continue;
    }
    const operation = result.operation;
    const section = sections.get(operation.file);
    if (!section) {
      sections.set(operation.file, {
        kind: operation.kind,
        file: operation.file,
        moveTo: operation.moveTo || '',
        eof: Boolean(operation.eof),
        lines: [...(operation.kind === 'update' ? operation.changeLines : operation.lines)],
      });
      order.push(operation.file);
      continue;
    }
    if (section.kind !== 'update' || operation.kind !== 'update') {
      errors.push(`edits[${index}]: add_file or delete_file for ${JSON.stringify(operation.file)} cannot be combined with another edit for the same file`);
      continue;
    }
    if (section.eof) {
      errors.push(`edits[${index}]: ${JSON.stringify(operation.file)} already has an end-of-file edit; no later edit can match after it`);
      continue;
    }
    if (operation.moveTo && section.moveTo && operation.moveTo !== section.moveTo) {
      errors.push(`edits[${index}]: conflicting move_to targets for ${JSON.stringify(operation.file)}`);
      continue;
    }
    if (operation.moveTo) section.moveTo = operation.moveTo;
    section.lines.push(...operation.changeLines);
    if (operation.eof) section.eof = true;
  }
  if (errors.length) return { ok: false, error: boundedApplyPatchErrors(errors) };
  const lines = ['*** Begin Patch'];
  const environment = applyPatchPath(environmentId);
  if (environment) lines.push(`*** Environment ID: ${environment}`);
  for (const file of order) {
    const section = sections.get(file);
    if (section.kind !== 'update') {
      lines.push(...section.lines);
      continue;
    }
    lines.push(`*** Update File: ${section.file}`);
    if (section.moveTo) lines.push(`*** Move to: ${section.moveTo}`);
    lines.push(...section.lines);
  }
  lines.push('*** End Patch');
  return { ok: true, input: lines.join('\n') };
}

export function applyPatchLoweringFromArguments(argumentsText, inputMode) {
  const parsed = safeJsonParse(typeof argumentsText === 'string' ? argumentsText : '');
  if (!parsed.ok || !isObject(parsed.value) || !Array.isArray(parsed.value.edits)) {
    return { ok: false, error: APPLY_PATCH_ARGUMENTS_ERROR };
  }
  const environmentId = inputMode === CUSTOM_TOOL_INPUT_MODE_APPLY_PATCH_ENVIRONMENT
    ? parsed.value.environment_id
    : '';
  return structuredApplyPatchLowering(parsed.value.edits, environmentId);
}

export function isApplyPatchInputMode(inputMode) {
  return inputMode === CUSTOM_TOOL_INPUT_MODE_APPLY_PATCH
    || inputMode === CUSTOM_TOOL_INPUT_MODE_APPLY_PATCH_ENVIRONMENT;
}

export function applyPatchReplayArguments(argumentsText, inputMode, nativeInput) {
  if (!isApplyPatchInputMode(inputMode) || !nativeInput) return '';
  const parsed = safeJsonParse(argumentsText);
  if (!parsed.ok || !isObject(parsed.value) || !Array.isArray(parsed.value.edits)) return '';
  const replay = { edits: parsed.value.edits };
  if (
    inputMode === CUSTOM_TOOL_INPUT_MODE_APPLY_PATCH_ENVIRONMENT
    && typeof parsed.value.environment_id === 'string'
    && parsed.value.environment_id.trim()
  ) {
    replay.environment_id = parsed.value.environment_id;
  }
  return jsonString(replay);
}

export function chatToolsIncludeApplyPatch(tools) {
  return (Array.isArray(tools) ? tools : []).some(
    (tool) => isObject(tool) && isApplyPatchInputMode(tool.gateway_custom_tool_input),
  );
}

function completionApplyPatchToolCalls(completion, modes) {
  if (!modes.size) return [];
  const choice = Array.isArray(completion?.choices) ? completion.choices[0] : null;
  const toolCalls = Array.isArray(choice?.message?.tool_calls) ? choice.message.tool_calls : [];
  return toolCalls.filter((toolCall) => modes.has(String(toolCall?.function?.name || '')));
}

export function applyPatchToolCallCount(completion, tools) {
  return completionApplyPatchToolCalls(completion, applyPatchModesByName(tools)).length;
}

export function invalidApplyPatchToolCalls(completion, tools) {
  const modes = applyPatchModesByName(tools);
  const invalid = [];
  for (const toolCall of completionApplyPatchToolCalls(completion, modes)) {
    const name = String(toolCall?.function?.name || '');
    const lowering = applyPatchLoweringFromArguments(toolCall.function?.arguments, modes.get(name));
    if (!lowering.ok) invalid.push({ id: toolCall.id || '', name, error: lowering.error });
  }
  return invalid;
}

export function applyPatchValidationErrorCategory(error) {
  const text = String(error || '');
  if (text.includes('arguments must be')) return 'arguments';
  if (text.includes('unknown type')) return 'edit_type';
  if (text.includes('unknown op')) return 'hunk_op';
  if (text.includes('unknown field')) return 'field';
  if (text.includes('cannot be combined') || text.includes('conflicting') || text.includes('no later edit')) return 'edit_order';
  return 'schema';
}

function applyPatchModesByName(tools) {
  const modes = new Map();
  for (const tool of Array.isArray(tools) ? tools : []) {
    if (!isObject(tool) || !isApplyPatchInputMode(tool.gateway_custom_tool_input)) continue;
    const name = isObject(tool.function) ? String(tool.function.name || '') : '';
    if (name) modes.set(name, tool.gateway_custom_tool_input);
  }
  return modes;
}

function shellCommandToolName(tools) {
  for (const tool of Array.isArray(tools) ? tools : []) {
    if (!isObject(tool) || tool.type !== 'function' || !isObject(tool.function)) continue;
    if (String(tool.function.name || '') === 'shell_command') return 'shell_command';
  }
  return '';
}

function nativeApplyPatchMatchFailure(value) {
  const text = String(value || '');
  return /apply_patch verification failed:\s*Failed to find (?:expected lines|context)\b/i.test(text);
}

function structuredApplyPatchPayload(argumentsText) {
  const parsed = safeJsonParse(typeof argumentsText === 'string' ? argumentsText : '');
  if (!parsed.ok || !isObject(parsed.value) || !Array.isArray(parsed.value.edits) || !parsed.value.edits.length) return null;
  return { version: 1, edits: parsed.value.edits };
}

function pendingBomCompatibility(messages, tools) {
  const modes = applyPatchModesByName(tools);
  if (!modes.size) return null;
  const calls = new Map();
  let candidate = null;
  for (const message of Array.isArray(messages) ? messages : []) {
    if (message?.role === 'user') {
      candidate = null;
      continue;
    }
    if (message?.role === 'assistant') {
      if (candidate) candidate = null;
      for (const toolCall of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
        const id = String(toolCall?.id || '');
        if (!id) continue;
        calls.set(id, toolCall);
        if (id.startsWith(APPLY_PATCH_BOM_COMPAT_CALL_PREFIX)) candidate = null;
      }
      continue;
    }
    if (message?.role !== 'tool') continue;
    const callId = String(message.tool_call_id || '');
    if (!callId) continue;
    if (callId.startsWith(APPLY_PATCH_BOM_COMPAT_CALL_PREFIX)) {
      candidate = null;
      continue;
    }
    const toolCall = calls.get(callId);
    const name = String(toolCall?.function?.name || '');
    if (!modes.has(name)) continue;
    candidate = null;
    if (!nativeApplyPatchMatchFailure(message.content)) continue;
    const payload = structuredApplyPatchPayload(toolCall.function?.arguments);
    if (payload) candidate = { sourceCallId: callId, payload };
  }
  return candidate;
}

export function applyPatchBomCompatibilityCall({ messages, tools, scriptPath } = {}) {
  const shellName = shellCommandToolName(tools);
  if (!shellName || typeof scriptPath !== 'string' || !scriptPath || scriptPath.includes("'")) return null;
  const pending = pendingBomCompatibility(messages, tools);
  if (!pending) return null;
  const encoded = gzipSync(Buffer.from(JSON.stringify(pending.payload), 'utf8')).toString('base64');
  const command = `node '${scriptPath}' '${encoded}'`;
  if (command.length > APPLY_PATCH_BOM_COMMAND_MAX_CHARS) return null;
  return {
    sourceCallId: pending.sourceCallId,
    encodedChars: encoded.length,
    toolCall: {
      id: generateId('call_dsgw_bom'),
      type: 'function',
      function: {
        name: shellName,
        arguments: JSON.stringify({ command }),
      },
    },
  };
}

export function applyPatchBomCompatibilityResult(messages = []) {
  const message = Array.isArray(messages) ? messages.at(-1) : null;
  const callId = String(message?.tool_call_id || '');
  if (message?.role !== 'tool' || !callId.startsWith(APPLY_PATCH_BOM_COMPAT_CALL_PREFIX)) return null;
  const content = String(message.content || '');
  if (/Applied UTF-8 BOM compatibility patch\b/i.test(content)) {
    return { callId, outcome: 'applied', applied: true };
  }
  const rejected = content.match(/UTF-8 BOM compatibility not applied \(([^)]+)\)/i);
  return { callId, outcome: rejected?.[1] || 'unknown', applied: false };
}
