import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readCodexConfig } from '../src/codex-config.js';
import { loadConfig } from '../src/config.js';
import { mergeLocalConfig } from '../src/local-config.js';

test('loads local gateway config and lets env override it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gateway-config-'));
  try {
    await mkdir(join(dir, 'config'));
    await writeFile(
      join(dir, 'config', 'gateway.local.json'),
      JSON.stringify({
        port: 3010,
        host: '127.0.0.2',
        upstreamProvider: 'deepseek',
        upstreamBaseUrl: 'https://api.deepseek.com',
        upstreamApiKey: 'from-file',
        upstreamTimeoutMs: 60000,
      }),
    );

    const merged = mergeLocalConfig({ PORT: '3011' }, dir);
    assert.equal(merged.PORT, '3011');
    assert.equal(merged.HOST, '127.0.0.2');
    assert.equal(merged.UPSTREAM_API_KEY, 'from-file');

    const config = loadConfig({
      GATEWAY_CONFIG_FILE: join(dir, 'config', 'gateway.local.json'),
      PORT: '3012',
    });
    assert.equal(config.port, 3012);
    assert.equal(config.host, '127.0.0.2');
    assert.equal(config.upstreamApiKey, 'from-file');
    assert.equal(config.upstreamProvider, 'deepseek');
    assert.equal(config.tavilyWebSearchEnabled, false);
    assert.equal(config.tavilyMaxSearchRounds, 20);
    assert.equal(config.codexPromptLanguage, 'en');
    assert.equal(config.sessionStoreEnabled, true);
    assert.equal(config.sessionStorePath, join(dir, 'state', 'sessions.json'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('lets local config and env override persisted session store settings', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gateway-session-config-'));
  try {
    await mkdir(join(dir, 'config'));
    const file = join(dir, 'config', 'gateway.local.json');
    await writeFile(
      file,
      JSON.stringify({
        sessionStoreEnabled: false,
        sessionStorePath: join(dir, 'custom', 'sessions.json'),
        sessionStoreMaxSessions: 42,
      }),
    );

    const localConfig = loadConfig({ GATEWAY_CONFIG_FILE: file });
    assert.equal(localConfig.sessionStoreEnabled, false);
    assert.equal(localConfig.sessionStorePath, join(dir, 'custom', 'sessions.json'));
    assert.equal(localConfig.sessionStoreMaxSessions, 42);

    const envConfig = loadConfig({
      GATEWAY_CONFIG_FILE: file,
      SESSION_STORE_ENABLED: 'true',
      SESSION_STORE_PATH: join(dir, 'env', 'sessions.json'),
      SESSION_STORE_MAX_SESSIONS: '7',
    });
    assert.equal(envConfig.sessionStoreEnabled, true);
    assert.equal(envConfig.sessionStorePath, join(dir, 'env', 'sessions.json'));
    assert.equal(envConfig.sessionStoreMaxSessions, 7);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('loads Codex prompt language from local gateway config', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gateway-config-prompt-language-'));
  try {
    await mkdir(join(dir, 'config'));
    await writeFile(
      join(dir, 'config', 'gateway.local.json'),
      JSON.stringify({
        upstreamApiKey: 'from-file',
        codexPromptLanguage: 'zh',
      }),
    );

    const config = loadConfig({
      GATEWAY_CONFIG_FILE: join(dir, 'config', 'gateway.local.json'),
    });
    assert.equal(config.codexPromptLanguage, 'zh');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('falls back to English for invalid Codex prompt language', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gateway-config-prompt-language-'));
  try {
    await mkdir(join(dir, 'config'));
    await writeFile(
      join(dir, 'config', 'gateway.local.json'),
      JSON.stringify({
        upstreamApiKey: 'from-file',
        codexPromptLanguage: 'fr',
      }),
    );

    const config = loadConfig({
      GATEWAY_CONFIG_FILE: join(dir, 'config', 'gateway.local.json'),
    });
    assert.equal(config.codexPromptLanguage, 'en');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('keeps Codex prompt language scoped to gateway.local.json', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gateway-config-prompt-language-'));
  try {
    await mkdir(join(dir, 'config'));
    const file = join(dir, 'config', 'gateway.local.json');
    await writeFile(file, JSON.stringify({ upstreamApiKey: 'from-file', codexPromptLanguage: 'zh' }));

    const config = loadConfig({
      GATEWAY_CONFIG_FILE: file,
      CODEX_PROMPT_LANGUAGE: 'en',
    });
    assert.equal(config.codexPromptLanguage, 'zh');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('reads top-level Codex model reasoning effort from config.toml', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-config-'));
  try {
    const file = join(dir, 'config.toml');
    await writeFile(file, [
      'model_provider = "deepseek-gateway"',
      'model = "deepseek-v4-pro"',
      'model_reasoning_effort = "xhigh"',
      'model_supports_reasoning_summaries = true',
      'model_reasoning_summary = "auto"',
      '',
      '[model_providers.deepseek-gateway]',
      'name = "DeepSeek"',
    ].join('\n'));
    const config = readCodexConfig({ CODEX_CONFIG_FILE: file });
    assert.equal(config.modelProvider, 'deepseek-gateway');
    assert.equal(config.model, 'deepseek-v4-pro');
    assert.equal(config.modelReasoningEffort, 'xhigh');
    assert.equal(config.modelSupportsReasoningSummaries, 'true');
    assert.equal(config.modelReasoningSummary, 'auto');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('loads local gateway config with UTF-8 BOM', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gateway-config-bom-'));
  try {
    await mkdir(join(dir, 'config'));
    const file = join(dir, 'config', 'gateway.local.json');
    await writeFile(file, `\uFEFF${JSON.stringify({ upstreamApiKey: 'from-bom-file' })}`);
    const config = loadConfig({ GATEWAY_CONFIG_FILE: file });
    assert.equal(config.upstreamApiKey, 'from-bom-file');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('keeps quoted # characters when reading top-level Codex config values', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-config-'));
  try {
    const file = join(dir, 'config.toml');
    await writeFile(file, [
      'model_provider = "deepseek-gateway" # comment',
      'model = "deepseek-v4-pro#beta"',
      'model_reasoning_summary = "auto # keep"',
    ].join('\n'));
    const config = readCodexConfig({ CODEX_CONFIG_FILE: file });
    assert.equal(config.modelProvider, 'deepseek-gateway');
    assert.equal(config.model, 'deepseek-v4-pro#beta');
    assert.equal(config.modelReasoningSummary, 'auto # keep');
    assert.equal(config.hideAgentReasoning, '');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
