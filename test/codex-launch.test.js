import assert from 'node:assert/strict';
import test from 'node:test';
import {
  codexNewArgs,
  codexNewCommand,
  codexResumeArgs,
  codexResumeCommand,
} from '../src/codex-launch.js';

const context = {
  provider: 'deepseek-gateway',
  model: 'deepseek-v4-flash',
  reasoningEffort: 'high',
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
  ]);

  assert.deepEqual(codexResumeArgs('session-1', context), [
    'resume',
    'session-1',
    ...codexNewArgs(context),
  ]);
});

test('printed codex commands include reasoning summary overrides', () => {
  assert.equal(
    codexNewCommand(context),
    'codex -c model_provider=deepseek-gateway -c model=deepseek-v4-flash -c model_reasoning_effort=high -c model_supports_reasoning_summaries=true -c model_reasoning_summary=auto',
  );
  assert.equal(
    codexResumeCommand('session-1', context),
    'codex resume session-1 -c model_provider=deepseek-gateway -c model=deepseek-v4-flash -c model_reasoning_effort=high -c model_supports_reasoning_summaries=true -c model_reasoning_summary=auto',
  );
});
