import test from 'node:test';

async function scenario(name, run) {
  try {
    await run();
  } catch (error) {
    error.message = `${name}: ${error.message}`;
    throw error;
  }
}
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { readSession, sessionPickerRows } from '../src/codex-sessions.js';
import { pathOnlyEnv, prepareFakeCodex } from './fake-codex.js';

function writeJsonl(file, rows) {
  writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
}

function sessionRows(id, cwd, provider, metaTimestamp, userTimestamp, userText) {
  const rows = [{
    type: 'session_meta',
    payload: {
      id,
      timestamp: metaTimestamp,
      cwd,
      thread_source: 'user',
      model_provider: provider,
    },
  }];
  if (userTimestamp) {
    rows.push({
      timestamp: userTimestamp,
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: userText }],
      },
    });
  }
  return rows;
}

function prepareSessionsFixture() {
  const root = mkdtempSync(join(tmpdir(), 'codex-sessions-cli-'));
  const projectDir = join(root, 'project');
  const codexHome = join(root, 'codex-home');
  const installDir = join(root, 'install');
  mkdirSync(join(projectDir, '.git'), { recursive: true });
  mkdirSync(join(projectDir, 'sub'), { recursive: true });
  mkdirSync(join(codexHome, 'sessions', '2026', '07'), { recursive: true });
  mkdirSync(join(installDir, 'config'), { recursive: true });
  writeFileSync(join(installDir, 'config', 'model-aliases.json'), JSON.stringify({
    'deepseek-v4-flash': { model: 'deepseek-v4-flash', thinking: 'auto' },
    'deepseek-v4-pro': { model: 'deepseek-v4-pro', thinking: 'auto' },
  }));
  writeFileSync(join(installDir, 'config', 'gateway.local.json'), '{}');
  writeFileSync(
    join(installDir, 'config', 'codex-model-catalog.json'),
    readFileSync(new URL('../config/codex-model-catalog.json', import.meta.url), 'utf8'),
  );
  const dayDir = join(codexHome, 'sessions', '2026', '07');
  const streaming = '019faaaa-0000-7000-8000-000000000001';
  const compactionReview = '019fbbbb-0000-7000-8000-000000000002';
  const elsewhere = '019fcccc-0000-7000-8000-000000000003';
  const scrolling = '019fdddd-0000-7000-8000-000000000004';
  writeJsonl(join(dayDir, 'streaming-1.jsonl'), sessionRows(
    streaming, projectDir, 'deepseek-gateway',
    '2026-07-18T09:00:00.000Z', '2026-07-19T10:00:00.000Z', 'Fix streaming bug in gateway',
  ));
  writeJsonl(join(dayDir, 'streaming-2.jsonl'), sessionRows(
    streaming, projectDir, 'deepseek-gateway',
    '2026-07-18T09:00:00.000Z', '2026-07-21T08:00:00.000Z', 'Continue the streaming fix',
  ));
  writeJsonl(join(dayDir, 'compaction.jsonl'), sessionRows(
    compactionReview, join(projectDir, 'sub'), '',
    '2026-07-15T00:00:00.000Z', '2026-07-16T00:00:00.000Z', 'Review compaction ledger overflow',
  ));
  writeJsonl(join(dayDir, 'elsewhere.jsonl'), sessionRows(
    elsewhere, join(root, 'elsewhere'), 'openai',
    '2026-07-20T00:00:00.000Z', '2026-07-20T01:00:00.000Z', 'Unrelated project session',
  ));
  writeJsonl(join(dayDir, 'scrolling.jsonl'), sessionRows(
    scrolling, projectDir, 'deepseek-gateway',
    '2026-07-09T00:00:00.000Z', '2026-07-10T00:00:00.000Z', 'Third session for scrolling',
  ));
  writeFileSync(join(codexHome, 'session_index.jsonl'), [
    'not json at all',
    JSON.stringify({ updated_at: '2026-07-22T00:00:00.000Z', thread_name: 'No id row' }),
    JSON.stringify({ id: streaming, updated_at: '2026-07-19T10:00:00.000Z', thread_name: 'Old A name' }),
    JSON.stringify({ id: streaming, updated_at: '2026-07-21T08:00:00.000Z', thread_name: 'Streaming fix' }),
  ].join('\n'), 'utf8');
  const env = { ...process.env, CODEX_HOME: codexHome, CODEX_CONFIG_FILE: join(root, 'missing-codex-config.toml') };
  return { root, projectDir, codexHome, installDir, env, ids: { streaming, compactionReview, elsewhere, scrolling } };
}

const CLI_PATH = fileURLToPath(new URL('../bin/codex-deepseek-gateway.js', import.meta.url));

function runSessionsCli(fixture, args, options = {}) {
  return execFileSync(process.execPath, [CLI_PATH, 'sessions', '--dir', fixture.installDir, ...args], {
    encoding: 'utf8',
    cwd: options.cwd || fixture.projectDir,
    env: options.env || fixture.env,
    timeout: 20000,
  });
}

test('session discovery and filtering', async () => {
  await scenario('readSession uses the last user message timestamp', async () => {
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
  await scenario('readSession skips Codex subagent transcripts', async () => {
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
  await scenario('sessions --print lists deduplicated project sessions with resume commands', async () => {
  const fixture = prepareSessionsFixture();
  try {
    const output = runSessionsCli(fixture, ['--print'], { cwd: join(fixture.projectDir, 'sub') });
    assert.match(output, new RegExp(`Codex sessions for project ${fixture.projectDir.replace(/\\/g, '\\\\')}`));
    assert.match(output, /Target: deepseek-gateway \/ deepseek-v4-flash \/ low/);
    assert.match(output, / 1 {2}2026-07-21 {3}deepseek-gateway/);
    assert.match(output, /Streaming fix/);
    assert.doesNotMatch(output, /Old A name/);
    assert.match(output, / 2 {2}2026-07-16 {3}\(unknown\) {10}Review compaction ledger over\.\.\./);
    assert.match(output, / 3 {2}2026-07-10 {3}deepseek-gateway {3}Third session for scrolling/);
    assert.doesNotMatch(output, /019fcccc/);
    assert.doesNotMatch(output, /cwd:/);
    assert.doesNotMatch(output, /Showing/);
    assert.match(output, new RegExp(`resume: codex resume ${fixture.ids.streaming} -c 'model_provider="deepseek-gateway"'`));

    const emptyProject = join(fixture.root, 'empty-project');
    mkdirSync(join(emptyProject, '.git'), { recursive: true });
    const emptyOutput = runSessionsCli(fixture, ['--print'], { cwd: emptyProject });
    assert.match(emptyOutput, /No matching sessions found\./);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
  });
  await scenario('sessions --print --all crosses projects and honors limit and target overrides', async () => {
  const fixture = prepareSessionsFixture();
  try {
    const output = runSessionsCli(fixture, ['--print', '--all', '--limit', '1', '--model', 'deepseek-v4-pro', '--reasoning-effort', 'max']);
    assert.match(output, new RegExp(`Codex sessions under ${fixture.codexHome.replace(/\\/g, '\\\\')}`));
    assert.match(output, /Target: deepseek-gateway \/ deepseek-v4-pro \/ max/);
    assert.match(output, /cwd: /);
    assert.match(output, /Showing 1 of 4\. Use --limit 4 or --all as needed\./);
    assert.match(output, /model="deepseek-v4-pro"/);
    assert.match(output, /model_reasoning_effort="max"/);
    assert.doesNotMatch(output, /019fbbbb/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
  });
  await scenario('sessions --exec resumes unique selections and rejects ambiguous ones', async () => {
  const fixture = prepareSessionsFixture();
  try {
    const fake = prepareFakeCodex(fixture.root);
    if (!fake) return;
    const env = pathOnlyEnv(fixture.env, fake.shimDir);
    for (const selection of ['019faaaa', '2']) {
      let failure;
      try {
        runSessionsCli(fixture, ['--exec', selection], { env });
      } catch (error) {
        failure = error;
      }
      assert.equal(failure?.status, 1);
      assert.match(String(failure.stderr), /Cannot find module '.*resume'/);
      assert.doesNotMatch(String(failure.stderr), /Session not found/);
    }
    for (const selection of ['019f', 'zzz']) {
      let failure;
      try {
        runSessionsCli(fixture, ['--exec', selection], { env });
      } catch (error) {
        failure = error;
      }
      assert.equal(failure?.status, 1);
      assert.match(String(failure.stderr), new RegExp(`Session not found or ambiguous: ${selection}`));
      assert.doesNotMatch(String(failure.stderr), /Cannot find module/);
    }
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
  });
});

test('session picker rendering and navigation', async () => {
  await scenario('session picker rows include all sessions instead of truncating to the window size', async () => {
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
  await scenario('session picker truncates CJK titles by terminal display width', async () => {
  const [row] = sessionPickerRows([{
    id: 'session-1',
    provider: 'deepseek-gateway',
    updatedAt: '2026-07-11T00:00:00.000Z',
    title: '中文'.repeat(20),
  }]);
  assert.equal(row.slice(32), `${'中文'.repeat(7)}... `);
  });
  await scenario('sessionPickerRows resolves the unknown-provider label per requested language', async () => {
  const sessionsList = [{
    id: 'session-1',
    provider: '',
    updatedAt: '2026-07-11T00:00:00.000Z',
    title: 'Untitled review',
  }];
  const [enRow] = sessionPickerRows(sessionsList);
  assert.match(enRow, /\(unknown\)/);
  const [zhRow] = sessionPickerRows(sessionsList, 'zh');
  assert.match(zhRow, /\(未知\)/);
  });
  await scenario('the interactive session picker localizes the unknown-provider label while --print stays English', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-sessions-lang-'));
  const codexHome = join(dir, 'codex-home');
  const installDir = join(dir, 'install');
  const projectDir = join(dir, 'project');
  try {
    mkdirSync(join(projectDir, '.git'), { recursive: true });
    mkdirSync(join(codexHome, 'sessions'), { recursive: true });
    mkdirSync(join(installDir, 'config'), { recursive: true });
    writeFileSync(join(installDir, 'config', 'model-aliases.json'), JSON.stringify({
      'deepseek-v4-flash': { model: 'deepseek-v4-flash', thinking: 'auto' },
    }));
    writeFileSync(join(installDir, 'config', 'gateway.local.json'), JSON.stringify({ codexPromptLanguage: 'zh' }));
    writeFileSync(
      join(installDir, 'config', 'codex-model-catalog.zh.json'),
      readFileSync(new URL('../config/codex-model-catalog.zh.json', import.meta.url), 'utf8'),
    );
    writeJsonl(join(codexHome, 'sessions', 'main.jsonl'), [
      {
        type: 'session_meta',
        payload: {
          id: 'main-session',
          timestamp: '2026-07-11T00:00:00.000Z',
          cwd: projectDir,
          thread_source: 'user',
        },
      },
    ]);

    const printFixture = {
      installDir,
      projectDir,
      env: { ...process.env, CODEX_HOME: codexHome, CODEX_CONFIG_FILE: join(dir, 'missing-codex-config.toml') },
    };
    const printOutput = runSessionsCli(printFixture, ['--print']);
    assert.match(printOutput, /\(unknown\)/);
    assert.doesNotMatch(printOutput, /未知/);

    const moduleUrl = new URL('../src/codex-sessions.js', import.meta.url).href;
    const script = `
      import { sessions } from ${JSON.stringify(moduleUrl)};
      Object.defineProperty(process.stdin, 'isTTY', { value: true });
      Object.defineProperty(process.stdout, 'isTTY', { value: true });
      process.stdin.setRawMode = () => {};
      process.stdin.resume = () => {};
      process.stdin.pause = () => {};
      setTimeout(() => process.stdin.emit('data', Buffer.from('\\u001b')), 30);
      await sessions({ dir: ${JSON.stringify(installDir)}, limit: 15 });
    `;
    const output = execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
      encoding: 'utf8',
      cwd: projectDir,
      env: { ...process.env, CODEX_HOME: codexHome },
      timeout: 5000,
    });
    assert.match(output, /\(未知\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  });
  await scenario('left arrow navigates back through reasoning and model selection', async () => {
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
    writeFileSync(
      join(installDir, 'config', 'codex-model-catalog.json'),
      readFileSync(new URL('../config/codex-model-catalog.json', import.meta.url), 'utf8'),
    );
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
      const keys = ['\\r', '\\r', '\\u001b[D', '\\u001b[D', '\\u001b'];
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
    assert.equal(output.match(/Choose gateway model/g)?.length, 2);
    assert.equal(output.match(/Choose DeepSeek reasoning level for deepseek-v4-flash/g)?.length, 1);
    assert.match(output, /Fast and cost-efficient agentic model for everyday work\./);
    assert.match(output, /Fast responses with thinking disabled/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  });
  await scenario('session picker scrolls beyond the window and resumes the selected session', async () => {
  const fixture = prepareSessionsFixture();
  try {
    const fake = prepareFakeCodex(fixture.root);
    if (!fake) return;
    const moduleUrl = new URL('../src/codex-sessions.js', import.meta.url).href;
    const script = `
      import { sessions } from ${JSON.stringify(moduleUrl)};
      Object.defineProperty(process.stdin, 'isTTY', { value: true });
      Object.defineProperty(process.stdout, 'isTTY', { value: true });
      process.stdin.setRawMode = () => {};
      process.stdin.resume = () => {};
      process.stdin.pause = () => {};
      const keys = ['\\u001b[B', '\\u001b[B', '\\r', '\\r', '\\r'];
      const sendKey = () => {
        process.stdin.emit('data', Buffer.from(keys.shift()));
        if (keys.length) setTimeout(sendKey, 30);
      };
      setTimeout(sendKey, 30);
      await sessions({ dir: ${JSON.stringify(fixture.installDir)}, limit: 2 });
    `;
    let failure;
    try {
      execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
        encoding: 'utf8',
        cwd: fixture.projectDir,
        env: pathOnlyEnv(fixture.env, fake.shimDir),
        timeout: 20000,
      });
    } catch (error) {
      failure = error;
    }
    assert.equal(failure?.status, 1);
    const stdout = String(failure.stdout);
    assert.match(stdout, /Showing 1-2 of 3/);
    assert.match(stdout, /Showing 2-3 of 3/);
    assert.match(stdout, /\x1b\[38;2;57;100;254m> 2026-07-10 {3}deepseek-gateway {3}Third session for scrolling/);
    assert.match(stdout, /Choose gateway model/);
    assert.match(stdout, /Choose DeepSeek reasoning level for deepseek-v4-flash/);
    assert.match(String(failure.stderr), /Cannot find module '.*resume'/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
  });
});
