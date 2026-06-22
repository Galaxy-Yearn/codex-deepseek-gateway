import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const packageJson = require('../package.json');

test('prints package version', () => {
  const output = execFileSync(process.execPath, ['bin/codex-deepseek-gateway.js', '--version'], {
    encoding: 'utf8',
  });
  assert.equal(output.trim(), packageJson.version);
});
