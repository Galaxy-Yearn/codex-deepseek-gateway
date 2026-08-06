#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { newConversation } from '../src/codex-launch.js';
import { DEFAULT_SESSION_LIMIT, sessions } from '../src/codex-sessions.js';
import {
  formatGatewayDoctor,
  formatGatewayStatus,
  inspectGatewayDoctor,
  inspectGatewayStatus,
} from '../src/diagnostics.js';
import {
  connectHttpUrl,
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  positiveInteger,
  readRuntimeRecord,
  removeRuntimeRecord,
  SHUTDOWN_TOKEN_HEADER,
} from '../src/runtime.js';
import { findAvailableUpdate } from '../src/update-check.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const packageJson = require('../package.json');
const UPDATE_CHECKED_ENV = 'CODEX_DEEPSEEK_GATEWAY_UPDATE_CHECKED';

function print(message = '') {
  process.stdout.write(message);
}

async function notifyAvailableUpdate() {
  if (process.stderr.isTTY !== true || process.env[UPDATE_CHECKED_ENV] === '1') return;
  const latestVersion = await findAvailableUpdate({
    packageName: packageJson.name,
    currentVersion: packageJson.version,
  });
  if (!latestVersion) return;
  process.stderr.write(
    `New version ${latestVersion} available. Run \`codex-deepseek-gateway update\` to update.\n`,
  );
}

function usage() {
  print(`Codex DeepSeek Gateway

Usage:
  codex-deepseek-gateway install
  codex-deepseek-gateway update
  codex-deepseek-gateway start
  codex-deepseek-gateway stop
  codex-deepseek-gateway status
  codex-deepseek-gateway doctor
  codex-deepseek-gateway new
  codex-deepseek-gateway sessions
  codex-deepseek-gateway uninstall

Options:
  -v, --version   Print package version
  --dir <path>     Install directory, defaults to ~/.codex/deepseek-gateway
  --no-edit        Do not open the local config file after install
  --force          With stop/update, force termination when graceful control is unavailable
  --all            With sessions, include sessions outside the current project
  --provider <id>  With new/sessions, target model_provider override
  --model <id>     With new/sessions, target model override
  --reasoning-effort <level>
                  With new/sessions, target DeepSeek reasoning level
  --exec <id>      With sessions, run the generated codex resume command
  --limit <n>      With sessions, max rows to print or show, defaults to ${DEFAULT_SESSION_LIMIT}
  --print          With sessions, print resume commands instead of picker
  --json           With status/doctor, print the stable JSON report

Prompt language is configured in gateway.local.json with codexPromptLanguage.
`);
}

function parseArgs(argv) {
  const options = { dir: defaultInstallDir(), noEdit: false, all: false, force: false };
  const rest = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--version' || arg === '-v') {
      options.version = true;
    } else if (arg === '--dir' || arg === '-d' || arg === '-InstallDir') {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} requires a path`);
      options.dir = resolve(value);
      index += 1;
    } else if (arg === '--no-edit' || arg === '-NoEdit') {
      options.noEdit = true;
    } else if (arg === '--all') {
      options.all = true;
    } else if (arg === '--force') {
      options.force = true;
    } else if (arg === '--provider') {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} requires a provider id`);
      options.provider = value;
      index += 1;
    } else if (arg === '--model' || arg === '-m') {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} requires a model id`);
      options.model = value;
      index += 1;
    } else if (arg === '--reasoning-effort') {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} requires a reasoning effort`);
      options.reasoningEffort = value;
      index += 1;
    } else if (arg === '--exec') {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} requires a session id`);
      options.exec = value;
      index += 1;
    } else if (arg === '--limit') {
      const value = Number(argv[index + 1]);
      if (!Number.isInteger(value) || value < 1) throw new Error(`${arg} requires a positive integer`);
      options.limit = value;
      index += 1;
    } else if (arg === '--print') {
      options.print = true;
    } else if (arg === '--json') {
      options.json = true;
    } else {
      rest.push(arg);
    }
  }
  return { command: rest[0], options };
}

function defaultInstallDir() {
  const home = process.env.CODEX_HOME || join(process.env.USERPROFILE || process.env.HOME || process.cwd(), '.codex');
  return join(home, 'deepseek-gateway');
}

function configPath(installDir) {
  return join(installDir, 'config', 'gateway.local.json');
}

function pidPath(installDir) {
  return join(installDir, 'gateway.pid');
}

function serverPath(installDir) {
  return join(installDir, 'src', 'server.js');
}

function hasRuntimeMarkers(installDir) {
  const manifestPath = join(installDir, 'package.json');
  if (!existsSync(manifestPath) ||
    !existsSync(join(installDir, 'bin', 'codex-deepseek-gateway.js')) ||
    !existsSync(join(installDir, 'src', 'server.js'))) return false;
  try {
    return JSON.parse(readFileSync(manifestPath, 'utf8')).name === packageJson.name;
  } catch {
    return false;
  }
}

function loadInstalledConfig(installDir) {
  return loadConfig({ ...process.env, GATEWAY_CONFIG_FILE: configPath(installDir) });
}

function endpoint(config, path = '') {
  return connectHttpUrl(config.host, config.port, path);
}

function isConfigured(installDir) {
  if (!existsSync(configPath(installDir))) return false;
  const config = loadInstalledConfig(installDir);
  return Boolean(config.upstreamApiKey);
}

async function health(config) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetch(endpoint(config, '/health'), { signal: controller.signal });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function requestControl(url, token, method) {
  if (!url || !token) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetch(url, {
      method,
      headers: { [SHUTDOWN_TOKEN_HEADER]: token },
      signal: controller.signal,
    });
    const text = await response.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
    }
    return { status: response.status, body };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function controlStatus(record) {
  if (!record.controlUrl || !record.shutdownToken) return false;
  const result = await requestControl(`${record.controlUrl.replace(/\/$/, '')}/status`, record.shutdownToken, 'GET');
  return result?.status === 200 &&
    result.body?.ok === true &&
    Number(result.body.pid) === record.pid &&
    result.body.instanceId === record.instanceId;
}

async function requestShutdown(config, record) {
  const url = record.controlUrl
    ? `${record.controlUrl.replace(/\/$/, '')}/shutdown`
    : record.shutdownToken
    ? endpoint(config, '/shutdown')
    : '';
  const result = await requestControl(url, record.shutdownToken, 'POST');
  return result?.status === 202;
}

function processExists(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function forceKillProcess(pid) {
  if (!pid || pid === process.pid) return;
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
  }
}

async function waitForProcessExit(pid, timeoutMs) {
  const attempts = Math.max(1, Math.ceil(timeoutMs / 100));
  for (let index = 0; index < attempts && processExists(pid); index += 1) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  return !processExists(pid);
}

function readProcessRecord(installDir) {
  return readRuntimeRecord(pidPath(installDir));
}

function copyRuntime(installDir) {
  mkdirSync(join(installDir, 'bin'), { recursive: true });
  mkdirSync(join(installDir, 'src'), { recursive: true });
  mkdirSync(join(installDir, 'config'), { recursive: true });
  copyFileSync(join(ROOT, 'package.json'), join(installDir, 'package.json'));
  rmSync(join(installDir, 'bin'), { recursive: true, force: true });
  rmSync(join(installDir, 'src'), { recursive: true, force: true });
  cpSync(join(ROOT, 'bin'), join(installDir, 'bin'), { recursive: true });
  cpSync(join(ROOT, 'src'), join(installDir, 'src'), { recursive: true });
  rmSync(join(installDir, 'config', 'codex-model-catalog.json'), { force: true });
  rmSync(join(installDir, 'config', 'codex-model-catalog.zh.json'), { force: true });
  copyFileSync(join(ROOT, 'config', 'model-catalog.json'), join(installDir, 'config', 'model-catalog.json'));
  copyFileSync(join(ROOT, 'config', 'model-catalog.zh.json'), join(installDir, 'config', 'model-catalog.zh.json'));
  rmSync(join(installDir, 'config', 'frontend-design-guidance'), { recursive: true, force: true });
  cpSync(join(ROOT, 'config', 'frontend-design-guidance'), join(installDir, 'config', 'frontend-design-guidance'), { recursive: true });
  rmSync(join(installDir, 'config', 'codex-model-catalog.base.json'), { force: true });
  rmSync(join(installDir, 'config', 'model-aliases.json'), { force: true });
  const localConfig = configPath(installDir);
  if (!existsSync(localConfig)) {
    copyFileSync(join(ROOT, 'config', 'gateway.example.json'), localConfig);
  }
}

function openConfig(file) {
  const opener =
    process.platform === 'win32'
      ? ['notepad.exe', [file]]
      : process.platform === 'darwin'
      ? ['open', [file]]
      : ['xdg-open', [file]];
  try {
    const child = spawn(opener[0], opener[1], { detached: true, stdio: 'ignore' });
    child.on('error', () => print(`Edit config: ${file}\n`));
    child.unref();
  } catch {
    print(`Edit config: ${file}\n`);
  }
}

async function install(options) {
  copyRuntime(options.dir);
  print(`Installed to ${options.dir}\n`);
  if (!isConfigured(options.dir)) {
    print(`Edit this file and put your DeepSeek API key:\n  ${configPath(options.dir)}\n`);
    if (!options.noEdit) openConfig(configPath(options.dir));
    return;
  }
  await start(options);
}

function runChild(command, args, label, capture = false, env = process.env) {
  return new Promise((resolveChild, rejectChild) => {
    const child = spawn(command, args, {
      env,
      stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
      windowsHide: true,
    });
    let stdout = '';
    if (capture) {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
    }
    child.once('error', (error) => rejectChild(new Error(`Failed to run ${label}: ${error.message}`)));
    child.once('close', (code, signal) => {
      if (code === 0) {
        resolveChild(stdout);
      } else {
        rejectChild(new Error(`${label} failed${signal ? ` with signal ${signal}` : ` with exit code ${code}`}`));
      }
    });
  });
}

function npmProcess(args) {
  if (process.platform === 'win32') {
    return {
      command: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', ['npm', ...args].join(' ')],
    };
  }
  return { command: 'npm', args };
}

function globalPackage(globalRoot) {
  const packageDir = join(globalRoot, ...packageJson.name.split('/'));
  const manifestPath = join(packageDir, 'package.json');
  if (!existsSync(manifestPath)) throw new Error(`Updated package is missing at ${packageDir}`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const relativeBin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.['codex-deepseek-gateway'];
  if (!relativeBin) throw new Error('Updated package does not expose the codex-deepseek-gateway command');
  const cliPath = resolve(packageDir, relativeBin);
  if (!existsSync(cliPath)) throw new Error(`Updated gateway CLI is missing at ${cliPath}`);
  return { cliPath };
}

async function update(options) {
  if (!hasRuntimeMarkers(options.dir)) {
    throw new Error(`Missing runtime at ${options.dir}. Run install first.`);
  }
  if (!isConfigured(options.dir)) {
    throw new Error(`Missing DeepSeek API key in ${configPath(options.dir)} or DEEPSEEK_API_KEY. Run install first.`);
  }
  await stop(options);
  const target = `${packageJson.name}@latest`;
  print(`Installing ${target} ...\n`);
  const npmInstall = npmProcess(['install', '-g', target]);
  await runChild(npmInstall.command, npmInstall.args, 'npm install');
  const npmRoot = npmProcess(['root', '-g']);
  const globalRoot = (await runChild(npmRoot.command, npmRoot.args, 'npm root', true)).trim();
  if (!globalRoot) throw new Error('npm root returned an empty global package path');
  const updatedPackage = globalPackage(globalRoot);
  const dirArgs = ['--dir', options.dir];
  const childEnv = { ...process.env, [UPDATE_CHECKED_ENV]: '1' };
  await runChild(process.execPath, [updatedPackage.cliPath, 'install', '--no-edit', ...dirArgs], 'gateway install', false, childEnv);
  await runChild(process.execPath, [updatedPackage.cliPath, 'status', ...dirArgs], 'gateway status', true, childEnv);
  await runChild(process.execPath, [updatedPackage.cliPath, 'doctor', ...dirArgs], 'gateway doctor', true, childEnv);
}

async function start(options) {
  if (!existsSync(options.dir)) {
    throw new Error(`Missing runtime at ${options.dir}. Run install first.`);
  }
  copyRuntime(options.dir);
  if (!existsSync(serverPath(options.dir))) {
    throw new Error(`Missing runtime at ${options.dir}. Run install first.`);
  }
  if (!isConfigured(options.dir)) {
    throw new Error(`Missing DeepSeek API key in ${configPath(options.dir)} or DEEPSEEK_API_KEY`);
  }
  const config = loadInstalledConfig(options.dir);
  const existingRecord = readProcessRecord(options.dir);
  const currentHealth = await health(config);
  const existingProcess = processExists(existingRecord.pid);
  const managedProcess = existingProcess && (
    await controlStatus(existingRecord) ||
    (!existingRecord.controlUrl && currentHealth?.ok)
  );
  if (managedProcess) {
    print('Gateway is already running.\n');
    return;
  }
  if (existingProcess) {
    throw new Error(`Recorded PID ${existingRecord.pid} cannot be authenticated. Inspect ${pidPath(options.dir)} before starting another gateway.`);
  }
  if (currentHealth?.ok) {
    print(`Gateway is already reachable at ${endpoint(config)}. Another install may already be running.\n`);
    return;
  }

  mkdirSync(options.dir, { recursive: true });
  const out = 'ignore';
  const shutdownToken = randomBytes(32).toString('hex');
  const instanceId = randomBytes(16).toString('hex');
  const runtimeFile = pidPath(options.dir);
  removeRuntimeRecord(runtimeFile);
  print(`Starting gateway on ${endpoint(config)} ...\n`);
  const child = spawn(process.execPath, [serverPath(options.dir)], {
    cwd: options.dir,
    detached: true,
    env: {
      ...process.env,
      GATEWAY_INSTANCE_ID: instanceId,
      GATEWAY_RUNTIME_FILE: runtimeFile,
      GATEWAY_SHUTDOWN_TOKEN: shutdownToken,
    },
    stdio: ['ignore', out, out],
    windowsHide: true,
  });
  child.unref();

  for (let index = 0; index < 20; index += 1) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
    const record = readProcessRecord(options.dir);
    const ready = record.pid === child.pid &&
      record.instanceId === instanceId &&
      await controlStatus(record) &&
      Boolean((await health(config))?.ok);
    if (ready) {
      print(`Gateway started. PID ${child.pid}\n`);
      return;
    }
    if (!processExists(child.pid)) break;
  }
  if (processExists(child.pid)) {
    forceKillProcess(child.pid);
    await waitForProcessExit(child.pid, 2000);
  }
  removeRuntimeRecord(runtimeFile, instanceId);
  throw new Error(`Gateway did not become reachable on ${endpoint(config)}`);
}

async function stop(options) {
  const config = loadInstalledConfig(options.dir);
  const record = readProcessRecord(options.dir);
  const pid = record.pid;
  const pidRunning = processExists(pid);
  if (pidRunning) {
    const graceful = await requestShutdown(config, record);
    if (!graceful && !options.force) {
      throw new Error(`Gateway process ${pid} could not be authenticated for graceful shutdown. Re-run stop with --force only after verifying ${pidPath(options.dir)}.`);
    }
    if (graceful) {
      const waitMs = positiveInteger(config.shutdownTimeoutMs, DEFAULT_SHUTDOWN_TIMEOUT_MS) + 2000;
      if (!await waitForProcessExit(pid, waitMs) && !options.force) {
        throw new Error(`Gateway process ${pid} did not exit after graceful shutdown. Re-run stop with --force to terminate it.`);
      }
    }
    if (processExists(pid) && options.force) {
      forceKillProcess(pid);
      await waitForProcessExit(pid, 2000);
    }
    if (processExists(pid)) {
      throw new Error(`Gateway process ${pid} is still running.`);
    }
  }
  removeRuntimeRecord(pidPath(options.dir), record.instanceId);
  const running = await health(config);
  if (!running?.ok) {
    print('Gateway stopped.\n');
  } else if (!pidRunning) {
    print(`No gateway process is recorded for this install. ${endpoint(config)} is still reachable, likely from another install.\n`);
  } else {
    print(`Gateway may still be running on ${endpoint(config)}.\n`);
  }
}

async function status(options) {
  const report = await inspectGatewayStatus({ installDir: options.dir, cliVersion: packageJson.version });
  print(options.json ? `${JSON.stringify(report, null, 2)}\n` : formatGatewayStatus(report));
  if (report.state !== 'healthy') process.exitCode = 1;
}

async function doctor(options) {
  const report = await inspectGatewayDoctor({ installDir: options.dir, cliVersion: packageJson.version });
  print(options.json ? `${JSON.stringify(report, null, 2)}\n` : formatGatewayDoctor(report));
  if (report.overallStatus === 'fail') process.exitCode = 1;
}

async function uninstall(options) {
  if (!existsSync(options.dir)) {
    print(`No install found at ${options.dir}\n`);
    return;
  }
  if (resolve(options.dir) === ROOT) {
    throw new Error(`Refusing to remove source checkout ${options.dir}`);
  }
  if (!hasRuntimeMarkers(options.dir)) {
    throw new Error(`Refusing to remove ${options.dir}: it does not look like a codex-deepseek-gateway install directory.`);
  }
  await stop(options);
  rmSync(options.dir, { recursive: true, force: true });
  print(`Removed ${options.dir}\n`);
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  await notifyAvailableUpdate();
  if (options.version) {
    print(`${packageJson.version}\n`);
    return;
  }
  if (!command || command === '-h' || command === '--help' || command === 'help') {
    usage();
    return;
  }
  const commands = { install, update, start, stop, status, doctor, new: newConversation, sessions, uninstall };
  const handler = commands[command];
  if (!handler) {
    throw new Error(`Unknown command: ${command}`);
  }
  await handler(options);
}

main().catch((error) => {
  process.stderr.write(`${error.message || error}\n`);
  process.exitCode = 1;
});
