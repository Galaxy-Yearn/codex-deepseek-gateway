import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readSession } from '../src/codex-sessions.js';

function writeJsonl(file, rows) {
  writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
}

test('readSession uses the last user message timestamp', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-sessions-'));
  try {
    const file = join(dir, 'main.jsonl');
    writeJsonl(file, [
      {
        type: 'session_meta',
        payload: {
          id: 'main-session',
          timestamp: '2026-06-01T00:00:00.000Z',
          cwd: dir,
          thread_source: 'user',
          model_provider: 'deepseek-gateway',
        },
      },
      {
        timestamp: '2026-06-02T00:00:00.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'first user prompt' }],
        },
      },
      {
        timestamp: '2026-06-03T00:00:00.000Z',
        type: 'event_msg',
        payload: {
          type: 'user_message',
          message: 'latest user prompt',
        },
      },
    ]);

    const session = readSession(file, new Map([['main-session', { updated_at: '2026-06-01T12:00:00.000Z' }]]));
    assert.equal(session.updatedAt, '2026-06-03T00:00:00.000Z');
    assert.equal(session.title, 'first user prom...');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readSession skips Codex subagent transcripts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-sessions-'));
  try {
    const file = join(dir, 'subagent.jsonl');
    writeJsonl(file, [
      {
        type: 'session_meta',
        payload: {
          id: 'subagent-session',
          parent_thread_id: 'main-session',
          timestamp: '2026-06-03T00:00:00.000Z',
          cwd: dir,
          thread_source: 'subagent',
          model_provider: 'deepseek-gateway',
        },
      },
      {
        timestamp: '2026-06-03T00:00:01.000Z',
        type: 'event_msg',
        payload: {
          type: 'user_message',
          message: 'delegated task prompt',
        },
      },
    ]);

    assert.equal(readSession(file, new Map()), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
