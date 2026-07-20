import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

async function scenario(name, run) {
  try {
    await run();
  } catch (error) {
    error.message = `${name}: ${error.message}`;
    throw error;
  }
}
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  codexNewArgs,
  codexResumeArgs,
  codexResumeCommand,
  createLaunchContext,
  pickerWindow,
} from '../src/codex-launch.js';

const context = {
  provider: 'deepseek-gateway',
  model: 'deepseek-v4-flash',
  reasoningEffort: 'high',
  modelCatalogPath: 'C:\\Users\\PC\\.codex\\deepseek-gateway\\config\\codex-model-catalog.json',
};

test('Codex launch configuration and catalogs', async () => {
  await scenario('codex launch overrides enable reasoning summaries for custom models', async () => {
  assert.deepEqual(codexNewArgs(context), [
    '-c',
    'model_provider="deepseek-gateway"',
    '-c',
    'model="deepseek-v4-flash"',
    '-c',
    'model_reasoning_effort="high"',
    '-c',
    'model_supports_reasoning_summaries=true',
    '-c',
    'model_reasoning_summary="auto"',
    '-c',
    'model_catalog_json="C:\\\\Users\\\\PC\\\\.codex\\\\deepseek-gateway\\\\config\\\\codex-model-catalog.json"',
  ]);

  assert.deepEqual(codexResumeArgs('session-1', context), [
    'resume',
    'session-1',
    ...codexNewArgs(context),
  ]);
  });
  await scenario('printed resume commands quote config overrides', async () => {
  assert.equal(
    codexResumeCommand('session-1', context),
    'codex resume session-1 -c \'model_provider="deepseek-gateway"\' -c \'model="deepseek-v4-flash"\' -c \'model_reasoning_effort="high"\' -c model_supports_reasoning_summaries=true -c \'model_reasoning_summary="auto"\' -c \'model_catalog_json="C:\\\\Users\\\\PC\\\\.codex\\\\deepseek-gateway\\\\config\\\\codex-model-catalog.json"\'',
  );
  });
  await scenario('non-gateway launches do not force the gateway model catalog', async () => {
  const other = {
    ...context,
    provider: 'duckcoding',
  };
  assert.equal(codexNewArgs(other).includes('model_catalog_json="C:\\\\Users\\\\PC\\\\.codex\\\\deepseek-gateway\\\\config\\\\codex-model-catalog.json"'), false);
  assert.equal(codexResumeCommand('session-1', other).includes('model_catalog_json='), false);
  });
  await scenario('gateway launches reject unsupported reasoning efforts', async () => {
  assert.throws(
    () => codexNewArgs({ ...context, reasoningEffort: 'minimal' }),
    /Unsupported DeepSeek reasoning effort "minimal"\. Expected one of: low, medium, high, xhigh, max/,
  );
  });
  await scenario('non-gateway launches keep Codex custom reasoning efforts open', async () => {
  assert.doesNotThrow(() => codexNewArgs({ ...context, provider: 'other', reasoningEffort: 'future' }));
  });
  await scenario('launch context defaults to the English Codex catalog', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-launch-'));
  try {
    mkdirSync(join(dir, 'config'));
    writeFileSync(join(dir, 'config', 'model-aliases.json'), JSON.stringify({ 'deepseek-v4-flash': 'deepseek-v4-flash' }));
    writeFileSync(join(dir, 'config', 'gateway.local.json'), JSON.stringify({ upstreamApiKey: 'test-key' }));

    const context = createLaunchContext({ dir });
    assert.equal(context.promptLanguage, 'en');
    assert.equal(context.modelCatalogPath.endsWith(join('config', 'codex-model-catalog.json')), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  });
  await scenario('launch context uses Chinese Codex catalog when configured', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-launch-'));
  try {
    mkdirSync(join(dir, 'config'));
    writeFileSync(join(dir, 'config', 'model-aliases.json'), JSON.stringify({ 'deepseek-v4-flash': 'deepseek-v4-flash' }));
    writeFileSync(join(dir, 'config', 'gateway.local.json'), JSON.stringify({ upstreamApiKey: 'test-key', codexPromptLanguage: 'zh' }));

    const context = createLaunchContext({ dir });
    assert.equal(context.promptLanguage, 'zh');
    assert.equal(context.modelCatalogPath.endsWith(join('config', 'codex-model-catalog.zh.json')), true);
    assert.ok(codexNewArgs(context).some((arg) => arg.includes('codex-model-catalog.zh.json')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  });
  await scenario('launch context ignores reasoning effort from a different provider', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-launch-'));
  const previousConfigFile = process.env.CODEX_CONFIG_FILE;
  try {
    mkdirSync(join(dir, 'config'));
    writeFileSync(join(dir, 'config', 'model-aliases.json'), JSON.stringify({ 'deepseek-v4-flash': 'deepseek-v4-flash' }));
    writeFileSync(join(dir, 'config', 'gateway.local.json'), JSON.stringify({ upstreamApiKey: 'test-key' }));
    const codexConfigFile = join(dir, 'config.toml');
    writeFileSync(codexConfigFile, 'model_provider = "other"\nmodel_reasoning_effort = "minimal"\n');
    process.env.CODEX_CONFIG_FILE = codexConfigFile;

    const context = createLaunchContext({ dir });
    assert.equal(context.reasoningEffort, 'low');
  } finally {
    if (previousConfigFile === undefined) delete process.env.CODEX_CONFIG_FILE;
    else process.env.CODEX_CONFIG_FILE = previousConfigFile;
    rmSync(dir, { recursive: true, force: true });
  }
  });
  await scenario('gateway Codex model catalogs satisfy the shared structural contract', async () => {
  const files = ['codex-model-catalog.json', 'codex-model-catalog.zh.json'];
  const expectedSlugs = ['deepseek-v4-flash', 'deepseek-v4-pro'];
  const expectedEfforts = ['low', 'medium', 'high', 'xhigh', 'max'];
  const expectedDescriptions = {
    'codex-model-catalog.json': [
      'Fast responses without extended reasoning',
      'Balances speed and reasoning depth for everyday tasks',
      'Greater reasoning depth for complex problems',
      'Extra high reasoning depth for complex problems',
      'Maximum reasoning depth for the hardest problems',
    ],
    'codex-model-catalog.zh.json': [
      '快速响应，不进行扩展推理',
      '平衡速度与推理深度，适合日常任务',
      '深度推理，适合复杂问题',
      '更高的推理深度，适合复杂问题',
      '最大推理深度，适合最困难的问题',
    ],
  };
  const expectedPersonalityKeys = ['personality_default', 'personality_friendly', 'personality_pragmatic'];

  for (const file of files) {
    const raw = readFileSync(new URL(`../config/${file}`, import.meta.url), 'utf8');
    assert.equal(/(?:\u0000|\uFFFD|\?{4,})/u.test(raw), false);
    const catalog = JSON.parse(raw);
    assert.deepEqual(catalog.models.map((model) => model.slug), expectedSlugs);

    for (const model of catalog.models) {
      const template = model.model_messages.instructions_template;
      const variables = model.model_messages.instructions_variables;
      assert.equal(typeof template, 'string');
      assert.equal((template.match(/\{\{ personality \}\}/g) || []).length, 1);
      assert.deepEqual(Object.keys(variables).sort(), expectedPersonalityKeys);
      assert.equal(Object.values(variables).every((value) => typeof value === 'string'), true);
      assert.equal(model.base_instructions, template.replace('{{ personality }}', variables.personality_pragmatic));
      assert.match(template, /commentary\(text:/);
      assert.equal(template.includes('multi_tool_use'), false);
      assert.equal(template.includes('require_escalated'), false);
      assert.equal(/do not include `prefix_rule`|不要包含 `prefix_rule`/u.test(template), false);
      assert.match(template, /active tool schema|当前工具 schema/u);
      assert.match(template, /narrowest sufficient permission mode|最小充分权限模式/u);
      assert.deepEqual(model.supported_reasoning_levels.map((level) => level.effort), expectedEfforts);
      assert.deepEqual(model.supported_reasoning_levels.map((level) => level.description), expectedDescriptions[file]);
      assert.equal(expectedEfforts.includes(model.default_reasoning_level), true);
      assert.equal(model.supports_reasoning_summaries, true);
      assert.equal(model.default_reasoning_summary, 'auto');
      assert.equal(model.supports_parallel_tool_calls, true);
      assert.equal(model.effective_context_window_percent, 90);
      assert.equal(model.auto_compact_token_limit, 900000);
    }
  }
  });
});

test('interactive picker rendering and navigation', async () => {
  await scenario('picker window scrolls only when selection leaves the visible window', async () => {
  const rows = Array.from({ length: 30 }, (_, index) => `row ${index + 1}`);
  assert.deepEqual(pickerWindow(rows, 0, 5), {
    offset: 0,
    rows: ['row 1', 'row 2', 'row 3', 'row 4', 'row 5'],
  });
  assert.deepEqual(pickerWindow(rows, 4, 5, 0), {
    offset: 0,
    rows: ['row 1', 'row 2', 'row 3', 'row 4', 'row 5'],
  });
  assert.deepEqual(pickerWindow(rows, 5, 5, 0), {
    offset: 1,
    rows: ['row 2', 'row 3', 'row 4', 'row 5', 'row 6'],
  });
  assert.deepEqual(pickerWindow(rows, 4, 5, 1), {
    offset: 1,
    rows: ['row 2', 'row 3', 'row 4', 'row 5', 'row 6'],
  });
  assert.deepEqual(pickerWindow(rows, 0, 5, 1), {
    offset: 0,
    rows: ['row 1', 'row 2', 'row 3', 'row 4', 'row 5'],
  });
  assert.deepEqual(pickerWindow(rows, 29, 5, 25), {
    offset: 25,
    rows: ['row 26', 'row 27', 'row 28', 'row 29', 'row 30'],
  });
  });
  await scenario('picker indents empty state and separates muted control descriptions', async () => {
  const moduleUrl = new URL('../src/codex-launch.js', import.meta.url).href;
  const script = `
    import { pick } from ${JSON.stringify(moduleUrl)};
    await pick('Choose Codex session', [], 'Date  Provider  Title', {
      emptyMessage: 'No matching sessions found.',
      shortcuts: [{ key: 'n', displayKey: 'N', action: 'new', label: 'new' }],
    });
    process.stdin.pause();
  `;
  const output = execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
    encoding: 'utf8',
    input: '\u001b',
  });
  const plain = output.replace(/\x1b\[[0-9;]*m/g, '');
  assert.match(plain, /\n  No matching sessions found\.\n/);
  assert.match(plain, /\n  ─{21}\n/);
  assert.match(plain, /N new {4}↑\/↓ browse {4}← back {4}Enter confirm {4}Esc quit/);
  assert.match(output, /\x1b\[90m─{21}\x1b\[0m/);
  assert.match(output, /N \x1b\[90mnew\x1b\[0m {4}↑\/↓ \x1b\[90mbrowse\x1b\[0m/);
  });
});
