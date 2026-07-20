import assert from 'node:assert/strict';
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
  await writeFile(join(configDir, 'model-aliases.json'), JSON.stringify({
    'deepseek-v4-flash': { model: 'deepseek-v4-flash', thinking: 'auto' },
    'deepseek-v4-pro': { model: 'deepseek-v4-pro', thinking: 'auto' },
  }));
  const catalog = {
    models: ['deepseek-v4-flash', 'deepseek-v4-pro'].map((slug) => ({
      slug,
      supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max'].map((effort) => ({ effort })),
      instructions_variables: {
        personality_default: '',
        personality_friendly: '',
        personality_pragmatic: '',
      },
    })),
  };
  await writeFile(join(configDir, 'codex-model-catalog.json'), JSON.stringify(catalog));
  await writeFile(join(configDir, 'codex-model-catalog.zh.json'), JSON.stringify(catalog));

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
