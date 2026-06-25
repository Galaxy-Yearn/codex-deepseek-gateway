import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  codexNewArgs,
  codexResumeArgs,
  codexResumeCommand,
  pickerWindow,
  resolveCodexExecutable,
} from '../src/codex-launch.js';

const context = {
  provider: 'deepseek-gateway',
  model: 'deepseek-v4-flash',
  reasoningEffort: 'high',
  modelCatalogPath: 'C:\\Users\\PC\\.codex\\deepseek-gateway\\config\\codex-model-catalog.json',
};

test('codex launch overrides enable reasoning summaries for custom models', () => {
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

test('printed resume commands quote config overrides', () => {
  assert.equal(
    codexResumeCommand('session-1', context),
    'codex resume session-1 -c \'model_provider="deepseek-gateway"\' -c \'model="deepseek-v4-flash"\' -c \'model_reasoning_effort="high"\' -c model_supports_reasoning_summaries=true -c \'model_reasoning_summary="auto"\' -c \'model_catalog_json="C:\\\\Users\\\\PC\\\\.codex\\\\deepseek-gateway\\\\config\\\\codex-model-catalog.json"\'',
  );
});

test('non-gateway launches do not force the gateway model catalog', () => {
  const other = {
    ...context,
    provider: 'duckcoding',
  };
  assert.equal(codexNewArgs(other).includes('model_catalog_json="C:\\\\Users\\\\PC\\\\.codex\\\\deepseek-gateway\\\\config\\\\codex-model-catalog.json"'), false);
  assert.equal(codexResumeCommand('session-1', other).includes('model_catalog_json='), false);
});

test('resolves Codex launcher without shell-only shims when available', () => {
  const executable = resolveCodexExecutable();
  assert.equal(typeof executable, 'string');
  assert.ok(executable.length > 0);
  assert.equal(/\.(?:cmd|bat|ps1)$/i.test(executable), false);
});

test('gateway Codex model catalog contains only DeepSeek aliases with Codex-compatible reasoning', () => {
  const catalog = JSON.parse(readFileSync(new URL('../config/codex-model-catalog.json', import.meta.url), 'utf8'));
  assert.deepEqual(catalog.models.map((model) => model.slug), ['deepseek-v4-flash', 'deepseek-v4-pro']);
  for (const model of catalog.models) {
    assert.equal(typeof model.base_instructions, 'string');
    assert.match(model.base_instructions, /You are Codex/);
    assert.equal(model.base_instructions.includes('based on GPT-5'), false);
    assert.equal(model.model_messages.instructions_template.includes('based on GPT-5'), false);
    assert.equal(model.description.includes('Gateway alias'), false);
    assert.equal(model.description.includes('coding'), false);
    assert.match(model.description, /^DeepSeek V4 /);
    assert.deepEqual(
      model.supported_reasoning_levels.map((level) => level.effort),
      ['low', 'medium', 'high', 'xhigh'],
    );
  }
});

test('picker window scrolls only when selection leaves the visible window', () => {
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
