import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

async function scenario(name, run) {
  try {
    await run();
  } catch (error) {
    error.message = `${name}: ${error.message}`;
    throw error;
  }
}
import { inspectCodexConfig, readCodexConfig } from '../src/codex-config.js';
import { loadConfig, normalizeCompactMaxTokens, normalizeCompactReasoningEffort } from '../src/config.js';
import { mergeLocalConfig, readLocalConfigFile, resolveLocalConfigPath } from '../src/local-config.js';
import { catalogFileForPromptLanguage, normalizePromptLanguage } from '../src/prompt-language.js';

test('gateway configuration precedence and defaults', async () => {
  await scenario('loads local gateway config and lets env override it', async () => {
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
        requestBodyMaxBytes: 1048576,
        shutdownTimeoutMs: 4000,
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
    assert.equal(config.compactReasoningEffort, 'max');
    assert.equal(config.compactMaxTokens, 20000);
    assert.equal(config.requestBodyMaxBytes, 1048576);
    assert.equal(config.shutdownTimeoutMs, 4000);
    assert.equal(config.tavilyWebSearchEnabled, false);
    assert.equal(config.tavilyMaxSearchRounds, 20);
    assert.equal(config.firecrawlAutoScrapeTopResults, 1);
    assert.equal(config.codexPromptLanguage, 'en');
    assert.equal(config.reasoningCacheEnabled, true);
    assert.equal(config.reasoningCachePath, join(dir, 'state', 'reasoning-cache.jsonl'));
    assert.equal(config.reasoningCacheMaxMessages, 1000);
    assert.equal(config.legacyReasoningCachePath, join(dir, 'state', 'sessions.json'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  });
  await scenario('normalizes compact-specific configuration', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gateway-compact-config-'));
  try {
    await mkdir(join(dir, 'config'));
    const file = join(dir, 'config', 'gateway.local.json');
    await writeFile(file, JSON.stringify({
      upstreamApiKey: 'from-file',
      compactReasoningEffort: 'high',
      compactMaxTokens: 50000,
    }));
    const localConfig = loadConfig({ GATEWAY_CONFIG_FILE: file });
    assert.equal(localConfig.compactReasoningEffort, 'high');
    assert.equal(localConfig.compactMaxTokens, 50000);

    const envConfig = loadConfig({
      GATEWAY_CONFIG_FILE: file,
      COMPACT_REASONING_EFFORT: 'invalid',
      COMPACT_MAX_TOKENS: '200000',
    });
    assert.equal(envConfig.compactReasoningEffort, 'max');
    assert.equal(envConfig.compactMaxTokens, 100000);

    const fallbackConfig = loadConfig({
      GATEWAY_CONFIG_FILE: file,
      COMPACT_MAX_TOKENS: '0',
    });
    assert.equal(fallbackConfig.compactMaxTokens, 20000);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  });
  await scenario('lets local config and env override reasoning cache settings', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gateway-reasoning-cache-config-'));
  try {
    await mkdir(join(dir, 'config'));
    const file = join(dir, 'config', 'gateway.local.json');
    await writeFile(
      file,
      JSON.stringify({
        reasoningCacheEnabled: false,
        reasoningCachePath: join(dir, 'custom', 'reasoning-cache.jsonl'),
        reasoningCacheMaxMessages: 42,
      }),
    );

    const localConfig = loadConfig({ GATEWAY_CONFIG_FILE: file });
    assert.equal(localConfig.reasoningCacheEnabled, false);
    assert.equal(localConfig.reasoningCachePath, join(dir, 'custom', 'reasoning-cache.jsonl'));
    assert.equal(localConfig.reasoningCacheMaxMessages, 42);

    const envConfig = loadConfig({
      GATEWAY_CONFIG_FILE: file,
      REASONING_CACHE_ENABLED: 'true',
      REASONING_CACHE_PATH: join(dir, 'env', 'reasoning-cache.jsonl'),
      REASONING_CACHE_MAX_MESSAGES: '7',
    });
    assert.equal(envConfig.reasoningCacheEnabled, true);
    assert.equal(envConfig.reasoningCachePath, join(dir, 'env', 'reasoning-cache.jsonl'));
    assert.equal(envConfig.reasoningCacheMaxMessages, 7);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  });
  await scenario('loads Codex prompt language from local gateway config', async () => {
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
  await scenario('falls back to English for invalid Codex prompt language', async () => {
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
  await scenario('keeps Codex prompt language scoped to gateway.local.json', async () => {
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
  await scenario('loads local gateway config with UTF-8 BOM', async () => {
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
  await scenario('normalizes standalone compact, prompt-language, and local-config boundaries', async () => {
  assert.equal(normalizeCompactReasoningEffort('high'), 'high');
  assert.equal(normalizeCompactReasoningEffort('future'), 'max');
  assert.equal(normalizeCompactMaxTokens('50000'), 50000);
  assert.equal(normalizeCompactMaxTokens('200000'), 100000);
  assert.equal(normalizeCompactMaxTokens('0'), 20000);
  assert.equal(normalizePromptLanguage(' ZH '), 'zh');
  assert.equal(normalizePromptLanguage('fr'), 'en');
  assert.equal(catalogFileForPromptLanguage('zh'), 'codex-model-catalog.zh.json');
  assert.equal(catalogFileForPromptLanguage('invalid'), 'codex-model-catalog.json');

  const dir = await mkdtemp(join(tmpdir(), 'gateway-local-config-'));
  try {
    const nested = join(dir, 'nested.json');
    await writeFile(nested, JSON.stringify({ upstream: { apiKey: 'key' }, webSearch: { enabled: true } }));
    assert.deepEqual(readLocalConfigFile(nested), {
      UPSTREAM_API_KEY: 'key',
      WEB_SEARCH_ENABLED: 'true',
    });
    assert.deepEqual(readLocalConfigFile(join(dir, 'missing.json')), {});
    assert.equal(resolveLocalConfigPath({ GATEWAY_CONFIG_FILE: 'nested.json' }, dir), nested);
    assert.equal(resolveLocalConfigPath({}, dir), join(dir, 'config', 'gateway.local.json'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  });
});

test('Codex config parsing', async () => {
  await scenario('reads top-level Codex model reasoning effort from config.toml', async () => {
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
  await scenario('keeps quoted # characters when reading top-level Codex config values', async () => {
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
  await scenario('inspects the gateway provider without treating the plain Codex default as a failure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-config-'));
  try {
    const file = join(dir, 'config.toml');
    await writeFile(file, [
      'model_provider = "duckcoding"',
      'model = "other-model"',
      '',
      '[model_providers.deepseek-gateway]',
      'name = "DeepSeek"',
      'base_url = "http://127.0.0.1:3000/v1"',
      'wire_api = "responses"',
    ].join('\n'));
    const config = inspectCodexConfig({ CODEX_CONFIG_FILE: file });
    assert.equal(config.exists, true);
    assert.equal(config.modelProvider, 'duckcoding');
    assert.deepEqual(config.provider, {
      name: 'DeepSeek',
      base_url: 'http://127.0.0.1:3000/v1',
      wire_api: 'responses',
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  });
});
