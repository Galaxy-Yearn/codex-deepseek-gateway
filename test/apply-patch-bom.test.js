import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  APPLY_PATCH_BOM_COMPAT_CALL_PREFIX,
  applyPatchBomCompatibilityCall,
  applyPatchBomCompatibilityResult,
} from '../src/apply-patch-bridge.js';
import { applyLeadingUtf8BomEdits } from '../src/apply-patch-bom.js';

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

function bomBuffer(text) {
  return Buffer.concat([BOM, Buffer.from(text, 'utf8')]);
}

function tools() {
  return [
    {
      type: 'function',
      gateway_custom_tool: true,
      gateway_custom_tool_input: 'apply_patch',
      function: { name: 'apply_patch', parameters: { type: 'object' } },
    },
    {
      type: 'function',
      function: { name: 'shell_command', parameters: { type: 'object' } },
    },
  ];
}

function failedMessages(edits) {
  return [
    {
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: 'call_patch',
        type: 'function',
        function: { name: 'apply_patch', arguments: JSON.stringify({ edits }) },
      }],
    },
    {
      role: 'tool',
      tool_call_id: 'call_patch',
      content: 'apply_patch verification failed: Failed to find expected lines in example.md:\n# Title',
    },
  ];
}

test('apply_patch BOM compatibility call is failure-driven and single-use', () => {
  const edits = [{ type: 'replace_text', file: 'example.md', old: '# Title', new: '# Updated' }];
  const call = applyPatchBomCompatibilityCall({
    messages: failedMessages(edits),
    tools: tools(),
    scriptPath: 'C:\\gateway\\apply-patch-bom.js',
  });
  assert.ok(call);
  assert.equal(call.sourceCallId, 'call_patch');
  assert.equal(call.toolCall.function.name, 'shell_command');
  assert.match(call.toolCall.id, new RegExp(`^${APPLY_PATCH_BOM_COMPAT_CALL_PREFIX}`));
  const args = JSON.parse(call.toolCall.function.arguments);
  assert.match(args.command, /^node 'C:\\gateway\\apply-patch-bom\.js' '[A-Za-z0-9+/=]+'$/);

  const replayed = [
    ...failedMessages(edits),
    { role: 'assistant', content: '', tool_calls: [call.toolCall] },
    { role: 'tool', tool_call_id: call.toolCall.id, content: 'compatibility result' },
  ];
  assert.equal(applyPatchBomCompatibilityCall({ messages: replayed, tools: tools(), scriptPath: 'script.js' }), null);
  assert.equal(applyPatchBomCompatibilityCall({ messages: failedMessages(edits), tools: tools().slice(0, 1), scriptPath: 'script.js' }), null);
  assert.equal(applyPatchBomCompatibilityCall({
    messages: [...failedMessages(edits), { role: 'user', content: 'new turn' }],
    tools: tools(),
    scriptPath: 'script.js',
  }), null);
  const unrelated = failedMessages(edits);
  unrelated[1].content = 'apply_patch verification failed: invalid patch';
  assert.equal(applyPatchBomCompatibilityCall({ messages: unrelated, tools: tools(), scriptPath: 'script.js' }), null);
});

test('leading UTF-8 BOM compatibility applies exact unique first-line edits and preserves encoding', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsgw-bom-'));
  try {
    const file = join(directory, 'example.md');
    writeFileSync(file, bomBuffer('# Title\r\n\r\nBody\r\n'));
    const result = applyLeadingUtf8BomEdits({
      version: 1,
      edits: [
        { type: 'replace_text', file, old: '# Title', new: '# Updated' },
        { type: 'insert_text_after', file, anchor: 'Body', content: 'Tail' },
      ],
    });
    assert.deepEqual(result, { ok: true, category: 'applied', file });
    const output = readFileSync(file);
    assert.equal(output.subarray(0, 3).equals(BOM), true);
    assert.equal(output.subarray(3).toString('utf8'), '# Updated\r\n\r\nBody\r\nTail\r\n');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('generated BOM compatibility command runs through the platform shell', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsgw-bom-command-'));
  try {
    const file = join(directory, 'example.md');
    writeFileSync(file, bomBuffer('# Title\nBody\n'));
    const compatibility = applyPatchBomCompatibilityCall({
      messages: failedMessages([{ type: 'replace_text', file: 'example.md', old: '# Title', new: '# Updated' }]),
      tools: tools(),
      scriptPath: fileURLToPath(new URL('../src/apply-patch-bom.js', import.meta.url)),
    });
    const command = JSON.parse(compatibility.toolCall.function.arguments).command;
    const invocation = process.platform === 'win32'
      ? ['powershell.exe', ['-NoProfile', '-Command', command]]
      : ['/bin/sh', ['-c', command]];
    const result = spawnSync(invocation[0], invocation[1], { cwd: directory, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Applied UTF-8 BOM compatibility patch/);
    assert.equal(readFileSync(file).subarray(3).toString('utf8'), '# Updated\nBody\n');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('leading UTF-8 BOM compatibility safely rejects unrelated or ambiguous mismatches', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsgw-bom-'));
  try {
    const plain = join(directory, 'plain.md');
    writeFileSync(plain, '# Title\nBody\n');
    const plainBefore = readFileSync(plain);
    const noBom = applyLeadingUtf8BomEdits({
      version: 1,
      edits: [{ type: 'replace_text', file: plain, old: '# Title', new: '# Updated' }],
    });
    assert.equal(noBom.category, 'not_utf8_bom');
    assert.equal(readFileSync(plain).equals(plainBefore), true);

    const later = join(directory, 'later.md');
    writeFileSync(later, bomBuffer('# Title\nBody\n'));
    const laterBefore = readFileSync(later);
    const nonFirst = applyLeadingUtf8BomEdits({
      version: 1,
      edits: [{ type: 'replace_text', file: later, old: 'Body', new: 'Changed' }],
    });
    assert.equal(nonFirst.category, 'not_first_line');
    assert.equal(readFileSync(later).equals(laterBefore), true);

    const duplicate = join(directory, 'duplicate.md');
    writeFileSync(duplicate, bomBuffer('# Title\nBody\n# Title\n'));
    const duplicateBefore = readFileSync(duplicate);
    const ambiguous = applyLeadingUtf8BomEdits({
      version: 1,
      edits: [{ type: 'replace_text', file: duplicate, old: '# Title', new: '# Updated' }],
    });
    assert.equal(ambiguous.category, 'ambiguous_match');
    assert.equal(readFileSync(duplicate).equals(duplicateBefore), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('leading UTF-8 BOM compatibility diagnoses content before mixed line-ending safety', () => {
  const mixed = bomBuffer('# Title\r\n\r\nBody\nTail\n');
  const mismatched = applyLeadingUtf8BomEdits({
    version: 1,
    edits: [{ type: 'replace_text', file: 'example.md', old: 'Body\nMissing', new: 'Changed' }],
  }, { readFile: () => mixed, writeFile: () => assert.fail('must not write') });
  assert.equal(mismatched.category, 'content_mismatch');

  const later = applyLeadingUtf8BomEdits({
    version: 1,
    edits: [{ type: 'replace_text', file: 'example.md', old: 'Body\nTail', new: 'Changed' }],
  }, { readFile: () => mixed, writeFile: () => assert.fail('must not write') });
  assert.equal(later.category, 'not_first_line');

  const firstLine = applyLeadingUtf8BomEdits({
    version: 1,
    edits: [{ type: 'replace_text', file: 'example.md', old: '# Title', new: '# Updated' }],
  }, { readFile: () => mixed, writeFile: () => assert.fail('must not write') });
  assert.equal(firstLine.category, 'unsupported_line_endings');
});

test('apply_patch BOM compatibility result reports bounded outcomes', () => {
  assert.deepEqual(applyPatchBomCompatibilityResult([
    { role: 'tool', tool_call_id: `${APPLY_PATCH_BOM_COMPAT_CALL_PREFIX}ok`, content: 'Applied UTF-8 BOM compatibility patch to a.md.' },
  ]), { callId: `${APPLY_PATCH_BOM_COMPAT_CALL_PREFIX}ok`, outcome: 'applied', applied: true });
  assert.deepEqual(applyPatchBomCompatibilityResult([
    { role: 'tool', tool_call_id: `${APPLY_PATCH_BOM_COMPAT_CALL_PREFIX}no`, content: 'Exit code: 2\nUTF-8 BOM compatibility not applied (content_mismatch): exact text was not found.' },
  ]), { callId: `${APPLY_PATCH_BOM_COMPAT_CALL_PREFIX}no`, outcome: 'content_mismatch', applied: false });
  assert.equal(applyPatchBomCompatibilityResult([
    { role: 'tool', tool_call_id: 'call_other', content: 'done' },
  ]), null);
});

test('leading UTF-8 BOM compatibility supports exact first-line hunks and detects file changes', () => {
  const original = bomBuffer('# Title\nBody\n');
  const changed = bomBuffer('# Changed elsewhere\nBody\n');
  let reads = 0;
  let wrote = false;
  const result = applyLeadingUtf8BomEdits({
    version: 1,
    edits: [{
      type: 'update_hunk',
      file: 'example.md',
      chunks: [{
        lines: [
          { op: 'delete', text: '# Title' },
          { op: 'add', text: '# Updated' },
          { op: 'context', text: 'Body' },
        ],
      }],
    }],
  }, {
    cwd: 'C:\\workspace',
    readFile() {
      reads += 1;
      return reads === 1 ? original : changed;
    },
    writeFile() {
      wrote = true;
    },
  });
  assert.equal(result.category, 'file_changed');
  assert.equal(wrote, false);
});
