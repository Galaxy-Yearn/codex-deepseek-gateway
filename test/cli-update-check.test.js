import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const require = createRequire(import.meta.url);
const packageJson = require('../package.json');

test('interactive CLI reports an available update on stderr', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gateway-update-check-'));
  const preload = join(dir, 'preload.mjs');
  try {
    await writeFile(preload, `Object.defineProperty(process.stderr, 'isTTY', { value: true });\nglobalThis.fetch = async () => ({ ok: true, json: async () => ({ name: ${JSON.stringify(packageJson.name)}, version: '9.9.9' }) });\n`);
    const result = spawnSync(
      process.execPath,
      ['--import', pathToFileURL(preload).href, resolve('bin/codex-deepseek-gateway.js'), '--version'],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), packageJson.version);
    assert.equal(
      result.stderr,
      'New version 9.9.9 available. Run `codex-deepseek-gateway update` to update.\n',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
