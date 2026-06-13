#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { newConversation } from '../src/codex-launch.js';
import { sessions } from '../src/codex-sessions.js';
import { toProviderChatCompletionsRequest } from '../src/protocol.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const packageJson = require('../package.json');

function print(message = '') {
  process.stdout.write(message);
}

function usage() {
  print(`Codex DeepSeek Gateway

Usage:
  codex-deepseek-gateway install
  codex-deepseek-gateway start
  codex-deepseek-gateway stop
  codex-deepseek-gateway status
  codex-deepseek-gateway doctor
  codex-deepseek-gateway new
  codex-deepseek-gateway sessions
  codex-deepseek-gateway uninstall

Options:
  --dir <path>     Install directory, defaults to ~/.codex/deepseek-gateway
  --no-edit        Do not open the local config file after install
  --all            With sessions, include sessions outside the current project
  --provider <id>  With new/sessions, target model_provider override
  --model <id>     With new/sessions, target model override
  --reasoning-effort <level>
                  With new/sessions, target Codex reasoning effort
  --exec <id>      With sessions, run the generated codex resume command
  --limit <n>      With sessions, max rows to print, defaults to 20
  --print          With new, print the launch command. With sessions, print
                  copyable resume commands instead of picker
`);
}

function parseArgs(argv) {
  const options = { dir: defaultInstallDir(), noEdit: false, all: false };
  const rest = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dir' || arg === '-d' || arg === '-InstallDir') {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} requires a path`);
      options.dir = resolve(value);
      index += 1;
    } else if (arg === '--no-edit' || arg === '-NoEdit') {
      options.noEdit = true;
    } else if (arg === '--all') {
      options.all = true;
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

function loadInstalledConfig(installDir) {
  return loadConfig({ ...process.env, GATEWAY_CONFIG_FILE: configPath(installDir) });
}

function endpoint(config, path = '') {
  return `http://${config.host}:${config.port}${path}`;
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

function processExists(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killProcess(pid) {
  if (!pid || pid === process.pid) return;
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      process.kill(pid);
    }
  } catch {
  }
}

function findWindowsPidOnPort(port) {
  if (process.platform !== 'win32') return 0;
  try {
    const output = execFileSync('netstat.exe', ['-ano', '-p', 'tcp'], { encoding: 'utf8', windowsHide: true });
    const escapedPort = String(port).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`(?:127\\.0\\.0\\.1|0\\.0\\.0\\.0|\\[::1\\]|\\[::\\]):${escapedPort}\\s+[^\\s]+\\s+LISTENING\\s+(\\d+)`, 'i');
    for (const line of output.split(/\r?\n/)) {
      const match = line.match(pattern);
      if (match) return Number(match[1]) || 0;
    }
  } catch {
  }
  return 0;
}

function processCommandLine(pid) {
  if (process.platform !== 'win32' || !pid) return '';
  try {
    const output = execFileSync(
      'wmic.exe',
      ['process', 'where', `ProcessId=${pid}`, 'get', 'CommandLine', '/value'],
      { encoding: 'utf8', windowsHide: true },
    );
    const match = output.match(/CommandLine=(.*)/s);
    return match ? match[1].trim() : '';
  } catch {
    return '';
  }
}

function readPid(installDir) {
  try {
    return Number(readFileSync(pidPath(installDir), 'utf8').trim()) || 0;
  } catch {
    return 0;
  }
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
  const modelAliasesConfig = join(installDir, 'config', 'model-aliases.json');
  if (!existsSync(modelAliasesConfig)) {
    copyFileSync(join(ROOT, 'config', 'model-aliases.example.json'), modelAliasesConfig);
  }
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

async function start(options) {
  if (!existsSync(serverPath(options.dir))) {
    throw new Error(`Missing runtime at ${options.dir}. Run install first.`);
  }
  if (!isConfigured(options.dir)) {
    throw new Error(`Missing DeepSeek API key in ${configPath(options.dir)} or DEEPSEEK_API_KEY`);
  }
  const config = loadInstalledConfig(options.dir);
  const currentHealth = await health(config);
  if (currentHealth?.ok) {
    const pid = readPid(options.dir);
    const message = processExists(pid)
      ? 'Gateway is already running.\n'
      : `Gateway is already reachable at ${endpoint(config)}. Another install may already be running.\n`;
    print(message);
    return;
  }

  mkdirSync(options.dir, { recursive: true });
  const out = 'ignore';
  print(`Starting gateway on ${endpoint(config)} ...\n`);
  const child = spawn(process.execPath, [serverPath(options.dir)], {
    cwd: options.dir,
    detached: true,
    stdio: ['ignore', out, out],
    windowsHide: true,
  });
  writeFileSync(pidPath(options.dir), String(child.pid));
  child.unref();

  for (let index = 0; index < 20; index += 1) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
    const ready = await health(config);
    if (ready?.ok) {
      print(`Gateway started. PID ${child.pid}\n`);
      return;
    }
  }
  throw new Error(`Gateway did not become reachable on ${endpoint(config)}`);
}

async function stop(options) {
  const config = loadInstalledConfig(options.dir);
  const pid = readPid(options.dir);
  const hadManagedPid = processExists(pid);
  let killedPortProcess = false;
  if (processExists(pid)) {
    killProcess(pid);
    for (let index = 0; index < 20 && processExists(pid); index += 1) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
  }
  const portPid = findWindowsPidOnPort(config.port);
  if (portPid && portPid !== pid) {
    const commandLine = processCommandLine(portPid);
    if (commandLine.includes(serverPath(options.dir))) {
      killProcess(portPid);
      killedPortProcess = true;
      for (let index = 0; index < 20 && processExists(portPid); index += 1) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
      }
    }
  }
  rmSync(pidPath(options.dir), { force: true });
  const running = await health(config);
  if (!running?.ok) {
    print('Gateway stopped.\n');
  } else if (!hadManagedPid && !killedPortProcess) {
    print(`No gateway process is recorded for this install. ${endpoint(config)} is still reachable, likely from another install.\n`);
  } else {
    print(`Gateway may still be running on ${endpoint(config)}.\n`);
  }
}

async function status(options) {
  const config = loadInstalledConfig(options.dir);
  const pid = readPid(options.dir);
  const running = await health(config);
  const versionPath = join(options.dir, 'package.json');
  const installedVersion = existsSync(versionPath) ? JSON.parse(readFileSync(versionPath, 'utf8')).version : '';
  print(JSON.stringify({
    installed: existsSync(options.dir),
    installDir: options.dir,
    configPath: configPath(options.dir),
    pid,
    pidRunning: processExists(pid),
    reachable: Boolean(running?.ok),
    url: endpoint(config),
    version: installedVersion || packageJson.version,
  }, null, 2));
  print('\n');
}

async function doctor(options) {
  const config = loadInstalledConfig(options.dir);
  const codexConfigUsingGateway = config.codexModelProvider === 'deepseek-gateway';
  const model = codexConfigUsingGateway && config.codexModel ? config.codexModel : 'deepseek-v4-pro';
  const upstreamRequest = toProviderChatCompletionsRequest(
    {
      model,
      messages: [{ role: 'user', content: 'ping' }],
      stream: true,
    },
    config,
  );
  const supportsReasoningSummaries = String(config.codexModelSupportsReasoningSummaries).toLowerCase() === 'true';
  const summaryMode = String(config.codexReasoningSummary || '').toLowerCase();
  const hideAgentReasoning = String(config.codexHideAgentReasoning).toLowerCase() === 'true';
  const thinkingEnabled = upstreamRequest.thinking?.type === 'enabled';
  const reasoningDisplayMode = hideAgentReasoning
    ? 'hidden'
    : thinkingEnabled
    ? 'summary'
    : 'disabled';
  print(JSON.stringify({
    packageVersion: packageJson.version,
    installDir: options.dir,
    localConfig: configPath(options.dir),
    codexConfigUsingGateway,
    codexModelProvider: config.codexModelProvider || null,
    codexModel: config.codexModel || null,
    codexReasoningEffort: config.codexReasoningEffort || null,
    codexReasoningSummary: config.codexReasoningSummary || null,
    codexModelSupportsReasoningSummaries: config.codexModelSupportsReasoningSummaries || null,
    codexHideAgentReasoning: config.codexHideAgentReasoning || null,
    sampleModel: model,
    upstreamModel: upstreamRequest.model,
    deepseekThinking: upstreamRequest.thinking || null,
    deepseekReasoningEffort: upstreamRequest.reasoning_effort || null,
    reasoningDisplayMode,
    tavilyWebSearchEnabled: Boolean(config.tavilyWebSearchEnabled),
    tavilyWebSearchReady: Boolean(config.tavilyWebSearchEnabled && config.tavilyApiKey),
    firecrawlWebFetchEnabled: Boolean(config.firecrawlWebFetchEnabled),
    firecrawlWebFetchReady: Boolean(config.firecrawlWebFetchEnabled && config.firecrawlApiKey),
    firecrawlAutoScrapeTopResults: config.firecrawlAutoScrapeTopResults,
    hint: 'The gateway exposes model aliases on /v1/models. Whether Codex TUI /model shows them depends on the Codex build.',
  }, null, 2));
  print('\n');
}

async function uninstall(options) {
  await stop(options);
  rmSync(options.dir, { recursive: true, force: true });
  print(`Removed ${options.dir}\n`);
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (!command || command === '-h' || command === '--help' || command === 'help') {
    usage();
    return;
  }
  const commands = { install, start, stop, status, doctor, new: newConversation, sessions, uninstall };
  const handler = commands[command];
  if (!handler) {
    throw new Error(`Unknown command: ${command}`);
  }
  await handler(options);
}

main().catch((error) => {
  process.stderr.write(`${error.message || error}\n`);
  process.exit(1);
});
