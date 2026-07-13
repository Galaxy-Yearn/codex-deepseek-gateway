import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
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

const require = createRequire(import.meta.url);
const packageJson = require('../package.json');

test('CLI version and installation lifecycle', async () => {
  await scenario('prints package version', async () => {
  const output = execFileSync(process.execPath, ['bin/codex-deepseek-gateway.js', '--version'], {
    encoding: 'utf8',
  });
  assert.equal(output.trim(), packageJson.version);
  });
  await scenario('install copies runtime assets without overwriting local config or reasoning cache', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gateway-cli-install-'));
  try {
    await mkdir(join(dir, 'config'), { recursive: true });
    await mkdir(join(dir, 'state'), { recursive: true });
    const localConfigPath = join(dir, 'config', 'gateway.local.json');
    const reasoningCachePath = join(dir, 'state', 'reasoning-cache.jsonl');
    const localConfig = {
      upstreamApiKey: 'sk-REPLACE_ME',
      codexPromptLanguage: 'zh',
      customUserValue: 'keep',
    };
    const reasoningCache = '{"version":1,"callIds":["call_existing"],"message":{"role":"assistant","reasoning_content":"keep","tool_calls":[]}}\n';
    await writeFile(localConfigPath, JSON.stringify(localConfig, null, 2));
    await writeFile(reasoningCachePath, reasoningCache);
    await writeFile(join(dir, 'src-stale.txt'), 'leave unrelated files alone');
    await mkdir(join(dir, 'src'), { recursive: true });
    await writeFile(join(dir, 'src', 'stale.js'), 'stale');
    await writeFile(join(dir, 'config', 'model-aliases.json'), JSON.stringify({ stale: { model: 'stale' } }));

    const env = { ...process.env };
    delete env.DEEPSEEK_API_KEY;
    delete env.UPSTREAM_API_KEY;
    delete env.GATEWAY_CONFIG_FILE;
    execFileSync(process.execPath, ['bin/codex-deepseek-gateway.js', 'install', '--no-edit', '--dir', dir], {
      encoding: 'utf8',
      env,
    });

    assert.deepEqual(JSON.parse(readFileSync(localConfigPath, 'utf8')), localConfig);
    assert.equal(readFileSync(reasoningCachePath, 'utf8'), reasoningCache);
    assert.equal(existsSync(join(dir, 'bin', 'codex-deepseek-gateway.js')), true);
    assert.equal(existsSync(join(dir, 'src', 'server.js')), true);
    assert.equal(existsSync(join(dir, 'src', 'stale.js')), false);
    assert.equal(existsSync(join(dir, 'config', 'codex-model-catalog.json')), true);
    assert.equal(existsSync(join(dir, 'config', 'codex-model-catalog.zh.json')), true);
    assert.equal(existsSync(join(dir, 'config', 'frontend-design-guidance', 'en.md')), true);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'config', 'model-aliases.json'), 'utf8')), {
      'deepseek-v4-flash': {
        model: 'deepseek-v4-flash',
        thinking: 'auto',
      },
      'deepseek-v4-pro': {
        model: 'deepseek-v4-pro',
        thinking: 'auto',
      },
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  });
});
