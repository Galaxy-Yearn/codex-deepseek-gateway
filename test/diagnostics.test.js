import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  formatGatewayDoctor,
  formatGatewayStatus,
  gatewayDiagnosticPaths,
  inspectGatewayDoctor,
  inspectGatewayStatus,
} from '../src/diagnostics.js';
import { createControlServer, writeRuntimeRecord } from '../src/runtime.js';

async function listen(server) {
  return await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => resolveListen(server.address().port));
  });
}

async function close(server) {
  if (!server.listening) return;
  await new Promise((resolveClose) => server.close(() => resolveClose()));
}

async function fixture({ version = '1.2.3', host = '127.0.0.1' } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'gateway-diagnostics-'));
  const configDir = join(dir, 'config');
  const stateDir = join(dir, 'state');
  await mkdir(join(dir, 'bin'), { recursive: true });
  await mkdir(join(dir, 'src'), { recursive: true });
  await mkdir(configDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  await writeFile(join(dir, 'package.json'), JSON.stringify({ version }));
  await writeFile(join(dir, 'bin', 'codex-deepseek-gateway.js'), '');
  await writeFile(join(dir, 'src', 'server.js'), '');
  const catalog = {
    models: ['deepseek-v4-flash', 'deepseek-v4-pro'].map((slug) => ({
      slug,
      supported_reasoning_levels: ['low', 'high', 'max'].map((effort) => ({ effort })),
      instructions_variables: {
        personality_default: '',
        personality_friendly: '',
        personality_pragmatic: '',
      },
    })),
  };
  await writeFile(join(configDir, 'model-catalog.json'), JSON.stringify(catalog));
  await writeFile(join(configDir, 'model-catalog.zh.json'), JSON.stringify(catalog));

  const dataServer = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    if (request.url === '/health') response.end(JSON.stringify({ ok: true }));
    else response.end(JSON.stringify({ data: [{ id: 'deepseek-v4-flash' }, { id: 'deepseek-v4-pro' }] }));
  });
  const dataPort = await listen(dataServer);
  const dataUrl = `http://127.0.0.1:${dataPort}`;

  let controlServer;
  controlServer = createControlServer({
    token: 'private-token',
    instanceId: 'instance-1',
    onShutdown: () => close(controlServer),
    status: { packageVersion: version, startedAt: 1000, dataUrl },
  });
  const controlPort = await listen(controlServer);
  await writeRuntimeRecord(join(dir, 'gateway.pid'), {
    version: 3,
    pid: process.pid,
    instanceId: 'instance-1',
    controlUrl: `http://127.0.0.1:${controlPort}`,
    shutdownToken: 'private-token',
    startedAt: 1000,
    packageVersion: version,
    dataUrl,
  });
  return { dir, host, dataPort, dataServer, controlServer };
}

async function cleanup(value) {
  await close(value.controlServer);
  await close(value.dataServer);
  if (value.upstreamServer) await close(value.upstreamServer);
  await rm(value.dir, { recursive: true, force: true });
}

test('gateway diagnostics', async () => {
  const healthy = await fixture();
  try {
    const paths = gatewayDiagnosticPaths(healthy.dir);
    assert.equal(paths.install, healthy.dir);
    assert.equal(paths.config, join(healthy.dir, 'config', 'gateway.local.json'));
    assert.equal(paths.runtime, join(healthy.dir, 'gateway.pid'));
    await writeFile(join(healthy.dir, 'config', 'gateway.local.json'), JSON.stringify({
      upstreamApiKey: 'secret-key',
      host: healthy.host,
      port: healthy.dataPort,
    }));
    const status = await inspectGatewayStatus({ installDir: healthy.dir, cliVersion: '1.2.3', now: 61000 });
    assert.equal(status.state, 'healthy');
    assert.deepEqual(status.versions, { cli: '1.2.3', installed: '1.2.3', running: '1.2.3' });
    assert.equal(status.process.authenticated, true);
    assert.equal(status.process.uptimeSeconds, 60);
    assert.equal(status.endpoint.reachable, true);
    assert.match(formatGatewayStatus(status), /Gateway status: HEALTHY/);

    await writeFile(join(healthy.dir, 'package.json'), JSON.stringify({ version: '1.2.4' }));
    const mismatched = await inspectGatewayStatus({ installDir: healthy.dir, cliVersion: '1.2.4' });
    assert.equal(mismatched.state, 'degraded');
    assert.equal(mismatched.issues.some((current) => current.code === 'live_runtime_version_mismatch'), true);
    await writeFile(join(healthy.dir, 'package.json'), JSON.stringify({ version: '1.2.3' }));

    await writeFile(join(healthy.dir, 'gateway.pid'), JSON.stringify({
      version: 3,
      pid: 0,
      dataUrl: `http://127.0.0.1:${healthy.dataPort}`,
    }));
    const foreign = await inspectGatewayStatus({ installDir: healthy.dir, cliVersion: '1.2.3' });
    assert.equal(foreign.state, 'foreign_process');
    assert.equal(foreign.issues.some((current) => current.code === 'foreign_endpoint'), true);
  } finally {
    await cleanup(healthy);
  }

  const diagnosed = await fixture();
  try {
    const upstreamServer = http.createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: 'deepseek-v4-flash' }, { id: 'deepseek-v4-pro' }] }));
    });
    diagnosed.upstreamServer = upstreamServer;
    const upstreamPort = await listen(upstreamServer);
    const codexConfig = join(diagnosed.dir, 'config.toml');
    await writeFile(codexConfig, [
      'model_provider = "duckcoding"',
      '',
      '[model_providers.deepseek-gateway]',
      'name = "DeepSeek"',
      `base_url = "http://127.0.0.1:${diagnosed.dataPort}/v1"`,
      'wire_api = "responses"',
    ].join('\n'));
    await writeFile(join(diagnosed.dir, 'config', 'gateway.local.json'), JSON.stringify({
      upstreamApiKey: 'secret-key',
      upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}`,
      host: diagnosed.host,
      port: diagnosed.dataPort,
      codexPromptLanguage: 'zh',
    }));
    await writeFile(join(diagnosed.dir, 'state', 'reasoning-cache.jsonl'), `${JSON.stringify({
      version: 1,
      callIds: ['call_1'],
      message: { role: 'assistant', reasoning_content: 'keep', tool_calls: [] },
    })}\n`);
    const report = await inspectGatewayDoctor({
      installDir: diagnosed.dir,
      cliVersion: '1.2.3',
      env: { ...process.env, CODEX_CONFIG_FILE: codexConfig },
      codexExecutableResolver: () => 'codex-test',
      commandRunner: async () => 'codex-cli 0.144.3',
    });
    assert.equal(report.overallStatus, 'ok');
    assert.equal(report.checks['runtime.status'].status, 'ok');
    assert.equal(report.checks['codex.integration'].details.plainCodexProvider, 'duckcoding');
    assert.equal(report.checks['catalog.integrity'].status, 'ok');
    assert.equal(report.checks['gateway.models'].status, 'ok');
    assert.equal(report.checks['upstream.models'].status, 'ok');
    assert.equal(report.checks['reasoning.cache'].status, 'ok');
    assert.equal(JSON.stringify(report).includes('secret-key'), false);
    assert.match(formatGatewayDoctor(report), /Gateway doctor: OK/);

    await writeFile(join(diagnosed.dir, 'config', 'gateway.local.json'), JSON.stringify({
      upstreamApiKey: 'secret-key',
      upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}`,
      host: '0.0.0.0',
      port: diagnosed.dataPort,
    }));
    const exposed = await inspectGatewayDoctor({
      installDir: diagnosed.dir,
      cliVersion: '1.2.3',
      env: { ...process.env, CODEX_CONFIG_FILE: codexConfig },
      codexExecutableResolver: () => 'codex-test',
      commandRunner: async () => 'codex-cli 0.144.3',
    });
    assert.equal(exposed.overallStatus, 'fail');
    assert.equal(exposed.checks['security.listener'].status, 'fail');
  } finally {
    await cleanup(diagnosed);
  }
});

test('gateway diagnostics failure matrix', async () => {
  const brokenDir = await mkdtemp(join(tmpdir(), 'gateway-diagnostics-broken-'));
  try {
    await mkdir(join(brokenDir, 'config'), { recursive: true });
    await writeFile(join(brokenDir, 'config', 'gateway.local.json'), '{broken');
    const status = await inspectGatewayStatus({ installDir: brokenDir, cliVersion: '1.2.3' });
    assert.equal(status.state, 'not_installed');
    const codes = status.issues.map((current) => current.code);
    assert.equal(codes.includes('runtime_not_installed'), true);
    assert.equal(codes.includes('config_invalid'), true);
    assert.equal(status.configuration.loaded, false);
    const formatted = formatGatewayStatus(status);
    assert.match(formatted, /Gateway status: NOT_INSTALLED/);
    assert.match(formatted, /Issue: The local runtime is incomplete or missing\./);
    assert.match(formatted, /Fix: Run codex-deepseek-gateway install --dir /);
  } finally {
    await rm(brokenDir, { recursive: true, force: true });
  }

  const staleDir = await mkdtemp(join(tmpdir(), 'gateway-diagnostics-stale-'));
  try {
    await mkdir(join(staleDir, 'bin'), { recursive: true });
    await mkdir(join(staleDir, 'src'), { recursive: true });
    await mkdir(join(staleDir, 'config'), { recursive: true });
    await writeFile(join(staleDir, 'package.json'), JSON.stringify({ version: '1.2.3' }));
    await writeFile(join(staleDir, 'bin', 'codex-deepseek-gateway.js'), '');
    await writeFile(join(staleDir, 'src', 'server.js'), '');
    const idleServer = http.createServer();
    const idlePort = await listen(idleServer);
    await close(idleServer);
    await writeFile(join(staleDir, 'config', 'gateway.local.json'), JSON.stringify({ host: '127.0.0.1', port: idlePort }));
    const exited = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    await new Promise((resolveExit) => exited.once('exit', resolveExit));
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        process.kill(exited.pid, 0);
      } catch {
        break;
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    }
    await writeFile(join(staleDir, 'gateway.pid'), String(exited.pid));
    const status = await inspectGatewayStatus({ installDir: staleDir, cliVersion: '9.9.9' });
    assert.equal(status.state, 'invalid_config');
    const codes = status.issues.map((current) => current.code);
    assert.equal(codes.includes('stale_pid'), true);
    assert.equal(codes.includes('api_key_missing'), true);
    assert.equal(codes.includes('cli_runtime_version_mismatch'), true);
    assert.equal(status.process.running, false);
    assert.equal(status.endpoint.reachable, false);
  } finally {
    await rm(staleDir, { recursive: true, force: true });
  }

  const corrupted = await fixture();
  try {
    const upstreamServer = http.createServer((_request, response) => {
      response.writeHead(500, { 'content-type': 'text/plain' });
      response.end('upstream exploded');
    });
    corrupted.upstreamServer = upstreamServer;
    const upstreamPort = await listen(upstreamServer);
    const codexConfig = join(corrupted.dir, 'config.toml');
    await writeFile(codexConfig, [
      '[model_providers.deepseek-gateway]',
      'name = "DeepSeek"',
      `base_url = "http://127.0.0.1:${corrupted.dataPort}/v1"`,
      'wire_api = "responses"',
    ].join('\n'));
    await writeFile(join(corrupted.dir, 'config', 'gateway.local.json'), JSON.stringify({
      upstreamApiKey: 'secret-key',
      upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}`,
      host: corrupted.host,
      port: corrupted.dataPort,
    }));
    await writeFile(join(corrupted.dir, 'config', 'model-catalog.zh.json'), '{invalid');
    await writeFile(join(corrupted.dir, 'state', 'reasoning-cache.jsonl'), 'not a jsonl record\n');
    const report = await inspectGatewayDoctor({
      installDir: corrupted.dir,
      cliVersion: '1.2.3',
      env: { ...process.env, CODEX_CONFIG_FILE: codexConfig },
      codexExecutableResolver: () => process.execPath,
    });
    assert.equal(report.overallStatus, 'fail');
    assert.equal(report.checks['runtime.status'].status, 'ok');
    assert.equal(report.checks['codex.integration'].status, 'ok');
    assert.match(report.checks['codex.integration'].summary, /Codex \d+\.\d+\.\d+; launcher uses deepseek-gateway/);
    assert.equal(report.checks['catalog.integrity'].status, 'fail');
    assert.equal(report.checks['gateway.models'].status, 'ok');
    assert.equal(report.checks['reasoning.cache'].status, 'fail');
    assert.match(report.checks['reasoning.cache'].summary, /invalid JSONL record/);
    assert.equal(report.checks['upstream.models'].status, 'fail');
    assert.match(report.checks['upstream.models'].summary, /DeepSeek \/models returned HTTP 500/);
    assert.equal(report.checks['upstream.models'].details.error, 'upstream exploded');
    const formatted = formatGatewayDoctor(report);
    assert.match(formatted, /Gateway doctor: FAIL/);
    assert.match(formatted, /FAIL upstream {2}DeepSeek \/models returned HTTP 500/);
    assert.match(formatted, / {5}Fix: Check the DeepSeek endpoint and account status\./);
  } finally {
    await cleanup(corrupted);
  }

  const unreachable = await fixture();
  try {
    const hangingServer = http.createServer(() => {});
    unreachable.upstreamServer = hangingServer;
    const hangingPort = await listen(hangingServer);
    const codexConfig = join(unreachable.dir, 'config.toml');
    await writeFile(codexConfig, [
      '[model_providers.deepseek-gateway]',
      'name = "DeepSeek"',
      `base_url = "http://127.0.0.1:${unreachable.dataPort}/v1"`,
      'wire_api = "responses"',
    ].join('\n'));
    await writeFile(join(unreachable.dir, 'config', 'gateway.local.json'), JSON.stringify({
      upstreamApiKey: 'secret-key',
      upstreamBaseUrl: `http://127.0.0.1:${hangingPort}`,
      host: unreachable.host,
      port: unreachable.dataPort,
      modelsTimeoutMs: 100,
    }));
    const env = { ...process.env, CODEX_CONFIG_FILE: codexConfig };
    const report = await inspectGatewayDoctor({
      installDir: unreachable.dir,
      cliVersion: '1.2.3',
      env,
      codexExecutableResolver: () => join(unreachable.dir, 'missing-codex'),
    });
    assert.equal(report.overallStatus, 'fail');
    assert.equal(report.checks['codex.integration'].status, 'fail');
    assert.match(report.checks['codex.integration'].summary, /ENOENT|missing-codex/);
    assert.equal(report.checks['upstream.models'].status, 'fail');
    assert.match(report.checks['upstream.models'].summary, /DeepSeek \/models is unreachable: /);
    assert.match(formatGatewayDoctor(report), /Fix: Check DNS, proxy, firewall, TLS, and upstreamBaseUrl\./);

    const outdated = await inspectGatewayDoctor({
      installDir: unreachable.dir,
      cliVersion: '1.2.3',
      env,
      codexExecutableResolver: () => 'codex-test',
      commandRunner: async () => 'codex-cli 0.100.0',
    });
    assert.equal(outdated.checks['codex.integration'].status, 'fail');
    assert.match(outdated.checks['codex.integration'].summary, /Codex 0\.100\.0 is older than 0\.144\.0/);
    assert.equal(outdated.checks['codex.integration'].remediation, 'Update Codex CLI.');

    await writeFile(codexConfig, 'model_provider = "duckcoding"\n');
    await writeFile(join(unreachable.dir, 'config', 'model-catalog.zh.json'), JSON.stringify({
      models: [{
        slug: 'deepseek-v4-flash',
        supported_reasoning_levels: [{ effort: 'low' }],
        instructions_variables: { personality_default: '' },
      }],
    }));
    const misconfigured = await inspectGatewayDoctor({
      installDir: unreachable.dir,
      cliVersion: '1.2.3',
      env,
      codexExecutableResolver: () => 'codex-test',
      commandRunner: async () => 'codex-cli 0.144.3',
    });
    assert.equal(misconfigured.checks['codex.integration'].status, 'fail');
    assert.match(misconfigured.checks['codex.integration'].summary, /Codex provider deepseek-gateway is missing/);
    assert.match(misconfigured.checks['codex.integration'].remediation, /Add \[model_providers\.deepseek-gateway\] to /);
    assert.equal(misconfigured.checks['catalog.integrity'].status, 'fail');
    assert.match(misconfigured.checks['catalog.integrity'].summary, /English and Chinese catalogs are not structurally aligned/);
  } finally {
    await cleanup(unreachable);
  }
});
