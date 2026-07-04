import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SessionStore } from '../src/session-store.js';

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

test('persists session messages, conversation head, and tool-call index', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gateway-session-store-'));
  const persistPath = join(dir, 'sessions.json');
  try {
    const first = new SessionStore({ persistPath, maxSessions: 10 });
    first.set('resp_1', {
      id: 'resp_1',
      messages: [
        { role: 'user', content: 'look codex up' },
        assistantToolCallMessage,
      ],
    });
    first.setConversation('conv_1', 'resp_1');

    const second = new SessionStore({ persistPath, maxSessions: 10 });
    const session = second.get('resp_1');
    assert.equal(session.id, 'resp_1');
    assert.equal(session.messages.length, 2);
    assert.equal(second.getConversation('conv_1').id, 'resp_1');

    const assistantMessage = second.getAssistantMessageForToolCall('call_1');
    assert.equal(assistantMessage.reasoning_content, 'raw thinking');
    assert.equal(assistantMessage.tool_calls[0].function.arguments, '{"query":"codex"}');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('strips leading system messages so resumed requests do not double instructions', async () => {
  const store = new SessionStore({});
  store.set('resp_1', {
    id: 'resp_1',
    messages: [
      { role: 'system', content: 'instructions' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ],
  });
  assert.deepEqual(
    store.get('resp_1').messages.map((message) => message.role),
    ['user', 'assistant'],
  );
});

test('migrates version-1 per-turn history files into flat session messages', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gateway-session-migrate-'));
  const persistPath = join(dir, 'sessions.json');
  try {
    const legacyPayload = {
      version: 1,
      sessions: [
        [
          'resp_1',
          {
            id: 'resp_1',
            history: [
              {
                request: { model: 'deepseek-v4-pro' },
                chatRequest: { messages: [] },
                upstreamRequest: { messages: [] },
                historyMessages: [
                  { role: 'system', content: 'instructions' },
                  { role: 'user', content: 'look codex up' },
                  assistantToolCallMessage,
                ],
                assistantMessage: assistantToolCallMessage,
              },
            ],
          },
        ],
      ],
      conversations: [['conv_1', 'resp_1']],
    };
    await writeFile(persistPath, JSON.stringify(legacyPayload), 'utf8');

    const store = new SessionStore({ persistPath });
    const session = store.get('resp_1');
    assert.deepEqual(
      session.messages.map((message) => message.role),
      ['user', 'assistant'],
    );
    assert.equal(store.getConversation('conv_1').id, 'resp_1');
    assert.equal(store.getAssistantMessageForToolCall('call_1').reasoning_content, 'raw thinking');

    const reloaded = new SessionStore({ persistPath });
    assert.equal(reloaded.get('resp_1').messages.length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('prunes persisted sessions and removes dangling conversation heads', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gateway-session-prune-'));
  const persistPath = join(dir, 'sessions.json');
  try {
    const first = new SessionStore({ persistPath, maxSessions: 1 });
    first.set('resp_old', { id: 'resp_old', messages: [] });
    first.setConversation('conv_old', 'resp_old');
    first.set('resp_new', { id: 'resp_new', messages: [] });
    first.setConversation('conv_new', 'resp_new');

    const second = new SessionStore({ persistPath, maxSessions: 1 });
    assert.equal(second.get('resp_old'), null);
    assert.equal(second.getConversation('conv_old'), null);
    assert.equal(second.get('resp_new').id, 'resp_new');
    assert.equal(second.getConversation('conv_new').id, 'resp_new');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('keeps tool-call cache entries alive across session eviction and restarts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gateway-session-cache-'));
  const persistPath = join(dir, 'sessions.json');
  try {
    const first = new SessionStore({ persistPath, maxSessions: 1 });
    first.set('resp_1', {
      id: 'resp_1',
      messages: [{ role: 'user', content: 'look codex up' }, assistantToolCallMessage],
    });
    first.set('resp_2', { id: 'resp_2', messages: [{ role: 'user', content: 'unrelated turn' }] });

    assert.equal(first.get('resp_1'), null);
    assert.equal(first.getAssistantMessageForToolCall('call_1').reasoning_content, 'raw thinking');

    const second = new SessionStore({ persistPath, maxSessions: 1 });
    assert.equal(second.get('resp_1'), null);
    assert.equal(second.getAssistantMessageForToolCall('call_1').reasoning_content, 'raw thinking');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('rememberAssistantMessage persists the cache without storing a session', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gateway-session-remember-'));
  const persistPath = join(dir, 'sessions.json');
  try {
    const first = new SessionStore({ persistPath });
    assert.equal(first.rememberAssistantMessage({ role: 'assistant', content: 'plain answer' }), false);
    assert.equal(existsSync(persistPath), false);
    assert.equal(first.rememberAssistantMessage(assistantToolCallMessage), true);

    const raw = await readFile(persistPath, 'utf8');
    assert.match(raw, /\n {2}"version": 4,\n/);
    const payload = JSON.parse(raw);
    assert.deepEqual(payload.sessions, []);
    assert.equal(payload.assistantMessages.length, 1);
    assert.equal(payload.assistantMessages[0].reasoning_content, 'raw thinking');
    assert.deepEqual(payload.toolCallMessages, [['call_1', 0]]);

    const second = new SessionStore({ persistPath });
    assert.equal(second.getAssistantMessageForToolCall('call_1').reasoning_content, 'raw thinking');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('migrates version-2 files by harvesting the tool-call cache from snapshots', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gateway-session-migrate-v2-'));
  const persistPath = join(dir, 'sessions.json');
  try {
    await writeFile(persistPath, JSON.stringify({
      version: 2,
      sessions: [
        ['resp_1', { id: 'resp_1', messages: [{ role: 'user', content: 'look codex up' }, assistantToolCallMessage] }],
      ],
      conversations: [],
    }), 'utf8');

    const store = new SessionStore({ persistPath });
    assert.equal(store.getAssistantMessageForToolCall('call_1').reasoning_content, 'raw thinking');

    store.set('resp_2', { id: 'resp_2', messages: [{ role: 'user', content: 'next turn' }] });
    const payload = JSON.parse(await readFile(persistPath, 'utf8'));
    assert.equal(payload.version, 4);
    assert.equal(payload.assistantMessages.length, 1);
    assert.deepEqual(payload.toolCallMessages, [['call_1', 0]]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('stores one pooled copy for a parallel tool-call message on disk and resolves every call id', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gateway-session-pool-'));
  const persistPath = join(dir, 'sessions.json');
  try {
    const parallelMessage = {
      role: 'assistant',
      content: '',
      reasoning_content: 'parallel thinking',
      tool_calls: [
        { id: 'call_p1', type: 'function', function: { name: 'read', arguments: '{"path":"a.js"}' } },
        { id: 'call_p2', type: 'function', function: { name: 'read', arguments: '{"path":"b.js"}' } },
        { id: 'call_p3', type: 'function', function: { name: 'read', arguments: '{"path":"c.js"}' } },
      ],
    };
    const first = new SessionStore({ persistPath });
    first.rememberAssistantMessage(parallelMessage);

    const payload = JSON.parse(await readFile(persistPath, 'utf8'));
    assert.equal(payload.assistantMessages.length, 1);
    assert.deepEqual(payload.toolCallMessages, [
      ['call_p1', 0],
      ['call_p2', 0],
      ['call_p3', 0],
    ]);

    const second = new SessionStore({ persistPath });
    for (const callId of ['call_p1', 'call_p2', 'call_p3']) {
      const restored = second.getAssistantMessageForToolCall(callId);
      assert.equal(restored.reasoning_content, 'parallel thinking');
      assert.equal(restored.tool_calls.length, 3);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('collapses legacy per-call-id message clones into one pooled copy on migration', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gateway-session-collapse-'));
  const persistPath = join(dir, 'sessions.json');
  try {
    const legacyMessage = {
      role: 'assistant',
      content: '',
      reasoning_content: 'legacy thinking',
      tool_calls: [
        { id: 'call_l1', type: 'function', function: { name: 'read', arguments: '{"path":"a.js"}' } },
        { id: 'call_l2', type: 'function', function: { name: 'read', arguments: '{"path":"b.js"}' } },
      ],
    };
    await writeFile(persistPath, JSON.stringify({
      version: 3,
      sessions: [],
      conversations: [],
      toolCallMessages: [
        ['call_l1', legacyMessage],
        ['call_l2', legacyMessage],
      ],
    }), 'utf8');

    const store = new SessionStore({ persistPath });
    assert.equal(store.getAssistantMessageForToolCall('call_l1').reasoning_content, 'legacy thinking');
    assert.equal(store.getAssistantMessageForToolCall('call_l2').reasoning_content, 'legacy thinking');

    store.set('resp_next', { id: 'resp_next', messages: [] });
    const payload = JSON.parse(await readFile(persistPath, 'utf8'));
    assert.equal(payload.version, 4);
    assert.equal(payload.assistantMessages.length, 1);
    assert.deepEqual(payload.toolCallMessages, [
      ['call_l1', 0],
      ['call_l2', 0],
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('isolates returned cache messages from later caller mutations', async () => {
  const store = new SessionStore({});
  store.rememberAssistantMessage(assistantToolCallMessage);

  const first = store.getAssistantMessageForToolCall('call_1');
  first.reasoning_content = 'tampered';
  first.tool_calls[0].function.arguments = '{"query":"tampered"}';

  const second = store.getAssistantMessageForToolCall('call_1');
  assert.equal(second.reasoning_content, 'raw thinking');
  assert.equal(second.tool_calls[0].function.arguments, '{"query":"codex"}');
});

test('skips malformed pool references without dropping valid cache entries', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gateway-session-badref-'));
  const persistPath = join(dir, 'sessions.json');
  try {
    await writeFile(persistPath, JSON.stringify({
      version: 4,
      sessions: [],
      conversations: [],
      assistantMessages: [assistantToolCallMessage],
      toolCallMessages: [
        ['call_1', 0],
        ['call_out_of_range', 7],
        ['call_negative', -1],
        ['call_string_ref', '0'],
        ['call_null_ref', null],
      ],
    }), 'utf8');

    const store = new SessionStore({ persistPath });
    assert.equal(store.getAssistantMessageForToolCall('call_1').reasoning_content, 'raw thinking');
    assert.equal(store.getAssistantMessageForToolCall('call_out_of_range'), null);
    assert.equal(store.getAssistantMessageForToolCall('call_negative'), null);
    assert.equal(store.getAssistantMessageForToolCall('call_string_ref'), null);
    assert.equal(store.getAssistantMessageForToolCall('call_null_ref'), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('drops oldest sessions when the persisted file would exceed the byte budget', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gateway-session-bytes-'));
  const persistPath = join(dir, 'sessions.json');
  try {
    const bigText = 'x'.repeat(4000);
    const store = new SessionStore({ persistPath, maxBytes: 10000 });
    store.set('resp_1', { id: 'resp_1', messages: [{ role: 'user', content: bigText }] });
    store.set('resp_2', { id: 'resp_2', messages: [{ role: 'user', content: bigText }] });
    store.set('resp_3', { id: 'resp_3', messages: [{ role: 'user', content: bigText }] });

    assert.equal(store.get('resp_1'), null);
    assert.equal(store.get('resp_3').id, 'resp_3');

    const reloaded = new SessionStore({ persistPath, maxBytes: 10000 });
    assert.equal(reloaded.get('resp_1'), null);
    assert.equal(reloaded.get('resp_3').id, 'resp_3');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
