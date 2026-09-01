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
  REASONING_EFFORTS,
  codexNewArgs,
  codexResumeArgs,
  codexResumeCommand,
  createLaunchContext,
  missingModelMessage,
  pickerChoiceRows,
  pickerCopy,
} from '../src/codex-launch.js';
import { displayWidth } from '../src/terminal-text.js';
import { pathOnlyEnv, prepareFakeCodex } from '../test-support/fake-codex.js';

function writeGatewayInstall(installDir, { models, localConfig = {} } = {}) {
  mkdirSync(join(installDir, 'config'), { recursive: true });
  writeFileSync(join(installDir, 'config', 'gateway.local.json'), JSON.stringify(localConfig));
  const catalog = JSON.parse(readFileSync(new URL('../config/model-catalog.json', import.meta.url), 'utf8'));
  if (Array.isArray(models)) catalog.models = catalog.models.filter((model) => models.includes(model.slug));
  writeFileSync(
    join(installDir, 'config', 'model-catalog.json'),
    JSON.stringify(catalog),
  );
}

const context = {
  provider: 'deepseek-gateway',
  model: 'deepseek-v4-flash',
  reasoningEffort: 'high',
  reasoningEfforts: {
    'deepseek-v4-flash': ['low', 'high', 'max'],
    'deepseek-v4-pro': ['low', 'high', 'max'],
  },
  modelCatalogPath: 'C:\\Users\\PC\\.codex\\deepseek-gateway\\config\\model-catalog.json',
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
    'model_catalog_json="C:\\\\Users\\\\PC\\\\.codex\\\\deepseek-gateway\\\\config\\\\model-catalog.json"',
  ]);

  assert.deepEqual(codexResumeArgs('session-1', context), [
    'resume',
    'session-1',
    ...codexNewArgs(context),
  ]);
  });
  await scenario('launch context selects the OrcaRouter catalog from local provider config', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-launch-orca-'));
    try {
      mkdirSync(join(dir, 'config'));
      writeFileSync(join(dir, 'config', 'gateway.local.json'), JSON.stringify({ upstreamProvider: 'orcarouter', upstreamApiKey: 'test-key' }));
      writeFileSync(join(dir, 'config', 'model-catalog.orcarouter.json'), JSON.stringify({
        models: [{ slug: 'orcarouter/auto', description: 'auto', default_reasoning_level: 'high', supported_reasoning_levels: [{ effort: 'high', description: 'deep' }] }],
      }));
      const context = createLaunchContext({ dir });
      assert.equal(context.upstreamProvider, 'orcarouter');
      assert.equal(context.modelCatalogPath.endsWith(join('config', 'model-catalog.orcarouter.json')), true);
      assert.deepEqual(context.models, ['orcarouter/auto']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  await scenario('printed resume commands quote config overrides', async () => {
  assert.equal(
    codexResumeCommand('session-1', context),
    'codex resume session-1 -c \'model_provider="deepseek-gateway"\' -c \'model="deepseek-v4-flash"\' -c \'model_reasoning_effort="high"\' -c model_supports_reasoning_summaries=true -c \'model_reasoning_summary="auto"\' -c \'model_catalog_json="C:\\\\Users\\\\PC\\\\.codex\\\\deepseek-gateway\\\\config\\\\model-catalog.json"\'',
  );
  });
  await scenario('non-gateway launches do not force the gateway model catalog', async () => {
  const other = {
    ...context,
    provider: 'duckcoding',
  };
  assert.equal(codexNewArgs(other).includes('model_catalog_json="C:\\\\Users\\\\PC\\\\.codex\\\\deepseek-gateway\\\\config\\\\model-catalog.json"'), false);
  assert.equal(codexResumeCommand('session-1', other).includes('model_catalog_json='), false);
  });
  await scenario('gateway launches reject unsupported reasoning efforts', async () => {
  assert.throws(
    () => codexNewArgs({ ...context, reasoningEffort: 'minimal' }),
    /Unsupported DeepSeek reasoning effort "minimal"\. Expected one of: low, high, max/,
  );
  assert.throws(
    () => codexNewArgs({ ...context, reasoningEffort: 'none' }),
    /Unsupported DeepSeek reasoning effort "none"\. Expected one of: low, high, max/,
  );
  });
  await scenario('non-gateway launches keep Codex custom reasoning efforts open', async () => {
  assert.doesNotThrow(() => codexNewArgs({ ...context, provider: 'other', reasoningEffort: 'future' }));
  });
  await scenario('launch context defaults to the English Codex catalog', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-launch-'));
  try {
    mkdirSync(join(dir, 'config'));
    writeFileSync(join(dir, 'config', 'gateway.local.json'), JSON.stringify({ upstreamApiKey: 'test-key' }));
    writeFileSync(
      join(dir, 'config', 'model-catalog.json'),
      readFileSync(new URL('../config/model-catalog.json', import.meta.url), 'utf8'),
    );

    const context = createLaunchContext({ dir });
    assert.equal(context.promptLanguage, 'en');
    assert.deepEqual(context.models, ['deepseek-v4-flash', 'deepseek-v4-flash-vision-exp', 'deepseek-v4-pro']);
    assert.equal(context.modelCatalogPath.endsWith(join('config', 'model-catalog.json')), true);
    assert.equal(context.modelDescriptions['deepseek-v4-flash'], 'Fast and cost-efficient agentic model for everyday work.');
    assert.deepEqual(context.reasoningEfforts['deepseek-v4-flash'], ['low', 'high', 'max']);
    assert.equal(context.reasoningEffort, 'high');
    assert.equal(context.reasoningDescriptions['deepseek-v4-flash'].high, 'Deep reasoning for complex tasks');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  });
  await scenario('launch context uses Chinese Codex catalog when configured', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-launch-'));
  try {
    mkdirSync(join(dir, 'config'));
    writeFileSync(join(dir, 'config', 'gateway.local.json'), JSON.stringify({ upstreamApiKey: 'test-key', codexPromptLanguage: 'zh' }));
    writeFileSync(
      join(dir, 'config', 'model-catalog.zh.json'),
      readFileSync(new URL('../config/model-catalog.zh.json', import.meta.url), 'utf8'),
    );

    const context = createLaunchContext({ dir });
    assert.equal(context.promptLanguage, 'zh');
    assert.deepEqual(context.models, ['deepseek-v4-flash', 'deepseek-v4-flash-vision-exp', 'deepseek-v4-pro']);
    assert.equal(context.modelCatalogPath.endsWith(join('config', 'model-catalog.zh.json')), true);
    assert.equal(context.modelDescriptions['deepseek-v4-flash'], '面向日常工作的快速、经济型 Agent 模型。');
    assert.deepEqual(context.reasoningEfforts['deepseek-v4-flash'], ['low', 'high', 'max']);
    assert.equal(context.reasoningEffort, 'high');
    assert.equal(context.reasoningDescriptions['deepseek-v4-flash'].high, '深度推理，适合复杂任务');
    assert.ok(codexNewArgs(context).some((arg) => arg.includes('model-catalog.zh.json')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  });
  await scenario('launch context ignores reasoning effort from a different provider', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-launch-'));
  const previousConfigFile = process.env.CODEX_CONFIG_FILE;
  try {
    mkdirSync(join(dir, 'config'));
    writeFileSync(join(dir, 'config', 'gateway.local.json'), JSON.stringify({ upstreamApiKey: 'test-key' }));
    writeFileSync(
      join(dir, 'config', 'model-catalog.json'),
      readFileSync(new URL('../config/model-catalog.json', import.meta.url), 'utf8'),
    );
    const codexConfigFile = join(dir, 'config.toml');
    writeFileSync(codexConfigFile, 'model_provider = "other"\nmodel_reasoning_effort = "minimal"\n');
    process.env.CODEX_CONFIG_FILE = codexConfigFile;

    const context = createLaunchContext({ dir });
    assert.equal(context.reasoningEffort, 'high');
  } finally {
    if (previousConfigFile === undefined) delete process.env.CODEX_CONFIG_FILE;
    else process.env.CODEX_CONFIG_FILE = previousConfigFile;
    rmSync(dir, { recursive: true, force: true });
  }
  });
  await scenario('gateway Codex model catalogs satisfy the shared structural contract', async () => {
  const files = ['model-catalog.json', 'model-catalog.zh.json'];
  const expectedSlugs = ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4-flash-vision-exp'];
  const expectedEfforts = {
    'deepseek-v4-flash': ['low', 'high', 'max'],
    'deepseek-v4-flash-vision-exp': ['low', 'high', 'max'],
    'deepseek-v4-pro': ['low', 'high', 'max'],
  };
  const expectedPriorities = {
    'deepseek-v4-flash': 1,
    'deepseek-v4-flash-vision-exp': 3,
    'deepseek-v4-pro': 2,
  };
  assert.deepEqual(REASONING_EFFORTS, ['low', 'high', 'max']);
  const expectedModelDescriptions = {
    'model-catalog.json': [
      'Fast and cost-efficient agentic model for everyday work.',
      'Frontier agentic model for complex coding, reasoning, and knowledge-intensive work.',
      'Native multimodal Flash model for image-aware agentic work.',
    ],
    'model-catalog.zh.json': [
      '面向日常工作的快速、经济型 Agent 模型。',
      '面向复杂编程、深度推理与知识密集型工作的前沿 Agent 模型。',
      '原生多模态 Flash 模型，适用于图像感知 Agent 任务。',
    ],
  };
  const expectedDescriptions = {
    'model-catalog.json': {
      'deepseek-v4-flash': [
        'Fast responses with light reasoning',
        'Deep reasoning for complex tasks',
        'Maximum reasoning for the hardest agentic tasks',
      ],
      'deepseek-v4-pro': [
        'Fast responses with light reasoning',
        'Deep reasoning for complex tasks',
        'Maximum reasoning for the hardest agentic tasks',
      ],
      'deepseek-v4-flash-vision-exp': [
        'Fast responses with light reasoning',
        'Deep reasoning for complex tasks',
        'Maximum reasoning for the hardest agentic tasks',
      ],
    },
    'model-catalog.zh.json': {
      'deepseek-v4-flash': [
        '低思考强度，响应更快',
        '深度推理，适合复杂任务',
        '最大推理强度，适合最困难的 Agent 任务',
      ],
      'deepseek-v4-pro': [
        '低思考强度，响应更快',
        '深度推理，适合复杂任务',
        '最大推理强度，适合最困难的 Agent 任务',
      ],
      'deepseek-v4-flash-vision-exp': [
        '低推理强度，响应更快',
        '深度推理，适合复杂任务',
        '最大推理强度，适合最困难的 Agent 任务',
      ],
    },
  };
  const expectedPersonalityKeys = ['personality_default', 'personality_friendly', 'personality_pragmatic'];
  const expectedIntro = {
    'model-catalog.json': 'powered by the DeepSeek model',
    'model-catalog.zh.json': '由 DeepSeek 模型驱动',
  };
  const expectedEncodingRule = {
    'model-catalog.json': 'if Chinese text appears garbled, try `-Encoding UTF8`',
    'model-catalog.zh.json': '如出现中文乱码，尝试使用 `-Encoding UTF8`',
  };

  for (const file of files) {
    const raw = readFileSync(new URL(`../config/${file}`, import.meta.url), 'utf8');
    assert.equal(/(?:\u0000|\uFFFD|\?{4,})/u.test(raw), false);
      assert.equal(raw.includes('/abs/path'), false);
      assert.equal(/backing model is DeepSeek|背后的模型是 DeepSeek/u.test(raw), false);
      assert.equal(raw.includes(expectedIntro[file]), true);
      assert.equal(raw.includes(expectedEncodingRule[file]), true);
      assert.equal(/always pass `-Encoding UTF8`|始终带上 `-Encoding UTF8`/u.test(raw), false);
      const catalog = JSON.parse(raw);
    assert.deepEqual(catalog.models.map((model) => model.slug), expectedSlugs);
    assert.deepEqual(catalog.models.map((model) => model.description), expectedModelDescriptions[file]);

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
      assert.deepEqual(model.supported_reasoning_levels.map((level) => level.effort), expectedEfforts[model.slug]);
      assert.deepEqual(model.supported_reasoning_levels.map((level) => level.description), expectedDescriptions[file][model.slug]);
      assert.equal(model.default_reasoning_level, 'high');
      assert.equal(model.minimal_client_version, '0.144.0');
      assert.equal(model.priority, expectedPriorities[model.slug]);
      assert.equal('additional_speed_tiers' in model, false);
      assert.equal('service_tiers' in model, false);
      assert.equal(model.supports_reasoning_summaries, true);
      assert.equal(model.default_reasoning_summary, 'auto');
      assert.equal(model.supports_parallel_tool_calls, true);
      assert.equal(model.context_window, 1048576);
      assert.equal(model.max_context_window, 1048576);
      assert.equal(model.effective_context_window_percent, 95);
      assert.equal('auto_compact_token_limit' in model, false);
    }
  }
  });
});

test('interactive picker rendering and navigation', async () => {
  await scenario('renders bilingual catalog choices within real terminal widths', async () => {
  const stripAnsi = (row) => row.replace(/\x1b\[[0-9;]*m/g, '');
  const english = pickerChoiceRows(
    ['deepseek-v4-flash', 'deepseek-v4-flash-vision-exp', 'deepseek-v4-pro'],
    {
      'deepseek-v4-flash': 'Fast and cost-efficient agentic model for everyday work.',
    'deepseek-v4-flash-vision-exp': 'Native multimodal Flash model for image-aware agentic work.',
      'deepseek-v4-pro': 'Frontier agentic model for complex coding, reasoning, and knowledge-intensive work.',
    },
    60,
  );
  for (const row of english) {
    assert.ok(displayWidth(stripAnsi(row)) <= 58);
    assert.ok(2 + displayWidth(stripAnsi(row)) <= 60);
  }
  assert.match(stripAnsi(english[0]), /^deepseek-v4-flash\s+Fast and cost-efficient/);
  assert.match(stripAnsi(english[1]), /^deepseek-v4-flash-vision-exp\s+Native multimodal/);
  assert.match(stripAnsi(english[2]), /^deepseek-v4-pro\s+Frontier agentic model/);

  const chinese = pickerChoiceRows(
    ['deepseek-v4-flash', 'deepseek-v4-flash-vision-exp', 'deepseek-v4-pro'],
    {
      'deepseek-v4-flash': '面向日常工作的快速、经济型 Agent 模型。',
      'deepseek-v4-pro': '面向复杂编程、深度推理与知识密集型工作的前沿 Agent 模型。',
    },
    60,
  );
  for (const row of chinese) {
    assert.ok(displayWidth(stripAnsi(row)) <= 58);
  }
  assert.match(stripAnsi(chinese[0]), /^deepseek-v4-flash\s+/);
  assert.match(stripAnsi(chinese[1]), /^deepseek-v4-flash-vision-exp(?:\s+|$)/);
  assert.match(stripAnsi(chinese[2]), /^deepseek-v4-pro\s+/);

  assert.deepEqual(
    pickerChoiceRows(REASONING_EFFORTS, {
      low: '低思考强度，响应更快',
      high: '深度推理，适合复杂任务',
      max: '最大推理强度，适合最困难的 Agent 任务',
    }),
    [
      'low   \x1b[90m低思考强度，响应更快\x1b[0m',
      'high  \x1b[90m深度推理，适合复杂任务\x1b[0m',
      'max   \x1b[90m最大推理强度，适合最困难的 Agent 任务\x1b[0m',
    ],
  );
  assert.deepEqual(pickerChoiceRows(['a', 'bb'], { a: 'desc a', bb: 'desc bb' }, 6), ['a', 'bb']);
  });
  await scenario('localizes picker copy and missing-catalog guidance', async () => {
  assert.equal(pickerCopy('en').modelTitle, 'Choose gateway model');
  assert.equal(pickerCopy('en').reasoningTitle('deepseek-v4-pro'), 'Choose DeepSeek reasoning level for deepseek-v4-pro');
  assert.equal(pickerCopy('zh').modelTitle, '选择网关模型');
  assert.equal(pickerCopy('zh').reasoningTitle('deepseek-v4-pro'), '为 deepseek-v4-pro 选择 DeepSeek 推理强度');
  assert.equal(pickerCopy('invalid'), pickerCopy('en'));
  assert.equal(pickerCopy('en').unknownProvider, '(unknown)');
  assert.equal(pickerCopy('zh').unknownProvider, '(未知)');
  const englishContext = {
    ...context,
    installDir: 'C:\\install',
    modelCatalogPath: 'C:\\install\\config\\model-catalog.json',
    promptLanguage: 'en',
  };
  assert.equal(missingModelMessage(englishContext), 'No gateway models found in C:\\install\\config\\model-catalog.json\n');
  const chineseContext = {
    ...context,
    installDir: 'C:\\install',
    modelCatalogPath: 'C:\\install\\config\\model-catalog.zh.json',
    promptLanguage: 'zh',
  };
  assert.equal(missingModelMessage(chineseContext), '在 C:\\install\\config\\model-catalog.zh.json 未找到网关模型\n');
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
  await scenario('picker renders Chinese interface copy through the same mechanism', async () => {
  const moduleUrl = new URL('../src/codex-launch.js', import.meta.url).href;
  const script = `
    import { pick } from ${JSON.stringify(moduleUrl)};
    await pick('选择 Codex 会话', [], '日期  提供方  标题', {
      emptyMessage: '没有匹配的会话。',
      language: 'zh',
      shortcuts: [{ key: 'n', displayKey: 'N', action: 'new', label: '新建' }],
    });
    process.stdin.pause();
  `;
  const output = execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
    encoding: 'utf8',
    input: '\u001b',
  });
  const plain = output.replace(/\x1b\[[0-9;]*m/g, '');
  assert.match(plain, /选择 Codex 会话/);
  assert.match(plain, /没有匹配的会话。/);
  assert.match(plain, /N 新建 {4}↑\/↓ 选择 {4}← 返回 {4}Enter 确认 {4}Esc 退出/);
  });
  await scenario('new command renders Chinese catalog descriptions for model and reasoning choices', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-launch-picker-'));
  try {
    mkdirSync(join(dir, 'config'));
    writeFileSync(join(dir, 'config', 'gateway.local.json'), JSON.stringify({ codexPromptLanguage: 'zh' }));
    writeFileSync(
      join(dir, 'config', 'model-catalog.zh.json'),
      readFileSync(new URL('../config/model-catalog.zh.json', import.meta.url), 'utf8'),
    );
    const moduleUrl = new URL('../src/codex-launch.js', import.meta.url).href;
    const script = `
      import { newConversation } from ${JSON.stringify(moduleUrl)};
      Object.defineProperty(process.stdin, 'isTTY', { value: true });
      Object.defineProperty(process.stdout, 'isTTY', { value: true });
      process.stdin.setRawMode = () => {};
      process.stdin.resume = () => {};
      process.stdin.pause = () => {};
      const keys = ['\\r', '\\u001b'];
      const sendKey = () => {
        process.stdin.emit('data', Buffer.from(keys.shift()));
        if (keys.length) setTimeout(sendKey, 30);
      };
      setTimeout(sendKey, 30);
      await newConversation({ dir: ${JSON.stringify(dir)} });
    `;
    const output = execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.match(output, /选择网关模型/);
    assert.match(output, /面向日常工作的快速、经济型 Agent 模型。/);
    assert.match(output, /面向复杂编程、深度推理/);
    assert.match(output, /\x1b\[38;2;57;100;254m> deepseek-v4-flash\s+面向日常工作的快速、经济型 Agent 模型。\x1b\[0m/);
    assert.match(output, /deepseek-v4-pro\s+\x1b\[90m面向复杂编程、深度推理/);
    assert.match(output, /为 deepseek-v4-flash 选择 DeepSeek 推理强度/);
    assert.match(output, /低思考强度，响应更快/);
    assert.match(output, /深度推理，适合复杂任务/);
    assert.match(output, /最大推理强度，适合最困难的 Agent 任务/);
    assert.match(output, /\x1b\[38;2;57;100;254m> low {3}低思考强度，响应更快\x1b\[0m/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  });
});

test('codex executable resolution and real launches', async () => {
  await scenario('npm-managed installs resolve the vendor binary and launch it with managed env', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-exec-'));
  try {
    const fake = prepareFakeCodex(root);
    if (!fake) return;
    const moduleUrl = new URL('../src/codex-launch.js', import.meta.url).href;
    const script = `
      import { codexProcessEnv, resolveCodexExecutable, runCodex } from ${JSON.stringify(moduleUrl)};
      const env = codexProcessEnv();
      console.log(JSON.stringify({
        executable: resolveCodexExecutable(),
        managedByNpm: env.CODEX_MANAGED_BY_NPM,
        packageRoot: env.CODEX_MANAGED_PACKAGE_ROOT,
      }));
      await runCodex(['-e', 'console.log("fake codex ran as managed=" + process.env.CODEX_MANAGED_BY_NPM)']);
      const launchedExitCode = process.exitCode;
      await runCodex(['-e', 'process.exit(7)']);
      console.log(JSON.stringify({ launchedExitCode, propagatedExitCode: process.exitCode }));
      process.exitCode = 0;
    `;
    const output = execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
      encoding: 'utf8',
      env: pathOnlyEnv(process.env, fake.shimDir),
      timeout: 20000,
    });
    const lines = output.trim().split(/\r?\n/);
    assert.deepEqual(JSON.parse(lines[0]), {
      executable: fake.vendorBinary,
      managedByNpm: '1',
      packageRoot: fake.packageRoot,
    });
    assert.match(output, /fake codex ran as managed=1/);
    assert.deepEqual(JSON.parse(lines.at(-1)), { launchedExitCode: 0, propagatedExitCode: 7 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  });
  await scenario('PATH fallback reports launch failures with exit code 1', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-exec-missing-'));
  try {
    mkdirSync(join(root, 'empty'));
    const moduleUrl = new URL('../src/codex-launch.js', import.meta.url).href;
    const script = `
      import { resolveCodexExecutable, runCodex } from ${JSON.stringify(moduleUrl)};
      console.log(JSON.stringify({ executable: resolveCodexExecutable() }));
      await runCodex(['--version']);
    `;
    let failure;
    try {
      execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
        encoding: 'utf8',
        env: pathOnlyEnv(process.env, join(root, 'empty')),
        timeout: 20000,
      });
    } catch (error) {
      failure = error;
    }
    assert.equal(failure?.status, 1);
    assert.equal(JSON.parse(String(failure.stdout).trim()).executable, 'codex');
    assert.match(String(failure.stderr), /Failed to launch codex: /);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  });
  await scenario('headless new conversations launch codex with gateway overrides', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-exec-new-'));
  try {
    const fake = prepareFakeCodex(root);
    if (!fake) return;
    const installDir = join(root, 'install');
    writeGatewayInstall(installDir);
    const env = pathOnlyEnv(process.env, fake.shimDir);
    env.CODEX_CONFIG_FILE = join(root, 'missing-codex-config.toml');
    let failure;
    try {
      execFileSync(process.execPath, ['bin/codex-deepseek-gateway.js', 'new', '--dir', installDir], {
        encoding: 'utf8',
        env,
        timeout: 20000,
      });
    } catch (error) {
      failure = error;
    }
    assert.equal(failure?.status, 1);
    assert.match(String(failure.stderr), /model_provider="deepseek-gateway"/);
    assert.doesNotMatch(String(failure.stdout), /Choose gateway model/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  });
  await scenario('new conversations without gateway models print install guidance', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-exec-empty-'));
  try {
    const installDir = join(root, 'install');
    writeGatewayInstall(installDir, { models: [] });
    const env = pathOnlyEnv(process.env, join(root, 'install'));
    env.CODEX_CONFIG_FILE = join(root, 'missing-codex-config.toml');
    const output = execFileSync(process.execPath, ['bin/codex-deepseek-gateway.js', 'new', '--dir', installDir], {
      encoding: 'utf8',
      env,
      timeout: 20000,
    });
    assert.match(output, /No gateway models found in /);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  });
  await scenario('arrow-key navigation selects a different model and reasoning before launching', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-exec-picker-'));
  try {
    const fake = prepareFakeCodex(root);
    if (!fake) return;
    const installDir = join(root, 'install');
    writeGatewayInstall(installDir);
    const moduleUrl = new URL('../src/codex-launch.js', import.meta.url).href;
    const script = `
      import { newConversation } from ${JSON.stringify(moduleUrl)};
      Object.defineProperty(process.stdin, 'isTTY', { value: true });
      Object.defineProperty(process.stdout, 'isTTY', { value: true });
      process.stdin.setRawMode = () => {};
      process.stdin.resume = () => {};
      process.stdin.pause = () => {};
      const keys = ['\\u001b[B', '\\u001b[B', '\\r', '\\u001b[B', '\\u001b[B', '\\u001b[A', '\\r'];
      const sendKey = () => {
        process.stdin.emit('data', Buffer.from(keys.shift()));
        if (keys.length) setTimeout(sendKey, 30);
      };
      setTimeout(sendKey, 30);
      await newConversation({ dir: ${JSON.stringify(installDir)} });
    `;
    const env = pathOnlyEnv(process.env, fake.shimDir);
    env.CODEX_CONFIG_FILE = join(root, 'missing-codex-config.toml');
    let failure;
    try {
      execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
        encoding: 'utf8',
        env,
        timeout: 20000,
      });
    } catch (error) {
      failure = error;
    }
    assert.equal(failure?.status, 1);
    assert.match(String(failure.stdout), /\x1b\[38;2;57;100;254m> deepseek-v4-pro /);
    assert.match(String(failure.stdout), /Choose DeepSeek reasoning level for deepseek-v4-pro/);
    assert.match(String(failure.stdout), /\x1b\[38;2;57;100;254m> high /);
    assert.match(String(failure.stderr), /model_provider="deepseek-gateway"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  });
});
