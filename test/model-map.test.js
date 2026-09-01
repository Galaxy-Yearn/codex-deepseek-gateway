import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
import {
  DEFAULT_MODEL_ALIASES,
  deepseekReasoningPayload,
  isDeprecatedModel,
  listModels,
  loadModelAliases,
  mergeModelLists,
  normalizeModelList,
  resolveModelAlias,
} from '../src/model-map.js';

test('model alias loading and resolution', async () => {
  await scenario('loads model aliases with defaults, file values, and environment precedence', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gateway-model-map-'));
  const file = join(dir, 'aliases.json');
  const catalogFile = join(dir, 'model-catalog.json');
  await writeFile(catalogFile, JSON.stringify({
    models: [
      { slug: 'catalog-model' },
      { slug: 'shared' },
    ],
  }));
  await writeFile(file, JSON.stringify({
    'file-alias': 'deepseek-v4-pro',
    shared: { model: 'file-model', thinking: false },
  }));

  try {
    const aliases = loadModelAliases({
      MODEL_ALIASES_FILE: 'aliases.json',
      MODEL_ALIASES_JSON: JSON.stringify({
        'env-alias': { upstream_model: 'env-model', thinking_mode: 'thinking', effort: 'max' },
        shared: { model: 'env-model' },
      }),
    }, dir, catalogFile);

    assert.deepEqual(aliases['catalog-model'], { model: 'catalog-model', thinking: 'auto' });
    assert.equal(aliases['deepseek-v4-flash'], undefined);
    assert.equal(aliases['file-alias'], 'deepseek-v4-pro');
    assert.deepEqual(aliases.shared, { model: 'env-model' });
    assert.equal(resolveModelAlias('file-alias', { modelAliases: aliases }).upstreamModel, 'deepseek-v4-pro');
    assert.deepEqual(resolveModelAlias('env-alias', { modelAliases: aliases }), {
      alias: 'env-alias',
      upstreamModel: 'env-model',
      thinking: 'enabled',
      reasoningEffort: 'max',
      extraBody: {},
    });

    await mkdir(join(dir, 'config'));
    await writeFile(join(dir, 'config', 'model-aliases.json'), JSON.stringify({ ignored: 'ignored-model' }));
    const catalogOnly = loadModelAliases({}, dir, catalogFile);
    assert.equal(catalogOnly.ignored, undefined);
    assert.deepEqual(catalogOnly['catalog-model'], { model: 'catalog-model', thinking: 'auto' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  });
  await scenario('resolves alias shapes and preserves a compatible fallback for unknown models', async () => {
  const config = {
    upstreamModel: 'configured-default',
    modelAliases: {
      string: 'string-target',
      object: {
        upstreamModel: 'object-target',
        thinkingMode: 'non_thinking',
        reasoningEffort: 'max',
        extraBody: { seed: 7 },
      },
      invalid: 42,
    },
  };

  assert.deepEqual(resolveModelAlias('string', config), {
    alias: 'string',
    upstreamModel: 'string-target',
    thinking: 'auto',
    extraBody: {},
  });
  assert.deepEqual(resolveModelAlias('object', config), {
    alias: 'object',
    upstreamModel: 'object-target',
    thinking: 'disabled',
    reasoningEffort: 'max',
    extraBody: { seed: 7 },
  });
  assert.deepEqual(resolveModelAlias('unknown', config), {
    alias: 'unknown',
    upstreamModel: 'configured-default',
    thinking: 'auto',
    reasoningEffort: undefined,
    extraBody: {},
  });
  });
});

test('reasoning and model catalog mapping', async () => {
  await scenario('uses native DeepSeek reasoning levels and alias overrides', async () => {
  const cases = [
    [{ thinking: 'auto' }, 'none', { thinking: { type: 'disabled' } }],
    [{ thinking: 'auto' }, 'low', { thinking: { type: 'enabled' }, reasoning_effort: 'low' }],
    [{ thinking: 'auto' }, 'high', { thinking: { type: 'enabled' }, reasoning_effort: 'high' }],
    [{ thinking: 'auto' }, 'max', { thinking: { type: 'enabled' }, reasoning_effort: 'max' }],
    [{ thinking: 'enabled' }, 'low', { thinking: { type: 'enabled' }, reasoning_effort: 'low' }],
    [{ thinking: 'disabled', reasoningEffort: 'max' }, 'high', { thinking: { type: 'disabled' } }],
    [{ thinking: 'enabled', reasoningEffort: 'max' }, 'high', { thinking: { type: 'enabled' }, reasoning_effort: 'max' }],
  ];

  for (const [alias, effort, expected] of cases) {
    assert.deepEqual(deepseekReasoningPayload({ alias, reasoning: { effort } }), expected);
  }

  for (const effort of ['medium', 'xhigh', 'disabled', 'off', 'false', 'HIGH', '', 'unsupported']) {
    assert.throws(
      () => deepseekReasoningPayload({ alias: { thinking: 'auto' }, reasoning: { effort } }),
      (error) => error.code === 'invalid_reasoning_effort' && error.statusCode === 400,
    );
  }
  assert.throws(
    () => deepseekReasoningPayload({ alias: { thinking: 'auto', reasoningEffort: 'xhigh' } }),
    (error) => error.code === 'invalid_reasoning_effort' && error.statusCode === 400,
  );
  });
  await scenario('normalizes, filters, merges, and lists model catalogs deterministically', async () => {
  const legacyChat = ['deepseek', 'chat'].join('-');
  const legacyReasoner = ['deepseek', 'reasoner'].join('-');
  assert.equal(isDeprecatedModel(legacyChat), true);
  assert.equal(isDeprecatedModel(legacyReasoner), true);
  assert.equal(isDeprecatedModel('deepseek-v4-flash'), false);

  const normalized = normalizeModelList({
    data: [
      'z-model',
      { id: 'a-model', created: 10 },
      { id: legacyChat },
      { missing: true },
    ],
  }, { upstreamProvider: 'deepseek' });
  assert.deepEqual(normalized, [
    { id: 'z-model', object: 'model', created: 0 },
    { id: 'a-model', created: 10, object: 'model', owned_by: 'deepseek' },
  ]);

  const listed = listModels({
    upstreamProvider: 'deepseek',
    modelAliases: { 'z-model': {}, 'a-model': {}, [legacyReasoner]: {} },
    upstreamModels: ['a-model', 'm-model', legacyChat],
  });
  assert.deepEqual(listed.map((model) => model.id), ['a-model', 'm-model', 'z-model']);
  assert.equal(listed.every((model) => model.owned_by === 'deepseek'), true);

  const nativeListed = listModels({
    upstreamProvider: 'deepseek',
    upstreamWireApi: 'responses',
    modelAliases: DEFAULT_MODEL_ALIASES,
  });
  assert.deepEqual(nativeListed.map((model) => model.id), ['deepseek-v4-flash', 'deepseek-v4-flash-vision-exp', 'deepseek-v4-pro']);

  const merged = mergeModelLists(
    [{ id: 'z-model', source: 'first' }, { id: 'a-model' }],
    [{ id: 'z-model', source: 'second' }, { id: 'm-model' }, { id: legacyChat }],
  );
  assert.deepEqual(merged.map((model) => model.id), ['a-model', 'm-model', 'z-model']);
  assert.equal(merged.find((model) => model.id === 'z-model').source, 'first');
  });
});
