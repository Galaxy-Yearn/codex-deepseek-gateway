import assert from 'node:assert/strict';
import test from 'node:test';

async function scenario(name, run) {
  try {
    await run();
  } catch (error) {
    error.message = `${name}: ${error.message}`;
    throw error;
  }
}
import {
  generateId,
  hasPseudoToolCallMarkup,
  isCodexContextualUserText,
  isObject,
  joinUrl,
  neutralizePseudoToolCallMarkup,
  normalizeRole,
  parseBoolean,
  parseJsonObject,
  parseList,
  safeJsonParse,
  SSE_PARSER_MAX_BUFFER_BYTES,
  SseParser,
  toText,
} from '../src/common.js';

const encoder = new TextEncoder();

test('sse parser framing and buffer limits', async () => {
  await scenario('parses multiple frames across chunk boundaries', async () => {
    const parser = new SseParser();
    const first = parser.push(encoder.encode('data: {"a":1}\n\nevent: ping\r\ndata: {"b":'));
    assert.deepEqual(first, [{ event: 'message', data: '{"a":1}' }]);
    const second = parser.push(encoder.encode('2}\r\n\r\ndata: [DONE]\n\n'));
    assert.deepEqual(second, [
      { event: 'ping', data: '{"b":2}' },
      { done: true },
    ]);
    assert.equal(parser.buffer, '');
  });

  await scenario('flushes a trailing frame on end', async () => {
    const parser = new SseParser();
    assert.deepEqual(parser.push(encoder.encode('data: tail')), []);
    assert.deepEqual(parser.end(), [{ event: 'message', data: 'tail' }]);
  });

  await scenario('defaults to the exported max buffer size', async () => {
    const parser = new SseParser();
    assert.equal(parser.maxBufferBytes, SSE_PARSER_MAX_BUFFER_BYTES);
    assert.equal(SSE_PARSER_MAX_BUFFER_BYTES, 16 * 1024 * 1024);
    assert.equal(new SseParser({ maxBufferBytes: 0 }).maxBufferBytes, SSE_PARSER_MAX_BUFFER_BYTES);
    assert.equal(new SseParser({ maxBufferBytes: 64 }).maxBufferBytes, 64);
  });

  await scenario('throws sse_buffer_overflow when unbounded data exceeds the limit', async () => {
    const parser = new SseParser({ maxBufferBytes: 32 });
    assert.deepEqual(parser.push(encoder.encode('data: 0123456789')), []);
    assert.throws(
      () => parser.push(encoder.encode('0123456789012345678901234567890')),
      (error) => error instanceof Error
        && error.code === 'sse_buffer_overflow'
        && error.message.includes('32'),
    );
    assert.equal(parser.buffer, '');
    assert.deepEqual(parser.push(encoder.encode('data: next\n\n')), [{ event: 'message', data: 'next' }]);
  });

  await scenario('throws sse_buffer_overflow from end when the flushed tail exceeds the limit', async () => {
    const parser = new SseParser({ maxBufferBytes: 8 });
    assert.deepEqual(parser.push(new Uint8Array([...encoder.encode('data: 12'), 0xe2])), []);
    assert.throws(
      () => parser.end(),
      (error) => error.code === 'sse_buffer_overflow',
    );
    assert.equal(parser.buffer, '');
  });

  await scenario('parses a large frame that fits exactly within the limit', async () => {
    const payload = 'x'.repeat(58);
    const frame = `data: ${payload}\n\n`;
    assert.equal(frame.length, 66);
    const parser = new SseParser({ maxBufferBytes: 66 });
    assert.deepEqual(parser.push(encoder.encode(frame)), [{ event: 'message', data: payload }]);
    assert.equal(parser.buffer, '');
  });

  await scenario('parses a large frame delivered in chunks while under the limit', async () => {
    const payload = 'y'.repeat(100);
    const parser = new SseParser({ maxBufferBytes: 120 });
    assert.deepEqual(parser.push(encoder.encode('data: ')), []);
    assert.deepEqual(parser.push(encoder.encode(payload)), []);
    assert.deepEqual(parser.push(encoder.encode('\n\n')), [{ event: 'message', data: payload }]);
  });
});

test('shared normalization and parsing contracts', () => {
  assert.equal(isCodexContextualUserText('# AGENTS.md instructions\n<INSTRUCTIONS>rules</INSTRUCTIONS>'), true);
  assert.equal(isCodexContextualUserText('<environment_context>ctx</environment_context>\n<turn_aborted>stop</turn_aborted>'), true);
  assert.equal(isCodexContextualUserText('<external_policy>ctx</external_policy>'), true);
  assert.equal(isCodexContextualUserText('<hook_prompt hook_run_id="run-1">ctx</hook_prompt>'), true);
  assert.equal(isCodexContextualUserText('<codex_internal_context source="runtime">ctx</codex_internal_context>'), true);
  assert.equal(isCodexContextualUserText('<goal_context>ctx</goal_context>'), true);
  assert.equal(isCodexContextualUserText('Warning: The maximum number of unified exec processes you can keep open is 4.'), true);
  assert.equal(isCodexContextualUserText('Warning: apply_patch was requested via exec_command. Use the apply_patch tool instead of exec_command.'), true);
  assert.equal(isCodexContextualUserText('Warning: Your account was flagged for potentially high-risk cyber activity.'), true);
  assert.equal(isCodexContextualUserText('<external_policy>unterminated'), false);
  assert.equal(isCodexContextualUserText('<environment_context>ctx</environment_context>\nreal request'), false);
  assert.equal(isObject({}), true);
  assert.equal(isObject([]), false);
  assert.match(generateId('call'), /^call_[0-9a-f]{32}$/);
  assert.equal(normalizeRole('developer', 'deepseek'), 'system');
  assert.equal(normalizeRole('', 'deepseek'), 'user');
  assert.equal(toText([
    { type: 'input_text', text: 'one' },
    { type: 'message', content: [{ type: 'output_text', text: 'two' }] },
    { type: 'input_image', image_url: 'ignored' },
  ]), 'onetwo');
  assert.equal(toText({ type: 'message', content: { type: 'text', content: 'nested' } }), 'nested');
  assert.equal(toText({ text: 'fallback text' }), 'fallback text');
  assert.equal(toText({ type: 'input_image', image_url: 'ignored' }), '');

  const pseudo = '<|DSML|tool_calls><|DSML|invoke name="lookup">';
  assert.equal(hasPseudoToolCallMarkup(pseudo), true);
  assert.equal(hasPseudoToolCallMarkup('{"tool_calls":[]}'), true);
  assert.equal(hasPseudoToolCallMarkup('ordinary answer'), false);
  assert.equal(hasPseudoToolCallMarkup(neutralizePseudoToolCallMarkup(pseudo)), false);

  assert.equal(parseBoolean('YES'), true);
  assert.equal(parseBoolean('off', true), false);
  assert.equal(parseBoolean('unknown', true), true);
  assert.deepEqual(parseList('a, b, ,c'), ['a', 'b', 'c']);
  assert.deepEqual(parseList([' a ', '', 'b']), ['a', 'b']);
  assert.equal(joinUrl('https://api.example.com/', '/v1/models'), 'https://api.example.com/v1/models');
  assert.equal(joinUrl('https://api.example.com', 'v1/models'), 'https://api.example.com/v1/models');

  assert.deepEqual(safeJsonParse('{"ok":true}'), { ok: true, value: { ok: true } });
  assert.equal(safeJsonParse('{').ok, false);
  assert.deepEqual(parseJsonObject({ ok: true }), { ok: true });
  assert.deepEqual(parseJsonObject('{"ok":true}'), { ok: true });
  assert.deepEqual(parseJsonObject('[]'), {});
  assert.throws(() => parseJsonObject('[]', { source: 'payload', throwOnInvalid: true }), /payload must be a JSON object/);
});
