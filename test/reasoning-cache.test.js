import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ReasoningCache } from '../src/reasoning-cache.js';

const assistantToolCallMessage = {
  role: 'assistant',
  content: '',
  reasoning_content: 'raw thinking',
  tool_calls: [
    {
      id: 'call_1',
      type: 'function',
      function: { name: 'lookup', arguments: '{"query":"codex"}' },
    },
  ],
};

test('appends reasoning records to one file and restores them after restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gateway-reasoning-cache-'));
  const persistPath = join(dir, 'reasoning-cache.jsonl');
  try {
    const first = new ReasoningCache({ persistPath });
    assert.equal(first.rememberAssistantMessage(assistantToolCallMessage), true);
    const firstBytes = (await stat(persistPath)).size;

    first.rememberAssistantMessage({
      ...assistantToolCallMessage,
      reasoning_content: 'later thinking',
      tool_calls: [{ ...assistantToolCallMessage.tool_calls[0], id: 'call_2' }],
    });

    const raw = await readFile(persistPath, 'utf8');
    assert.equal(raw.trim().split('\n').length, 2);
    assert.ok((await stat(persistPath)).size > firstBytes);
    assert.equal(existsSync(`${persistPath}.journal`), false);

    const second = new ReasoningCache({ persistPath });
    assert.equal(second.getAssistantMessageForToolCall('call_1').reasoning_content, 'raw thinking');
    assert.equal(second.getAssistantMessageForToolCall('call_2').reasoning_content, 'later thinking');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('does not append an unchanged reasoning record', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gateway-reasoning-cache-unchanged-'));
  const persistPath = join(dir, 'reasoning-cache.jsonl');
  try {
    const cache = new ReasoningCache({ persistPath });
    cache.rememberAssistantMessage(assistantToolCallMessage);
    const raw = await readFile(persistPath, 'utf8');
    assert.equal(cache.rememberAssistantMessage(assistantToolCallMessage), false);
    assert.equal(await readFile(persistPath, 'utf8'), raw);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('stores one record for parallel tool calls and resolves every call id', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gateway-reasoning-cache-parallel-'));
  const persistPath = join(dir, 'reasoning-cache.jsonl');
  try {
    const message = {
      ...assistantToolCallMessage,
      tool_calls: [
        { ...assistantToolCallMessage.tool_calls[0], id: 'call_p1' },
        { ...assistantToolCallMessage.tool_calls[0], id: 'call_p2' },
      ],
    };
    const cache = new ReasoningCache({ persistPath });
    cache.rememberAssistantMessage(message);

    const record = JSON.parse((await readFile(persistPath, 'utf8')).trim());
    assert.deepEqual(record.callIds, ['call_p1', 'call_p2']);
    assert.equal(record.message.reasoning_content, 'raw thinking');

    const reloaded = new ReasoningCache({ persistPath });
    assert.equal(reloaded.getAssistantMessageForToolCall('call_p1').tool_calls.length, 2);
    assert.equal(reloaded.getAssistantMessageForToolCall('call_p2').tool_calls.length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('keeps the call-id cache bounded across restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gateway-reasoning-cache-bounded-'));
  const persistPath = join(dir, 'reasoning-cache.jsonl');
  try {
    const cache = new ReasoningCache({ persistPath, maxMessages: 1 });
    cache.rememberAssistantMessage(assistantToolCallMessage);
    cache.rememberAssistantMessage({
      ...assistantToolCallMessage,
      tool_calls: [{ ...assistantToolCallMessage.tool_calls[0], id: 'call_2' }],
    });
    assert.equal(cache.getAssistantMessageForToolCall('call_1'), null);
    assert.equal(cache.getAssistantMessageForToolCall('call_2').reasoning_content, 'raw thinking');

    const reloaded = new ReasoningCache({ persistPath, maxMessages: 1 });
    assert.equal(reloaded.getAssistantMessageForToolCall('call_1'), null);
    assert.equal(reloaded.getAssistantMessageForToolCall('call_2').reasoning_content, 'raw thinking');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('isolates returned messages from caller mutations', () => {
  const cache = new ReasoningCache();
  cache.rememberAssistantMessage(assistantToolCallMessage);

  const first = cache.getAssistantMessageForToolCall('call_1');
  first.reasoning_content = 'tampered';
  first.tool_calls[0].function.arguments = '{}';

  const second = cache.getAssistantMessageForToolCall('call_1');
  assert.equal(second.reasoning_content, 'raw thinking');
  assert.equal(second.tool_calls[0].function.arguments, '{"query":"codex"}');
});

test('enforces the UTF-8 byte limit for one oversized reasoning record', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gateway-reasoning-cache-bytes-'));
  const persistPath = join(dir, 'reasoning-cache.jsonl');
  try {
    const cache = new ReasoningCache({ persistPath, maxBytes: 700 });
    cache.rememberAssistantMessage({
      ...assistantToolCallMessage,
      reasoning_content: '界'.repeat(300),
    });

    assert.equal(cache.getAssistantMessageForToolCall('call_1'), null);
    const bytes = existsSync(persistPath) ? (await stat(persistPath)).size : 0;
    assert.ok(bytes <= 700);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('migrates the reasoning cache from the previous sessions snapshot and journal', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gateway-reasoning-cache-migrate-'));
  const persistPath = join(dir, 'reasoning-cache.jsonl');
  const legacyPath = join(dir, 'sessions.json');
  const journalPath = `${legacyPath}.journal`;
  try {
    await writeFile(legacyPath, JSON.stringify({
      version: 4,
      sessions: [],
      conversations: [],
      assistantMessages: [assistantToolCallMessage],
      toolCallMessages: [['call_1', 0]],
    }));
    await writeFile(journalPath, `${JSON.stringify({
      version: 1,
      assistantMessages: [{
        ...assistantToolCallMessage,
        reasoning_content: 'journal thinking',
        tool_calls: [{ ...assistantToolCallMessage.tool_calls[0], id: 'call_2' }],
      }],
    })}\n`);

    const cache = new ReasoningCache({ persistPath, legacyPath });
    assert.equal(cache.getAssistantMessageForToolCall('call_1').reasoning_content, 'raw thinking');
    assert.equal(cache.getAssistantMessageForToolCall('call_2').reasoning_content, 'journal thinking');
    assert.equal(existsSync(persistPath), true);
    assert.equal(existsSync(legacyPath), false);
    assert.equal(existsSync(journalPath), false);

    const reloaded = new ReasoningCache({ persistPath, legacyPath });
    assert.equal(reloaded.getAssistantMessageForToolCall('call_2').reasoning_content, 'journal thinking');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
