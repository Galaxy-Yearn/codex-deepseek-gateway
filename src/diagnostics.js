import { spawn } from 'node:child_process';
import { constants, accessSync, existsSync, readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { dirname, join } from 'node:path';
import { inspectCodexConfig } from './codex-config.js';
import { resolveCodexExecutable } from './codex-launch.js';
import { isObject, joinUrl, safeJsonParse } from './common.js';
import { loadConfig } from './config.js';
import { modelAliasesFromCatalog } from './model-catalog.js';
import { listModels, resolveModelAlias } from './model-map.js';
import {
  connectHttpUrl,
  positiveInteger,
  readRuntimeRecord,
  SHUTDOWN_TOKEN_HEADER,
} from './runtime.js';
import { callModels, readJsonResponse } from './upstream.js';

const STATUS_TIMEOUT_MS = 1500;
const DEFAULT_CACHE_MAX_BYTES = 16 * 1024 * 1024;
const DEFAULT_CACHE_MAX_MESSAGES = 1000;
const MIN_CODEX_VERSION = [0, 144, 0];

export function gatewayDiagnosticPaths(installDir) {
  return {
    install: installDir,
    config: join(installDir, 'config', 'gateway.local.json'),
    runtime: join(installDir, 'gateway.pid'),
    package: join(installDir, 'package.json'),
    cli: join(installDir, 'bin', 'codex-deepseek-gateway.js'),
    server: join(installDir, 'src', 'server.js'),
    catalogEn: join(installDir, 'config', 'model-catalog.json'),
    catalogZh: join(installDir, 'config', 'model-catalog.zh.json'),
  };
}

function processExists(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
}

function readPackageVersion(path) {
  try {
    return String(readJson(path)?.version || '');
  } catch {
    return '';
  }
}

function runtimeInstalled(paths) {
  return [paths.package, paths.cli, paths.server].every(existsSync);
}

function configContext(paths, env) {
  try {
    const config = loadConfig({
      ...env,
      GATEWAY_CONFIG_FILE: paths.config,
    });
    return { config, error: null };
  } catch (error) {
    return { config: null, error };
  }
}

async function fetchJson(url, { fetchImpl = fetch, headers, timeoutMs = STATUS_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const startedAt = Date.now();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { headers, signal: controller.signal });
    const text = await response.text();
    const parsed = safeJsonParse(text);
    return {
      reachable: true,
      ok: response.ok,
      status: response.status,
      data: parsed.ok ? parsed.value : null,
      latencyMs: Date.now() - startedAt,
      error: parsed.ok ? '' : text.slice(0, 300),
    };
  } catch (error) {
    return {
      reachable: false,
      ok: false,
      status: 0,
      data: null,
      latencyMs: Date.now() - startedAt,
      error: error?.name === 'AbortError' ? 'request timed out' : String(error?.message || error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function controlInfo(record, fetchImpl) {
  if (!record.controlUrl || !record.shutdownToken) {
    return { reachable: false, authenticated: false, data: null, latencyMs: null };
  }
  const result = await fetchJson(joinUrl(record.controlUrl, '/status'), {
    fetchImpl,
    headers: { [SHUTDOWN_TOKEN_HEADER]: record.shutdownToken },
  });
  const authenticated = result.status === 200 &&
    result.data?.ok === true &&
    Number(result.data.pid) === record.pid &&
    result.data.instanceId === record.instanceId;
  return {
    reachable: result.reachable,
    authenticated,
    data: authenticated ? result.data : null,
    latencyMs: result.latencyMs,
  };
}

function issue(code, message, remediation) {
  return { code, message, remediation };
}

function sameUrl(left, right) {
  return String(left || '').replace(/\/+$/, '') === String(right || '').replace(/\/+$/, '');
}

export async function inspectGatewayStatus({ installDir, cliVersion, env = process.env, fetchImpl = fetch, now = Date.now() }) {
  const paths = gatewayDiagnosticPaths(installDir);
  const installed = runtimeInstalled(paths);
  const installedVersion = readPackageVersion(paths.package);
  const record = readRuntimeRecord(paths.runtime);
  const running = processExists(record.pid);
  const configResult = configContext(paths, env);
  const configuredDataUrl = configResult.config ? connectHttpUrl(configResult.config.host, configResult.config.port) : '';
  const control = running ? await controlInfo(record, fetchImpl) : { reachable: false, authenticated: false, data: null, latencyMs: null };
  const runningVersion = String(control.data?.packageVersion || record.packageVersion || '');
  const runningDataUrl = String(control.data?.dataUrl || record.dataUrl || configuredDataUrl || '');
  const startedAtMs = Number(control.data?.startedAt || record.startedAt || 0);
  const health = runningDataUrl
    ? await fetchJson(joinUrl(runningDataUrl, '/health'), { fetchImpl })
    : { reachable: false, ok: false, status: 0, latencyMs: null, error: '' };
  const authenticated = Boolean(control.authenticated);
  const issues = [];

  if (!installed) {
    issues.push(issue('runtime_not_installed', 'The local runtime is incomplete or missing.', `Run codex-deepseek-gateway install --dir ${installDir}`));
  }
  if (configResult.error) {
    issues.push(issue('config_invalid', String(configResult.error.message || configResult.error), `Fix ${paths.config}`));
  } else if (!configResult.config?.upstreamApiKey && !running) {
    issues.push(issue('api_key_missing', 'No DeepSeek API key is available to start the gateway.', `Configure upstreamApiKey in ${paths.config}`));
  }
  if (record.pid && !running) {
    issues.push(issue('stale_pid', `Recorded PID ${record.pid} is not running.`, `Run codex-deepseek-gateway start --dir ${installDir}`));
  }
  if (running && !authenticated) {
    issues.push(issue('process_unmanaged', `PID ${record.pid} could not be authenticated as this gateway instance.`, `Inspect ${paths.runtime} before using stop --force`));
  }
  if (!running && health.reachable) {
    issues.push(issue('foreign_endpoint', `${runningDataUrl} is served by a process not owned by this install.`, 'Stop the conflicting service or change the gateway port.'));
  }
  if (running && authenticated && !health.ok) {
    issues.push(issue('health_failed', `The authenticated process is not healthy at ${runningDataUrl}.`, 'Restart the gateway and inspect its configuration.'));
  }
  if (installedVersion && cliVersion && installedVersion !== cliVersion) {
    issues.push(issue('cli_runtime_version_mismatch', `CLI ${cliVersion} and installed runtime ${installedVersion} differ.`, 'Run codex-deepseek-gateway install --no-edit.'));
  }
  if (running && authenticated && !runningVersion) {
    issues.push(issue('live_version_unknown', 'The running process does not report its package version.', 'Restart the gateway with the installed runtime.'));
  } else if (runningVersion && installedVersion && runningVersion !== installedVersion) {
    issues.push(issue('live_runtime_version_mismatch', `Running process ${runningVersion} and installed runtime ${installedVersion} differ.`, 'Restart the gateway.'));
  }
  if (running && authenticated && configuredDataUrl && runningDataUrl && !sameUrl(configuredDataUrl, runningDataUrl)) {
    issues.push(issue('endpoint_mismatch', `The process uses ${runningDataUrl}, but current config resolves to ${configuredDataUrl}.`, 'Restart the gateway to apply the current host and port.'));
  }

  let state = 'healthy';
  if (!installed) state = 'not_installed';
  else if (configResult.error || (!configResult.config?.upstreamApiKey && !running)) state = 'invalid_config';
  else if ((running && !authenticated) || (!running && health.reachable)) state = 'foreign_process';
  else if (!running) state = 'stopped';
  else if (!health.ok) state = 'unhealthy';
  else if (issues.length) state = 'degraded';

  return {
    schemaVersion: 1,
    state,
    versions: {
      cli: String(cliVersion || ''),
      installed: installedVersion || null,
      running: runningVersion || null,
    },
    process: {
      pid: record.pid || null,
      running,
      authenticated,
      startedAt: startedAtMs ? new Date(startedAtMs).toISOString() : null,
      uptimeSeconds: startedAtMs ? Math.max(0, Math.floor((now - startedAtMs) / 1000)) : null,
    },
    endpoint: {
      configuredApi: configuredDataUrl ? joinUrl(configuredDataUrl, '/v1') : null,
      runningApi: runningDataUrl ? joinUrl(runningDataUrl, '/v1') : null,
      reachable: Boolean(health.ok),
      latencyMs: health.latencyMs,
    },
    configuration: {
      loaded: !configResult.error,
      apiKeyAvailable: Boolean(configResult.config?.upstreamApiKey),
      upstreamWireApi: configResult.config?.upstreamWireApi || null,
    },
    paths: {
      install: paths.install,
      config: paths.config,
    },
    issues,
  };
}

function diagnosticResult(status, summary, details = {}, remediation = null) {
  return { status, summary, details, remediation };
}

async function runCheck(id, category, check) {
  const startedAt = Date.now();
  try {
    return {
      id,
      category,
      ...await check(),
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      id,
      category,
      status: 'fail',
      summary: String(error?.message || error),
      details: {},
      remediation: null,
      durationMs: Date.now() - startedAt,
    };
  }
}

function safeUrl(value) {
  try {
    const url = new URL(String(value || ''));
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return String(value || '');
  }
}

function loopbackHost(host) {
  const value = String(host || '').trim().replace(/^\[|\]$/g, '').toLowerCase();
  if (value === 'localhost' || value === '::1' || value === '0:0:0:0:0:0:0:1') return true;
  return isIP(value) === 4 && value.startsWith('127.');
}

function parseVersion(value) {
  const match = String(value || '').match(/(\d+)\.(\d+)\.(\d+)/);
  return match ? match.slice(1).map(Number) : [];
}

function versionAtLeast(value, minimum) {
  const parsed = parseVersion(value);
  if (parsed.length !== 3) return false;
  for (let index = 0; index < minimum.length; index += 1) {
    if (parsed[index] !== minimum[index]) return parsed[index] > minimum[index];
  }
  return true;
}

function runCommand(command, args, timeoutMs = 5000) {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      rejectCommand(new Error(`${command} timed out`));
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => {
      clearTimeout(timeout);
      rejectCommand(error);
    });
    child.once('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) resolveCommand(stdout.trim());
      else rejectCommand(new Error(stderr.trim() || `${command} exited with code ${code}`));
    });
  });
}

function catalogShape(value) {
  if (!Array.isArray(value?.models) || !value.models.length) throw new Error('catalog must contain models');
  const models = new Map();
  for (const model of value.models) {
    const slug = String(model?.slug || '');
    if (!slug) throw new Error('catalog model is missing slug');
    const efforts = Array.isArray(model.supported_reasoning_levels)
      ? model.supported_reasoning_levels.map((level) => String(level?.effort || '')).filter(Boolean)
      : [];
    const personalities = Object.keys(isObject(model.instructions_variables) ? model.instructions_variables : {}).sort();
    models.set(slug, { efforts, personalities });
  }
  return models;
}

function catalogsAligned(left, right) {
  if (left.size !== right.size) return false;
  for (const [slug, shape] of left) {
    const other = right.get(slug);
    if (!other || JSON.stringify(shape) !== JSON.stringify(other)) return false;
  }
  return true;
}

function cacheInspection(config) {
  if (!config.reasoningCacheEnabled) return diagnosticResult('skipped', 'reasoning cache is disabled');
  const path = config.reasoningCachePath;
  const maxBytes = positiveInteger(config.reasoningCacheMaxBytes, DEFAULT_CACHE_MAX_BYTES);
  const maxMessages = positiveInteger(config.reasoningCacheMaxMessages, DEFAULT_CACHE_MAX_MESSAGES);
  if (!existsSync(path)) {
    accessSync(existsSync(dirname(path)) ? dirname(path) : dirname(dirname(path)), constants.W_OK);
    return diagnosticResult('ok', 'reasoning cache is empty and its parent is writable', { path, maxBytes, maxMessages, bytes: 0, records: 0 });
  }
  accessSync(path, constants.R_OK | constants.W_OK);
  const raw = readFileSync(path, 'utf8');
  let records = 0;
  let callIds = 0;
  for (const line of raw.split('\n')) {
    if (!line) continue;
    const parsed = safeJsonParse(line);
    if (!parsed.ok || parsed.value?.version !== 1 || !Array.isArray(parsed.value.callIds) || !isObject(parsed.value.message)) {
      return diagnosticResult('fail', 'reasoning cache contains an invalid JSONL record', { path, bytes: Buffer.byteLength(raw) }, 'Stop the gateway, back up the cache, then remove the invalid file.');
    }
    records += 1;
    callIds += parsed.value.callIds.length;
  }
  const bytes = Buffer.byteLength(raw);
  const status = bytes > maxBytes ? 'warning' : 'ok';
  const summary = status === 'ok' ? 'reasoning cache is readable and valid' : 'reasoning cache exceeds its configured byte limit';
  return diagnosticResult(status, summary, { path, bytes, maxBytes, maxMessages, records, callIds }, status === 'warning' ? 'Restart the gateway to compact the cache.' : null);
}

function errorMessage(data) {
  return String(data?.error?.message || data?.message || data?.raw || '').slice(0, 300);
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

export async function inspectGatewayDoctor({
  installDir,
  cliVersion,
  env = process.env,
  fetchImpl = fetch,
  codexExecutableResolver = resolveCodexExecutable,
  commandRunner = runCommand,
} = {}) {
  const paths = gatewayDiagnosticPaths(installDir);
  const context = configContext(paths, env);
  const status = await inspectGatewayStatus({ installDir, cliVersion, env, fetchImpl });
  const config = context.config;
  const checks = await Promise.all([
    runCheck('runtime.status', 'runtime', async () => {
      const checkStatus = status.state === 'healthy' ? 'ok' : status.state === 'degraded' ? 'warning' : 'fail';
      return diagnosticResult(
        checkStatus,
        status.state === 'healthy'
          ? `gateway ${status.versions.running} is authenticated and healthy`
          : `gateway state is ${status.state}`,
        {
          versions: status.versions,
          process: status.process,
          endpoint: status.endpoint,
          issues: status.issues,
        },
        status.issues[0]?.remediation || null,
      );
    }),
    runCheck('config.gateway', 'config', async () => {
      if (context.error) return diagnosticResult('fail', String(context.error.message || context.error), { path: paths.config }, `Fix ${paths.config}`);
      const invalid = [];
      if (!config.upstreamApiKey) invalid.push('DeepSeek API key is missing');
      try { new URL(config.upstreamBaseUrl); } catch { invalid.push('upstreamBaseUrl is invalid'); }
      if (!['chat_completions', 'responses'].includes(config.upstreamWireApi)) invalid.push('upstreamWireApi must be chat_completions or responses');
      if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) invalid.push('port must be between 1 and 65535');
      if (!Number.isFinite(config.upstreamTimeoutMs) || config.upstreamTimeoutMs <= 0) invalid.push('upstreamTimeoutMs must be positive');
      if (!Number.isFinite(config.compactTimeoutMs) || config.compactTimeoutMs <= 0) invalid.push('compactTimeoutMs must be positive');
      if (invalid.length) return diagnosticResult('fail', invalid.join('; '), { path: paths.config }, `Fix ${paths.config}`);
      const debug = config.debugPayload ? 'debug on' : 'debug off';
      return diagnosticResult('ok', `gateway config valid (${config.codexPromptLanguage} prompts, ${config.upstreamWireApi} upstream, compact ${config.compactReasoningEffort}/${config.compactMaxTokens}/${config.compactTimeoutMs}ms, ${debug})`, {
        path: paths.config,
        upstream: safeUrl(config.upstreamBaseUrl),
        upstreamWireApi: config.upstreamWireApi,
        promptLanguage: config.codexPromptLanguage,
        compaction: { reasoningEffort: config.compactReasoningEffort, maxTokens: config.compactMaxTokens, timeoutMs: config.compactTimeoutMs },
        proxyAuthentication: Boolean(config.proxyApiKey),
        debugPayload: Boolean(config.debugPayload),
      });
    }),
    runCheck('security.listener', 'security', async () => {
      if (!config) return diagnosticResult('skipped', 'listener security was not checked because config failed');
      const local = loopbackHost(config.host);
      if (!local && !config.proxyApiKey) {
        return diagnosticResult('fail', `${config.host}:${config.port} is exposed without proxy authentication`, { host: config.host, port: config.port }, 'Bind to loopback or configure proxyApiKey.');
      }
      if (!local) return diagnosticResult('warning', 'gateway is intentionally exposed with proxy authentication', { host: config.host, port: config.port });
      return diagnosticResult('ok', 'gateway listens on loopback', { host: config.host, port: config.port, proxyAuthentication: Boolean(config.proxyApiKey) });
    }),
    runCheck('codex.integration', 'codex', async () => {
      const executable = codexExecutableResolver();
      const versionOutput = await commandRunner(executable, ['--version']);
      const version = parseVersion(versionOutput).join('.');
      const inspected = inspectCodexConfig(env, 'deepseek-gateway');
      if (!versionAtLeast(version, MIN_CODEX_VERSION)) {
        return diagnosticResult('fail', `Codex ${version || versionOutput} is older than 0.144.0`, { executable, config: inspected.filePath }, 'Update Codex CLI.');
      }
      if (!inspected.provider) {
        return diagnosticResult('fail', 'Codex provider deepseek-gateway is missing', { version, config: inspected.filePath }, `Add [model_providers.deepseek-gateway] to ${inspected.filePath}`);
      }
      const expectedBaseUrl = config ? connectHttpUrl(config.host, config.port, '/v1') : '';
      const actualBaseUrl = String(inspected.provider.base_url || '');
      const wireApi = String(inspected.provider.wire_api || 'responses');
      const failures = [];
      if (!sameUrl(actualBaseUrl, expectedBaseUrl)) failures.push(`base_url must be ${expectedBaseUrl}`);
      if (wireApi !== 'responses') failures.push('wire_api must be responses');
      if (String(inspected.provider.requires_openai_auth || '').toLowerCase() === 'true') failures.push('requires_openai_auth must be false or omitted');
      const providerToken = inspected.provider.experimental_bearer_token || (inspected.provider.env_key && env[inspected.provider.env_key]) || '';
      if (config?.proxyApiKey && providerToken !== config.proxyApiKey) failures.push('provider authentication does not match proxyApiKey');
      if (failures.length) return diagnosticResult('fail', failures.join('; '), { version, executable, config: inspected.filePath }, `Fix [model_providers.deepseek-gateway] in ${inspected.filePath}`);
      const plainDefault = inspected.modelProvider || '(Codex default)';
      return diagnosticResult('ok', `Codex ${version}; launcher uses deepseek-gateway; plain codex uses ${plainDefault}`, {
        executable,
        config: inspected.filePath,
        baseUrl: actualBaseUrl,
        wireApi,
        launcherProvider: 'deepseek-gateway',
        plainCodexProvider: plainDefault,
      });
    }),
    runCheck('catalog.integrity', 'catalog', async () => {
      const englishCatalog = readJson(paths.catalogEn);
      const english = catalogShape(englishCatalog);
      const chinese = catalogShape(readJson(paths.catalogZh));
      if (!catalogsAligned(english, chinese)) {
        return diagnosticResult('fail', 'English and Chinese catalogs are not structurally aligned', { english: [...english.keys()], chinese: [...chinese.keys()] }, 'Align model IDs, reasoning levels, and personality keys in both catalogs.');
      }
      const catalogModels = [...english.keys()].sort();
      const catalogAliases = modelAliasesFromCatalog(englishCatalog);
      const configuredAliases = isObject(config?.modelAliases) ? config.modelAliases : catalogAliases;
      const mappedModels = Object.keys(configuredAliases).sort();
      const missingMappings = catalogModels.filter((model) => !mappedModels.includes(model));
      const extraMappings = mappedModels.filter((model) => !catalogModels.includes(model));
      if (missingMappings.length) return diagnosticResult('fail', `catalog models are missing mappings: ${missingMappings.join(', ')}`, { catalogModels, mappedModels }, 'Reinstall the gateway.');
      const mappings = Object.fromEntries(mappedModels.map((model) => {
        const resolved = resolveModelAlias(model, { ...config, modelAliases: configuredAliases });
        return [model, { upstreamModel: resolved.upstreamModel, thinking: resolved.thinking }];
      }));
      const resultStatus = extraMappings.length ? 'warning' : 'ok';
      const summary = extraMappings.length
        ? `model mappings not present in the Codex catalogs: ${extraMappings.join(', ')}`
        : `${config?.codexPromptLanguage || 'selected'} catalogs define ${catalogModels.length} aligned model mappings`;
      return diagnosticResult(resultStatus, summary, { catalogModels, mappedModels, mappings }, extraMappings.length ? 'Add the mapped models to both catalogs or remove the overrides.' : null);
    }),
    runCheck('gateway.models', 'gateway', async () => {
      if (!config || !['healthy', 'degraded'].includes(status.state)) return diagnosticResult('skipped', 'gateway model endpoint was not checked because the runtime is unavailable');
      const api = status.endpoint.runningApi || status.endpoint.configuredApi;
      const result = await fetchJson(joinUrl(api, '/models'), {
        fetchImpl,
        headers: config.proxyApiKey ? { Authorization: `Bearer ${config.proxyApiKey}` } : undefined,
        timeoutMs: config.modelsTimeoutMs,
      });
      if (!result.ok) return diagnosticResult('fail', `gateway /v1/models failed${result.status ? ` with HTTP ${result.status}` : ''}`, { latencyMs: result.latencyMs, error: result.error }, 'Check the running gateway and proxy authentication.');
      const models = Array.isArray(result.data?.data) ? result.data.data.map((model) => String(model?.id || '')).filter(Boolean).sort() : [];
      const expected = listModels(config).map((model) => model.id).sort();
      const missing = expected.filter((model) => !models.includes(model));
      if (missing.length) return diagnosticResult('fail', `gateway model list is missing: ${missing.join(', ')}`, { models, expected, latencyMs: result.latencyMs }, 'Reinstall and restart the gateway.');
      return diagnosticResult('ok', `gateway exposes ${expected.length} expected models (${result.latencyMs} ms)`, { models, latencyMs: result.latencyMs });
    }),
    runCheck('upstream.models', 'upstream', async () => {
      if (!config?.upstreamApiKey) return diagnosticResult('skipped', 'upstream was not checked because the API key is missing');
      const startedAt = Date.now();
      let response;
      try {
        response = await callModels({
          baseUrl: config.upstreamBaseUrl,
          apiKey: config.upstreamApiKey,
          timeoutMs: config.modelsTimeoutMs,
        });
      } catch (error) {
        return diagnosticResult('fail', `DeepSeek /models is unreachable: ${String(error?.message || error)}`, { upstream: safeUrl(config.upstreamBaseUrl), latencyMs: Date.now() - startedAt }, 'Check DNS, proxy, firewall, TLS, and upstreamBaseUrl.');
      }
      const data = await readJsonResponse(response);
      const latencyMs = Date.now() - startedAt;
      if (!response.ok) return diagnosticResult('fail', `DeepSeek /models returned HTTP ${response.status}`, { upstream: safeUrl(config.upstreamBaseUrl), latencyMs, error: errorMessage(data) }, response.status === 401 || response.status === 403 ? 'Check the DeepSeek API key.' : 'Check the DeepSeek endpoint and account status.');
      const models = Array.isArray(data?.data) ? data.data.map((model) => String(model?.id || '')).filter(Boolean).sort() : [];
      const targets = [...new Set(listModels(config).map((model) => resolveModelAlias(model.id, config).upstreamModel))].sort();
      const missing = models.length ? targets.filter((model) => !models.includes(model)) : [];
      if (missing.length) return diagnosticResult('warning', `DeepSeek authenticated, but /models does not list: ${missing.join(', ')}`, { upstream: safeUrl(config.upstreamBaseUrl), latencyMs, models, targets }, 'Verify the configured model mappings against the provider account.');
      return diagnosticResult('ok', `DeepSeek authentication and /models are reachable (${latencyMs} ms)`, { upstream: safeUrl(config.upstreamBaseUrl), latencyMs, models });
    }),
    runCheck('reasoning.cache', 'cache', async () => {
      if (!config) return diagnosticResult('skipped', 'reasoning cache was not checked because config failed');
      const result = cacheInspection(config);
      if (result.status === 'ok' && result.details.bytes != null) {
        result.summary = `reasoning cache valid (${formatBytes(result.details.bytes)}, ${result.details.records} records)`;
      }
      return result;
    }),
    runCheck('optional.backends', 'web', async () => {
      if (!config) return diagnosticResult('skipped', 'optional backends were not checked because config failed');
      const tavily = { enabled: Boolean(config.tavilyWebSearchEnabled), configured: Boolean(config.tavilyApiKey) };
      const firecrawl = { enabled: Boolean(config.firecrawlWebFetchEnabled), configured: Boolean(config.firecrawlApiKey) };
      const missing = [];
      if (tavily.enabled && !tavily.configured) missing.push('Tavily API key');
      if (firecrawl.enabled && !firecrawl.configured) missing.push('Firecrawl API key');
      if (missing.length) return diagnosticResult('warning', `optional backend configuration is incomplete: ${missing.join(', ')}`, { tavily, firecrawl, activeProbe: false }, `Configure the missing keys in ${paths.config} or disable the backend.`);
      if (!tavily.enabled && !firecrawl.enabled) return diagnosticResult('skipped', 'optional web backends are disabled', { tavily, firecrawl, activeProbe: false });
      const enabled = [tavily.enabled ? 'Tavily' : '', firecrawl.enabled ? 'Firecrawl' : ''].filter(Boolean).join(' and ');
      return diagnosticResult('ok', `${enabled} credentials are configured (not actively probed)`, { tavily, firecrawl, activeProbe: false });
    }),
  ]);

  const keyedChecks = Object.fromEntries(checks.map((check) => [check.id, check]));
  const counts = { ok: 0, warning: 0, fail: 0, skipped: 0 };
  for (const check of checks) counts[check.status] += 1;
  const overallStatus = counts.fail ? 'fail' : counts.warning ? 'warning' : 'ok';
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    overallStatus,
    counts,
    checks: keyedChecks,
  };
}

function formatDuration(seconds) {
  if (seconds == null) return 'unknown';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const hours = Math.floor(seconds / 3600);
  return `${hours}h ${Math.floor((seconds % 3600) / 60)}m`;
}

export function formatGatewayStatus(status) {
  const versions = [status.versions.running, status.versions.installed, status.versions.cli].filter(Boolean);
  const versionText = new Set(versions).size <= 1
    ? versions[0] || 'unknown'
    : `running ${status.versions.running || 'unknown'}, installed ${status.versions.installed || 'missing'}, CLI ${status.versions.cli || 'unknown'}`;
  const processText = status.process.pid
    ? `PID ${status.process.pid}, ${status.process.authenticated ? 'authenticated' : 'not authenticated'}, uptime ${formatDuration(status.process.uptimeSeconds)}`
    : 'not running';
  const lines = [
    `Gateway status: ${status.state.toUpperCase()}`,
    `Version: ${versionText}`,
    `Process: ${processText}`,
    `API: ${status.endpoint.runningApi || status.endpoint.configuredApi || 'unknown'}${status.endpoint.latencyMs != null ? ` (${status.endpoint.latencyMs} ms)` : ''}`,
    `Upstream wire API: ${status.configuration.upstreamWireApi || 'unknown'}`,
    `Install: ${status.paths.install}`,
    `Config: ${status.paths.config}`,
  ];
  for (const current of status.issues) {
    lines.push(`Issue: ${current.message}`);
    if (current.remediation) lines.push(`Fix: ${current.remediation}`);
  }
  return `${lines.join('\n')}\n`;
}

export function formatGatewayDoctor(report) {
  const labels = { ok: 'OK', warning: 'WARN', fail: 'FAIL', skipped: 'SKIP' };
  const lines = [`Gateway doctor: ${report.overallStatus.toUpperCase()}`];
  for (const check of Object.values(report.checks)) {
    lines.push(`${labels[check.status].padEnd(4)} ${check.category.padEnd(9)} ${check.summary}`);
    if ((check.status === 'warning' || check.status === 'fail') && check.remediation) {
      lines.push(`     Fix: ${check.remediation}`);
    }
  }
  lines.push(`${report.counts.ok} ok, ${report.counts.warning} warnings, ${report.counts.fail} failures, ${report.counts.skipped} skipped`);
  return `${lines.join('\n')}\n`;
}
