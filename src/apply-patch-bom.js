import { readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const ALLOWED_EDIT_TYPES = new Set(['replace_text', 'delete_text', 'insert_text_before', 'insert_text_after', 'update_hunk']);

function fail(category, message) {
  const error = new Error(message);
  error.category = category;
  throw error;
}

function textLines(value, blankForEmpty = false) {
  if (typeof value !== 'string') fail('invalid_payload', 'edit text must be a string');
  const normalized = value.replace(/\r\n/g, '\n');
  if (normalized.includes('\r')) fail('unsupported_line_endings', 'edit text contains unsupported carriage returns');
  if (!normalized && blankForEmpty) return [''];
  const lines = normalized.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

function sequenceAt(lines, expected, index) {
  if (index < 0 || index + expected.length > lines.length) return false;
  return expected.every((line, offset) => lines[index + offset] === line);
}

function uniqueSequenceIndex(lines, expected, start = 0) {
  if (!expected.length) fail('unsupported_edit', 'an exact existing line sequence is required');
  let found = -1;
  for (let index = Math.max(0, start); index <= lines.length - expected.length; index += 1) {
    if (!sequenceAt(lines, expected, index)) continue;
    if (found >= 0) fail('ambiguous_match', 'the exact existing line sequence is not unique');
    found = index;
  }
  if (found < 0) fail('content_mismatch', 'the exact existing line sequence was not found');
  return found;
}

function uniqueLineIndex(lines, expected) {
  return uniqueSequenceIndex(lines, [expected]);
}

function applyUpdateHunk(lines, edit, state) {
  if (edit.move_to !== undefined) fail('unsupported_edit', 'move-and-edit is not supported by BOM compatibility');
  if (!Array.isArray(edit.chunks) || !edit.chunks.length) fail('invalid_payload', 'update_hunk requires chunks');
  for (const chunk of edit.chunks) {
    if (!chunk || !Array.isArray(chunk.lines) || !chunk.lines.length) fail('invalid_payload', 'update_hunk chunk requires lines');
    let start = 0;
    if (chunk.anchor !== undefined) {
      if (typeof chunk.anchor !== 'string' || chunk.anchor.includes('\n') || chunk.anchor.includes('\r')) {
        fail('invalid_payload', 'update_hunk anchor must be one line');
      }
      const anchorIndex = uniqueLineIndex(lines, chunk.anchor);
      if (anchorIndex === 0) state.firstLineMatched = true;
      start = anchorIndex + 1;
    }
    const oldLines = [];
    const newLines = [];
    for (const line of chunk.lines) {
      if (!line || typeof line.text !== 'string' || line.text.includes('\n') || line.text.includes('\r')) {
        fail('invalid_payload', 'update_hunk line text must be one line');
      }
      if (line.op === 'context') {
        oldLines.push(line.text);
        newLines.push(line.text);
      } else if (line.op === 'delete') {
        oldLines.push(line.text);
      } else if (line.op === 'add') {
        newLines.push(line.text);
      } else {
        fail('invalid_payload', 'update_hunk line op is invalid');
      }
    }
    const index = uniqueSequenceIndex(lines, oldLines, start);
    if (chunk.eof === true && index + oldLines.length !== lines.length) {
      fail('content_mismatch', 'the end-of-file hunk does not match the current file end');
    }
    if (index === 0) state.firstLineMatched = true;
    lines.splice(index, oldLines.length, ...newLines);
  }
}

function applyEdit(lines, edit, state) {
  if (!edit || !ALLOWED_EDIT_TYPES.has(edit.type)) fail('unsupported_edit', 'the failed patch contains unsupported edits');
  if (edit.type === 'update_hunk') {
    applyUpdateHunk(lines, edit, state);
    return;
  }
  if (edit.type === 'insert_text_before' || edit.type === 'insert_text_after') {
    if (typeof edit.anchor !== 'string' || edit.anchor.includes('\n') || edit.anchor.includes('\r')) {
      fail('invalid_payload', 'insert anchor must be one line');
    }
    const index = uniqueLineIndex(lines, edit.anchor);
    if (index === 0) state.firstLineMatched = true;
    const content = textLines(edit.content, true);
    lines.splice(edit.type === 'insert_text_before' ? index : index + 1, 0, ...content);
    return;
  }
  const oldLines = textLines(edit.old);
  const index = uniqueSequenceIndex(lines, oldLines);
  if (index === 0) state.firstLineMatched = true;
  const replacement = edit.type === 'delete_text' ? [] : textLines(edit.new, true);
  lines.splice(index, oldLines.length, ...replacement);
}

function decodedBomFile(raw) {
  if (!Buffer.isBuffer(raw) || raw.length < UTF8_BOM.length || !raw.subarray(0, UTF8_BOM.length).equals(UTF8_BOM)) {
    fail('not_utf8_bom', 'the target file does not begin with a UTF-8 BOM');
  }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(raw.subarray(UTF8_BOM.length));
  } catch {
    fail('invalid_utf8', 'the target file is not valid UTF-8');
  }
  const hasCrlf = text.includes('\r\n');
  const hasBareLf = /(^|[^\r])\n/.test(text);
  if (/\r(?!\n)/.test(text)) {
    fail('unsupported_line_endings', 'the target file has mixed or unsupported line endings');
  }
  const mixedLineEndings = hasCrlf && hasBareLf;
  const eol = hasCrlf && !hasBareLf ? '\r\n' : '\n';
  const normalized = hasCrlf ? text.replace(/\r\n/g, '\n') : text;
  const finalNewline = normalized.endsWith('\n');
  const lines = normalized.split('\n');
  if (finalNewline) lines.pop();
  return { lines, eol, finalNewline, mixedLineEndings };
}

function targetFile(payload, cwd) {
  if (!payload || payload.version !== 1 || !Array.isArray(payload.edits) || !payload.edits.length) {
    fail('invalid_payload', 'compatibility payload is invalid');
  }
  const files = [...new Set(payload.edits.map((edit) => typeof edit?.file === 'string' ? edit.file.trim() : ''))];
  if (files.length !== 1 || !files[0] || /[\r\n]/.test(files[0])) {
    fail('unsupported_edit', 'BOM compatibility requires edits for exactly one file');
  }
  return {
    display: files[0],
    path: isAbsolute(files[0]) ? files[0] : resolve(cwd, files[0]),
  };
}

export function applyLeadingUtf8BomEdits(payload, { cwd = process.cwd(), readFile = readFileSync, writeFile = writeFileSync } = {}) {
  try {
    const file = targetFile(payload, cwd);
    const original = readFile(file.path);
    const decoded = decodedBomFile(original);
    const lines = [...decoded.lines];
    const state = { firstLineMatched: false };
    for (const edit of payload.edits) applyEdit(lines, edit, state);
    if (!state.firstLineMatched) fail('not_first_line', 'the failed patch does not match the first file line');
    if (decoded.mixedLineEndings) fail('unsupported_line_endings', 'the target file has mixed or unsupported line endings');
    const normalized = `${lines.join('\n')}${decoded.finalNewline ? '\n' : ''}`;
    const body = decoded.eol === '\r\n' ? normalized.replace(/\n/g, '\r\n') : normalized;
    const output = Buffer.concat([UTF8_BOM, Buffer.from(body, 'utf8')]);
    if (output.equals(original)) fail('no_change', 'the compatibility patch would not change the file');
    const current = readFile(file.path);
    if (!Buffer.isBuffer(current) || !current.equals(original)) fail('file_changed', 'the target file changed before the compatibility write');
    writeFile(file.path, output);
    return { ok: true, category: 'applied', file: file.display };
  } catch (error) {
    return {
      ok: false,
      category: error?.category || 'write_failed',
      message: error?.message || 'the compatibility patch failed',
    };
  }
}

function decodePayload(value) {
  try {
    return JSON.parse(gunzipSync(Buffer.from(String(value || ''), 'base64')).toString('utf8'));
  } catch {
    return null;
  }
}

function runCli() {
  const result = applyLeadingUtf8BomEdits(decodePayload(process.argv[2]));
  if (result.ok) {
    process.stdout.write(`Applied UTF-8 BOM compatibility patch to ${result.file}.\n`);
    return;
  }
  process.stderr.write(`UTF-8 BOM compatibility not applied (${result.category}): ${result.message}.\n`);
  process.exitCode = 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runCli();
