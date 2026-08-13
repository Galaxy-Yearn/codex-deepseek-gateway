import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { chmod, cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
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

function freePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForHttp(url) {
  for (let index = 0; index < 40; index += 1) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  throw new Error(`Server did not become reachable at ${url}`);
}

async function stopHttpChild(url, child) {
  if (!processExists(child.pid)) return;
  const exited = new Promise((resolveExit) => child.once('exit', resolveExit));
  try {
    await fetch(url);
  } catch {
  }
  await Promise.race([exited, new Promise((resolveDelay) => setTimeout(resolveDelay, 1000))]);
  if (processExists(child.pid)) process.kill(child.pid, 'SIGKILL');
}

async function prepareFakeLatest(root, version) {
  const shimDir = join(root, 'bin');
  const npmLog = join(root, 'npm.json');
  const fakeNpm = join(root, 'fake-npm.mjs');
  const globalRoot = join(root, 'global');
  const globalPackageDir = join(globalRoot, '@galaxy-yearn', 'codex-deepseek-gateway');
  await mkdir(shimDir, { recursive: true });
  await cp('bin', join(globalPackageDir, 'bin'), { recursive: true });
  await cp('src', join(globalPackageDir, 'src'), { recursive: true });
  await cp('config', join(globalPackageDir, 'config'), { recursive: true });
  await writeFile(join(globalPackageDir, 'package.json'), JSON.stringify({ ...packageJson, version }));
  await writeFile(fakeNpm, "import { existsSync, readFileSync, writeFileSync } from 'node:fs';\nconst args = process.argv.slice(2);\nconst calls = existsSync(process.env.FAKE_NPM_LOG) ? JSON.parse(readFileSync(process.env.FAKE_NPM_LOG, 'utf8')) : [];\ncalls.push(args);\nwriteFileSync(process.env.FAKE_NPM_LOG, JSON.stringify(calls));\nif (args[0] === 'root') process.stdout.write(process.env.FAKE_NPM_ROOT);\n");
  if (process.platform === 'win32') {
    await writeFile(join(shimDir, 'npm.cmd'), `@"${process.execPath}" "%FAKE_NPM_SCRIPT%" %*\r\n`);
  } else {
    const npmShim = join(shimDir, 'npm');
    await writeFile(npmShim, `#!/bin/sh\n"${process.execPath}" "$FAKE_NPM_SCRIPT" "$@"\n`);
    await chmod(npmShim, 0o755);
  }
  return {
    npmLog,
    env: {
      FAKE_NPM_LOG: npmLog,
      FAKE_NPM_ROOT: globalRoot,
      FAKE_NPM_SCRIPT: fakeNpm,
      PATH: `${shimDir}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH || ''}`,
    },
  };
}

test('CLI version and installation lifecycle', async () => {
  await scenario('prints package version', async () => {
  const output = execFileSync(process.execPath, ['bin/codex-deepseek-gateway.js', '--version'], {
    encoding: 'utf8',
  });
  assert.equal(output.trim(), packageJson.version);
  });
  await scenario('reports an available update without changing the requested command result', async () => {
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
  await scenario('install copies runtime assets and migrates local config without overwriting existing values or reasoning cache', async () => {
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
    await writeFile(join(dir, 'gateway.debug.log'), 'old debug');
    await writeFile(join(dir, 'gateway.debug.log.1'), 'older debug');
    await mkdir(join(dir, 'src'), { recursive: true });
    await writeFile(join(dir, 'src', 'stale.js'), 'stale');
    await writeFile(join(dir, 'config', 'model-aliases.json'), JSON.stringify({ stale: { model: 'stale' } }));
    await writeFile(join(dir, 'config', 'codex-model-catalog.json'), '{}');
    await writeFile(join(dir, 'config', 'codex-model-catalog.zh.json'), '{}');

    const env = { ...process.env };
    delete env.DEEPSEEK_API_KEY;
    delete env.UPSTREAM_API_KEY;
    delete env.GATEWAY_CONFIG_FILE;
    execFileSync(process.execPath, ['bin/codex-deepseek-gateway.js', 'install', '--no-edit', '--dir', dir], {
      encoding: 'utf8',
      env,
    });

    assert.deepEqual(JSON.parse(readFileSync(localConfigPath, 'utf8')), {
      ...localConfig,
      upstreamWireApi: 'chat_completions',
      visionEnabled: false,
      visionApiKey: '',
      visionBaseUrl: 'https://api.moonshot.cn/v1',
      visionModel: 'kimi-k3',
      visionReasoningEffort: 'high',
    });
    assert.equal(readFileSync(reasoningCachePath, 'utf8'), reasoningCache);
    assert.equal(existsSync(join(dir, 'bin', 'codex-deepseek-gateway.js')), true);
    assert.equal(existsSync(join(dir, 'src', 'server.js')), true);
    assert.equal(existsSync(join(dir, 'src', 'stale.js')), false);
    assert.equal(readFileSync(join(dir, 'gateway.debug.log'), 'utf8'), 'old debug');
    assert.equal(readFileSync(join(dir, 'gateway.debug.log.1'), 'utf8'), 'older debug');
    assert.equal(existsSync(join(dir, 'config', 'model-catalog.json')), true);
    assert.equal(existsSync(join(dir, 'config', 'model-catalog.zh.json')), true);
    assert.equal(existsSync(join(dir, 'config', 'codex-model-catalog.json')), false);
    assert.equal(existsSync(join(dir, 'config', 'codex-model-catalog.zh.json')), false);
    assert.equal(existsSync(join(dir, 'config', 'model-aliases.json')), false);
    assert.equal(existsSync(join(dir, 'config', 'frontend-design-guidance', 'en.md')), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  });
  await scenario('install preserves existing wire and vision settings', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gateway-cli-wire-api-'));
  try {
    await mkdir(join(dir, 'config'), { recursive: true });
    const localConfigPath = join(dir, 'config', 'gateway.local.json');
    await writeFile(localConfigPath, JSON.stringify({
      upstreamApiKey: 'sk-REPLACE_ME',
      upstreamWireApi: 'responses',
      visionEnabled: true,
      visionApiKey: 'existing-kimi-key',
      visionBaseUrl: 'https://vision.example/v1',
      visionModel: 'custom-vision-model',
      visionReasoningEffort: 'max',
    }));
    const env = { ...process.env };
    delete env.DEEPSEEK_API_KEY;
    delete env.UPSTREAM_API_KEY;
    delete env.GATEWAY_CONFIG_FILE;
    execFileSync(process.execPath, ['bin/codex-deepseek-gateway.js', 'install', '--no-edit', '--dir', dir], {
      encoding: 'utf8',
      env,
    });
    assert.deepEqual(JSON.parse(readFileSync(localConfigPath, 'utf8')), {
      upstreamApiKey: 'sk-REPLACE_ME',
      upstreamWireApi: 'responses',
      visionEnabled: true,
      visionApiKey: 'existing-kimi-key',
      visionBaseUrl: 'https://vision.example/v1',
      visionModel: 'custom-vision-model',
      visionReasoningEffort: 'max',
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  });
  await scenario('starts and gracefully stops an installed gateway with a private control token', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gateway-cli-lifecycle-'));
  const port = await freePort();
  const env = { ...process.env };
  delete env.DEEPSEEK_API_KEY;
  delete env.UPSTREAM_API_KEY;
  delete env.GATEWAY_CONFIG_FILE;
  delete env.GATEWAY_SHUTDOWN_TOKEN;
  try {
    await mkdir(join(dir, 'config'), { recursive: true });
    await writeFile(join(dir, 'config', 'gateway.local.json'), JSON.stringify({
      upstreamApiKey: 'test-key',
      host: '127.0.0.1',
      port,
      shutdownTimeoutMs: 1000,
    }));

    execFileSync(process.execPath, ['bin/codex-deepseek-gateway.js', 'install', '--no-edit', '--dir', dir], {
      encoding: 'utf8',
      env,
      timeout: 15000,
    });
    const processRecord = JSON.parse(readFileSync(join(dir, 'gateway.pid'), 'utf8'));
    assert.equal(processRecord.version, 3);
    assert.equal(Number.isSafeInteger(processRecord.pid), true);
    assert.match(processRecord.instanceId, /^[a-f0-9]{32}$/);
    assert.match(processRecord.controlUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.match(processRecord.shutdownToken, /^[a-f0-9]{64}$/);

    const running = JSON.parse(execFileSync(
      process.execPath,
      ['bin/codex-deepseek-gateway.js', 'status', '--json', '--dir', dir],
      { encoding: 'utf8', env, timeout: 5000 },
    ));
    assert.equal(running.state, 'healthy');
    assert.equal(running.process.authenticated, true);
    assert.equal(running.endpoint.reachable, true);

    const stopped = execFileSync(
      process.execPath,
      ['bin/codex-deepseek-gateway.js', 'stop', '--dir', dir],
      { encoding: 'utf8', env, timeout: 10000 },
    );
    assert.match(stopped, /Gateway stopped/);
    assert.equal(existsSync(join(dir, 'gateway.pid')), false);
  } finally {
    try {
      execFileSync(process.execPath, ['bin/codex-deepseek-gateway.js', 'stop', '--dir', dir], {
        encoding: 'utf8',
        env,
        timeout: 5000,
      });
    } catch {
    }
    await rm(dir, { recursive: true, force: true });
  }
  });
  await scenario('requires explicit force before terminating an unauthenticated legacy PID', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gateway-cli-force-'));
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  try {
    await mkdir(join(dir, 'config'), { recursive: true });
    await writeFile(join(dir, 'config', 'gateway.local.json'), JSON.stringify({
      host: '127.0.0.1',
      port: await freePort(),
    }));
    await writeFile(join(dir, 'gateway.pid'), String(child.pid));
    assert.equal(processExists(child.pid), true);

    assert.throws(() => execFileSync(
      process.execPath,
      ['bin/codex-deepseek-gateway.js', 'stop', '--dir', dir],
      { encoding: 'utf8', timeout: 5000 },
    ), /could not be authenticated/);
    assert.equal(processExists(child.pid), true);

    execFileSync(
      process.execPath,
      ['bin/codex-deepseek-gateway.js', 'stop', '--force', '--dir', dir],
      { encoding: 'utf8', timeout: 5000 },
    );
    assert.equal(processExists(child.pid), false);
  } finally {
    if (processExists(child.pid)) process.kill(child.pid, 'SIGKILL');
    await rm(dir, { recursive: true, force: true });
  }
  });
  await scenario('updates through npm latest, reinstalls, and verifies the gateway', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gateway-cli-update-'));
  const dir = join(root, 'install');
  const updatedVersion = '9.9.9-test';
  const fakeLatest = await prepareFakeLatest(root, updatedVersion);
  const port = await freePort();
  const upstreamPort = await freePort();
  const upstream = spawn(process.execPath, ['-e', `const server=require('node:http').createServer((request,response)=>{if(request.url==='/shutdown'){response.end();server.close(()=>process.exit(0));return}response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify({data:[{id:'deepseek-v4-flash'},{id:'deepseek-v4-pro'}]}))});server.listen(${upstreamPort},'127.0.0.1')`], {
    stdio: 'ignore',
    windowsHide: true,
  });
  const env = {
    ...process.env,
    ...fakeLatest.env,
  };
  delete env.DEEPSEEK_API_KEY;
  delete env.UPSTREAM_API_KEY;
  delete env.GATEWAY_CONFIG_FILE;
  try {
    await waitForHttp(`http://127.0.0.1:${upstreamPort}/models`);
    await mkdir(join(dir, 'config'), { recursive: true });
    const codexConfigFile = join(root, 'config.toml');
    await writeFile(codexConfigFile, `[model_providers.deepseek-gateway]\nname = "DeepSeek"\nbase_url = "http://127.0.0.1:${port}/v1"\nwire_api = "responses"\n`);
    env.CODEX_CONFIG_FILE = codexConfigFile;
    const localConfig = {
      upstreamApiKey: 'test-key',
      upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}`,
      host: '127.0.0.1',
      port,
      shutdownTimeoutMs: 1000,
      customUserValue: 'keep',
    };
    const reasoningCache = '{"version":1,"callIds":["call_existing"],"message":{"role":"assistant","reasoning_content":"keep","tool_calls":[]}}\n';
    await writeFile(join(dir, 'config', 'gateway.local.json'), JSON.stringify(localConfig));
    await mkdir(join(dir, 'state'), { recursive: true });
    await writeFile(join(dir, 'state', 'reasoning-cache.jsonl'), reasoningCache);
    execFileSync(process.execPath, ['bin/codex-deepseek-gateway.js', 'install', '--no-edit', '--dir', dir], {
      encoding: 'utf8',
      env,
      timeout: 15000,
    });
    const oldPid = JSON.parse(readFileSync(join(dir, 'gateway.pid'), 'utf8')).pid;

    const output = execFileSync(
      process.execPath,
      ['bin/codex-deepseek-gateway.js', 'update', '--dir', dir],
      { encoding: 'utf8', env, timeout: 30000 },
    );
    assert.deepEqual(JSON.parse(readFileSync(fakeLatest.npmLog, 'utf8')), [
      ['install', '-g', `${packageJson.name}@latest`],
      ['root', '-g'],
    ]);
    assert.match(output, /Installing @galaxy-yearn\/codex-deepseek-gateway@latest/);
    assert.doesNotMatch(output, /Gateway status:/);
    assert.doesNotMatch(output, /Gateway doctor:/);
    assert.doesNotMatch(output, new RegExp(`Version: ${updatedVersion}`));
    assert.equal(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version, updatedVersion);
    const newPid = JSON.parse(readFileSync(join(dir, 'gateway.pid'), 'utf8')).pid;
    assert.notEqual(newPid, oldPid);
    assert.equal(processExists(oldPid), false);
    assert.equal(processExists(newPid), true);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'config', 'gateway.local.json'), 'utf8')), {
      ...localConfig,
      upstreamWireApi: 'chat_completions',
      visionEnabled: false,
      visionApiKey: '',
      visionBaseUrl: 'https://api.moonshot.cn/v1',
      visionModel: 'kimi-k3',
      visionReasoningEffort: 'high',
    });
    assert.equal(readFileSync(join(dir, 'state', 'reasoning-cache.jsonl'), 'utf8'), reasoningCache);
  } finally {
    await stopHttpChild(`http://127.0.0.1:${upstreamPort}/shutdown`, upstream);
    try {
      execFileSync(process.execPath, ['bin/codex-deepseek-gateway.js', 'stop', '--dir', dir], {
        encoding: 'utf8',
        env,
        timeout: 5000,
      });
    } catch {
    }
    await rm(root, { recursive: true, force: true });
  }
  });
  await scenario('rejects another healthy process as update verification', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gateway-cli-update-foreign-'));
  const dir = join(root, 'install');
  const fakeLatest = await prepareFakeLatest(root, '9.9.9-test');
  const port = await freePort();
  const foreign = spawn(process.execPath, ['-e', `const server=require('node:http').createServer((request,response)=>{if(request.url==='/shutdown'){response.end();server.close(()=>process.exit(0));return}response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify({ok:true}))});server.listen(${port},'127.0.0.1')`], {
    stdio: 'ignore',
    windowsHide: true,
  });
  const env = { ...process.env, ...fakeLatest.env };
  delete env.DEEPSEEK_API_KEY;
  delete env.UPSTREAM_API_KEY;
  delete env.GATEWAY_CONFIG_FILE;
  try {
    await waitForHttp(`http://127.0.0.1:${port}/health`);
    await mkdir(join(dir, 'config'), { recursive: true });
    await writeFile(join(dir, 'config', 'gateway.local.json'), JSON.stringify({
      upstreamApiKey: 'test-key',
      host: '127.0.0.1',
      port,
    }));
    execFileSync(process.execPath, ['bin/codex-deepseek-gateway.js', 'install', '--no-edit', '--dir', dir], {
      encoding: 'utf8',
      env,
      timeout: 5000,
    });
    assert.throws(() => execFileSync(
      process.execPath,
      ['bin/codex-deepseek-gateway.js', 'update', '--dir', dir],
      { encoding: 'utf8', env, timeout: 30000 },
    ), /gateway status failed with exit code 1/);
  } finally {
    await stopHttpChild(`http://127.0.0.1:${port}/shutdown`, foreign);
    await rm(root, { recursive: true, force: true });
  }
  });
  await scenario('refuses unsafe or unconfigured update targets before invoking npm', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gateway-cli-update-invalid-'));
  const arbitraryDir = join(root, 'arbitrary');
  const installedDir = join(root, 'installed');
  const fakeLatest = await prepareFakeLatest(root, '9.9.9-test');
  const env = { ...process.env };
  Object.assign(env, fakeLatest.env);
  delete env.DEEPSEEK_API_KEY;
  delete env.UPSTREAM_API_KEY;
  delete env.GATEWAY_CONFIG_FILE;
  try {
    await mkdir(join(arbitraryDir, 'config'), { recursive: true });
    await mkdir(join(arbitraryDir, 'bin'), { recursive: true });
    await mkdir(join(arbitraryDir, 'src'), { recursive: true });
    await writeFile(join(arbitraryDir, 'package.json'), JSON.stringify({ name: 'another-project' }));
    await writeFile(join(arbitraryDir, 'bin', 'codex-deepseek-gateway.js'), 'keep');
    await writeFile(join(arbitraryDir, 'src', 'server.js'), 'keep');
    await writeFile(join(arbitraryDir, 'config', 'gateway.local.json'), JSON.stringify({ upstreamApiKey: 'test-key' }));
    await writeFile(join(arbitraryDir, 'src', 'keep.txt'), 'keep');
    assert.throws(() => execFileSync(
      process.execPath,
      ['bin/codex-deepseek-gateway.js', 'update', '--dir', arbitraryDir],
      { encoding: 'utf8', env, timeout: 5000 },
    ), /Missing runtime/);
    assert.equal(readFileSync(join(arbitraryDir, 'src', 'keep.txt'), 'utf8'), 'keep');
    assert.equal(existsSync(fakeLatest.npmLog), false);

    execFileSync(process.execPath, ['bin/codex-deepseek-gateway.js', 'install', '--no-edit', '--dir', installedDir], {
      encoding: 'utf8',
      env,
      timeout: 5000,
    });
    assert.throws(() => execFileSync(
      process.execPath,
      ['bin/codex-deepseek-gateway.js', 'update', '--dir', installedDir],
      { encoding: 'utf8', env, timeout: 5000 },
    ), /Missing DeepSeek API key/);
    assert.equal(existsSync(fakeLatest.npmLog), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  });
  await scenario('help output, unknown commands, and invalid options fail fast', async () => {
  const runCli = (args) => execFileSync(process.execPath, ['bin/codex-deepseek-gateway.js', ...args], {
    encoding: 'utf8',
    timeout: 20000,
  });
  for (const helpArgs of [['help'], []]) {
    const usage = runCli(helpArgs);
    assert.match(usage, /Usage:/);
    assert.match(usage, /codex-deepseek-gateway sessions/);
    assert.match(usage, /codex-deepseek-gateway uninstall/);
    assert.match(usage, /--reasoning-effort <level>/);
  }
  const failures = [
    [['frobnicate'], /Unknown command: frobnicate/],
    [['--dir'], /--dir requires a path/],
    [['sessions', '--limit', '0'], /--limit requires a positive integer/],
    [['sessions', '--model'], /--model requires a model id/],
    [['sessions', '--provider'], /--provider requires a provider id/],
    [['sessions', '--reasoning-effort'], /--reasoning-effort requires a reasoning effort/],
    [['sessions', '--exec'], /--exec requires a session id/],
    [['new', '--print'], /--print is only supported with sessions/],
  ];
  for (const [args, pattern] of failures) {
    let failure;
    try {
      runCli(args);
    } catch (error) {
      failure = error;
    }
    assert.equal(failure?.status, 1, args.join(' '));
    assert.match(String(failure.stderr), pattern);
  }
  });
  await scenario('start guards missing runtimes, missing keys, and occupied endpoints', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gateway-cli-start-'));
  const env = { ...process.env };
  delete env.DEEPSEEK_API_KEY;
  delete env.UPSTREAM_API_KEY;
  delete env.GATEWAY_CONFIG_FILE;
  const runCli = (args) => execFileSync(process.execPath, ['bin/codex-deepseek-gateway.js', ...args], {
    encoding: 'utf8',
    env,
    timeout: 20000,
  });
  const dir = join(root, 'install');
  try {
    let failure;
    try {
      runCli(['start', '--dir', join(root, 'missing')]);
    } catch (error) {
      failure = error;
    }
    assert.equal(failure?.status, 1);
    assert.match(String(failure.stderr), /Missing runtime at .*\. Run install first\./);

    const installed = runCli(['install', '--no-edit', '--dir', dir]);
    assert.match(installed, /Edit this file and put your DeepSeek API key:/);
    failure = undefined;
    try {
      runCli(['start', '--dir', dir]);
    } catch (error) {
      failure = error;
    }
    assert.equal(failure?.status, 1);
    assert.match(String(failure.stderr), /Missing DeepSeek API key/);

    failure = undefined;
    try {
      runCli(['doctor', '--json', '--dir', dir]);
    } catch (error) {
      failure = error;
    }
    assert.equal(failure?.status, 1);
    const doctorReport = JSON.parse(String(failure.stdout));
    assert.equal(doctorReport.overallStatus, 'fail');
    assert.equal(doctorReport.checks['config.gateway'].status, 'fail');
    assert.match(doctorReport.checks['config.gateway'].summary, /DeepSeek API key is missing/);
    assert.equal(doctorReport.checks['upstream.models'].status, 'skipped');

    const unroutablePort = await freePort();
    await writeFile(join(dir, 'config', 'gateway.local.json'), JSON.stringify({
      upstreamApiKey: 'test-key',
      host: '203.0.113.99',
      port: unroutablePort,
    }));
    failure = undefined;
    try {
      runCli(['start', '--dir', dir]);
    } catch (error) {
      failure = error;
    }
    assert.equal(failure?.status, 1);
    assert.match(String(failure.stderr), /Gateway did not become reachable on http:\/\/203\.0\.113\.99:\d+/);
    assert.equal(existsSync(join(dir, 'gateway.pid')), false);

    const port = await freePort();
    await writeFile(join(dir, 'config', 'gateway.local.json'), JSON.stringify({
      upstreamApiKey: 'test-key',
      host: '127.0.0.1',
      port,
      shutdownTimeoutMs: 1000,
    }));
    assert.match(runCli(['start', '--dir', dir]), /Gateway started\. PID \d+/);
    assert.match(runCli(['start', '--dir', dir]), /Gateway is already running\./);
    assert.match(runCli(['stop', '--dir', dir]), /Gateway stopped\./);
    assert.match(runCli(['stop', '--dir', dir]), /Gateway stopped\./);

    const orphan = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    try {
      await writeFile(join(dir, 'gateway.pid'), String(orphan.pid));
      failure = undefined;
      try {
        runCli(['start', '--dir', dir]);
      } catch (error) {
        failure = error;
      }
      assert.equal(failure?.status, 1);
      assert.match(String(failure.stderr), new RegExp(`Recorded PID ${orphan.pid} cannot be authenticated`));
    } finally {
      if (processExists(orphan.pid)) process.kill(orphan.pid, 'SIGKILL');
    }
    await rm(join(dir, 'gateway.pid'), { force: true });

    const foreignPort = await freePort();
    const foreign = spawn(process.execPath, ['-e', `const server=require('node:http').createServer((request,response)=>{if(request.url==='/shutdown'){response.end();server.close(()=>process.exit(0));return}response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify({ok:true}))});server.listen(${foreignPort},'127.0.0.1')`], {
      stdio: 'ignore',
      windowsHide: true,
    });
    try {
      await waitForHttp(`http://127.0.0.1:${foreignPort}/health`);
      await writeFile(join(dir, 'config', 'gateway.local.json'), JSON.stringify({
        upstreamApiKey: 'test-key',
        host: '127.0.0.1',
        port: foreignPort,
      }));
      assert.match(
        runCli(['start', '--dir', dir]),
        /Gateway is already reachable at http:\/\/127\.0\.0\.1:\d+\. Another install may already be running\./,
      );
      assert.match(
        runCli(['stop', '--dir', dir]),
        /No gateway process is recorded for this install\. http:\/\/127\.0\.0\.1:\d+ is still reachable, likely from another install\./,
      );
    } finally {
      await stopHttpChild(`http://127.0.0.1:${foreignPort}/shutdown`, foreign);
    }
  } finally {
    try {
      runCli(['stop', '--force', '--dir', dir]);
    } catch {
    }
    await rm(root, { recursive: true, force: true });
  }
  });
  await scenario('uninstall stops the gateway and removes only real installs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gateway-cli-uninstall-'));
  const env = { ...process.env };
  delete env.DEEPSEEK_API_KEY;
  delete env.UPSTREAM_API_KEY;
  delete env.GATEWAY_CONFIG_FILE;
  const runCli = (args, cliPath = 'bin/codex-deepseek-gateway.js') => execFileSync(process.execPath, [cliPath, ...args], {
    encoding: 'utf8',
    env,
    timeout: 20000,
  });
  const dir = join(root, 'install');
  try {
    assert.match(runCli(['uninstall', '--dir', join(root, 'missing')]), /No install found at /);

    const checkoutDir = join(root, 'checkout');
    await cp('bin', join(checkoutDir, 'bin'), { recursive: true });
    await cp('src', join(checkoutDir, 'src'), { recursive: true });
    await cp('package.json', join(checkoutDir, 'package.json'));
    let failure;
    try {
      runCli(['uninstall', '--dir', checkoutDir], join(checkoutDir, 'bin', 'codex-deepseek-gateway.js'));
    } catch (error) {
      failure = error;
    }
    assert.equal(failure?.status, 1);
    assert.match(String(failure.stderr), /Refusing to remove source checkout /);
    assert.equal(existsSync(join(checkoutDir, 'src')), true);

    const foreignDir = join(root, 'not-gateway');
    await mkdir(join(foreignDir, 'bin'), { recursive: true });
    await mkdir(join(foreignDir, 'src'), { recursive: true });
    await writeFile(join(foreignDir, 'package.json'), '{broken');
    await writeFile(join(foreignDir, 'bin', 'codex-deepseek-gateway.js'), 'keep');
    await writeFile(join(foreignDir, 'src', 'server.js'), 'keep');
    failure = undefined;
    try {
      runCli(['uninstall', '--dir', foreignDir]);
    } catch (error) {
      failure = error;
    }
    assert.equal(failure?.status, 1);
    assert.match(String(failure.stderr), /Refusing to remove .*not-gateway/);
    assert.equal(existsSync(join(foreignDir, 'src', 'server.js')), true);

    const port = await freePort();
    await mkdir(join(dir, 'config'), { recursive: true });
    await writeFile(join(dir, 'config', 'gateway.local.json'), JSON.stringify({
      upstreamApiKey: 'test-key',
      host: '127.0.0.1',
      port,
      shutdownTimeoutMs: 1000,
    }));
    runCli(['install', '--no-edit', '--dir', dir]);
    const pid = JSON.parse(readFileSync(join(dir, 'gateway.pid'), 'utf8')).pid;
    assert.equal(processExists(pid), true);
    const removed = runCli(['uninstall', '--dir', dir]);
    assert.match(removed, /Gateway stopped\./);
    assert.match(removed, /Removed /);
    assert.equal(existsSync(dir), false);
    assert.equal(processExists(pid), false);
  } finally {
    try {
      runCli(['stop', '--force', '--dir', dir]);
    } catch {
    }
    await rm(root, { recursive: true, force: true });
  }
  });
});
