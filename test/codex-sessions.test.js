import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readSession, sessionPickerRows } from '../src/codex-sessions.js';

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
    assert.equal(session.title, 'first user prompt');
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

test('session picker rows include all sessions instead of truncating to the window size', () => {
  const rows = sessionPickerRows(Array.from({ length: 25 }, (_, index) => ({
    id: `019f4a63-236d-75c1-85e2-${String(index + 1).padStart(12, '0')}`,
    provider: 'deepseek-gateway',
    updatedAt: `2026-06-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
    title: `A longer session title ${index + 1} with useful context`,
  })));
  assert.equal(rows.length, 25);
  assert.doesNotMatch(rows.at(-1), /019f4a63/);
  assert.match(rows.at(-1), /A longer session title 25/);
  assert.match(rows.at(-1), /\.\.\.$/);
  assert.equal(rows[0].slice(13, 30), 'deepseek-gateway ');
  assert.equal(rows[0].length, 64);
});

test('session picker truncates CJK titles by terminal display width', () => {
  const [row] = sessionPickerRows([{
    id: 'session-1',
    provider: 'deepseek-gateway',
    updatedAt: '2026-07-11T00:00:00.000Z',
    title: '中文'.repeat(20),
  }]);
  assert.equal(row.slice(32), `${'中文'.repeat(7)}... `);
});

test('left arrow returns from model selection to session selection', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-sessions-flow-'));
  const codexHome = join(dir, 'codex-home');
  const installDir = join(dir, 'install');
  try {
    mkdirSync(join(codexHome, 'sessions'), { recursive: true });
    mkdirSync(join(installDir, 'config'), { recursive: true });
    writeFileSync(join(installDir, 'config', 'model-aliases.json'), JSON.stringify({
      'deepseek-v4-flash': { model: 'deepseek-v4-flash', thinking: 'auto' },
    }));
    writeFileSync(join(installDir, 'config', 'gateway.local.json'), '{}');
    writeJsonl(join(codexHome, 'sessions', 'main.jsonl'), [
      {
        type: 'session_meta',
        payload: {
          id: 'main-session',
          timestamp: '2026-07-11T00:00:00.000Z',
          cwd: dir,
          thread_source: 'user',
          model_provider: 'deepseek-gateway',
        },
      },
    ]);

    const moduleUrl = new URL('../src/codex-sessions.js', import.meta.url).href;
    const script = `
      import { sessions } from ${JSON.stringify(moduleUrl)};
      Object.defineProperty(process.stdin, 'isTTY', { value: true });
      Object.defineProperty(process.stdout, 'isTTY', { value: true });
      process.stdin.setRawMode = () => {};
      process.stdin.resume = () => {};
      process.stdin.pause = () => {};
      const keys = ['\\r', '\\u001b[D', '\\u001b'];
      const sendKey = () => {
        process.stdin.emit('data', Buffer.from(keys.shift()));
        if (keys.length) setTimeout(sendKey, 30);
      };
      setTimeout(sendKey, 30);
      await sessions({ dir: ${JSON.stringify(installDir)}, all: true, limit: 15 });
    `;
    const output = execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
      encoding: 'utf8',
      env: { ...process.env, CODEX_HOME: codexHome },
      timeout: 5000,
    });

    assert.equal(output.match(/Choose Codex session/g)?.length, 2);
    assert.equal(output.match(/Choose gateway model/g)?.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
