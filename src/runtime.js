import { timingSafeEqual } from 'node:crypto';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';

export const DEFAULT_REQUEST_BODY_MAX_BYTES = 64 * 1024 * 1024;
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30000;
export const SHUTDOWN_TOKEN_HEADER = 'x-gateway-shutdown-token';

export function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

const gracefulShutdowns = new WeakMap();

export function closeServerGracefully(server, configuredTimeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS) {
  const current = gracefulShutdowns.get(server);
  if (current) return current;
  const timeoutMs = positiveInteger(configuredTimeoutMs, DEFAULT_SHUTDOWN_TIMEOUT_MS);
  const closing = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => server.closeAllConnections?.(), timeoutMs);
    timeout.unref();
    server.close((error) => {
      clearTimeout(timeout);
      if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') {
        reject(error);
        return;
      }
      resolve();
    });
  });
  gracefulShutdowns.set(server, closing);
  return closing;
}

function validToken(req, expectedToken) {
  const providedToken = req.headers[SHUTDOWN_TOKEN_HEADER];
  if (!expectedToken || typeof providedToken !== 'string') return false;
  const expected = Buffer.from(expectedToken);
  const provided = Buffer.from(providedToken);
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}

function sendJson(res, statusCode, payload, headers = {}) {
  res.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(payload));
}

export function createControlServer({ token, instanceId, onShutdown, status = {} }) {
  return http.createServer((req, res) => {
    const path = new URL(req.url || '/', 'http://localhost').pathname;
    if (!validToken(req, token)) {
      sendJson(res, 404, { error: { message: 'Not found' } });
      return;
    }
    if (req.method === 'GET' && path === '/status') {
      const details = typeof status === 'function' ? status() : status;
      sendJson(res, 200, { ...details, ok: true, pid: process.pid, instanceId });
      return;
    }
    if (req.method === 'POST' && path === '/shutdown') {
      res.once('finish', onShutdown);
      sendJson(res, 202, { ok: true }, { connection: 'close' });
      return;
    }
    sendJson(res, 404, { error: { message: 'Not found' } });
  });
}

export function listenServer(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve(server.address());
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

export function connectHttpUrl(host, port, path = '') {
  const configuredHost = String(host || '127.0.0.1').trim();
  const unwrappedHost = configuredHost.replace(/^\[|\]$/g, '');
  const connectHost = unwrappedHost === '0.0.0.0' ? '127.0.0.1' : unwrappedHost === '::' ? '::1' : unwrappedHost;
  const authority = connectHost.includes(':') ? `[${connectHost}]` : connectHost;
  const suffix = path && !String(path).startsWith('/') ? `/${path}` : path;
  return `http://${authority}:${port}${suffix}`;
}

export function parseRuntimeRecord(raw) {
  const text = String(raw || '').trim();
  const legacyPid = Number(text);
  if (Number.isSafeInteger(legacyPid) && legacyPid > 0) {
    return { version: 0, pid: legacyPid, instanceId: '', controlUrl: '', shutdownToken: '' };
  }
  try {
    const value = JSON.parse(text);
    const pid = Number(value?.pid);
    return {
      version: positiveInteger(value?.version, 1),
      pid: Number.isSafeInteger(pid) && pid > 0 ? pid : 0,
      instanceId: typeof value?.instanceId === 'string' ? value.instanceId : '',
      controlUrl: typeof value?.controlUrl === 'string' ? value.controlUrl : '',
      shutdownToken: typeof value?.shutdownToken === 'string' ? value.shutdownToken : '',
      startedAt: Number.isFinite(Number(value?.startedAt)) ? Number(value.startedAt) : 0,
      packageVersion: typeof value?.packageVersion === 'string' ? value.packageVersion : '',
      dataUrl: typeof value?.dataUrl === 'string' ? value.dataUrl : '',
    };
  } catch {
    return { version: 0, pid: 0, instanceId: '', controlUrl: '', shutdownToken: '' };
  }
}

export function readRuntimeRecord(path) {
  try {
    return parseRuntimeRecord(readFileSync(path, 'utf8'));
  } catch {
    return parseRuntimeRecord('');
  }
}

export function writeRuntimeRecord(path, record) {
  const temporaryPath = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporaryPath, JSON.stringify(record), { mode: 0o600 });
    renameSync(temporaryPath, path);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

export function removeRuntimeRecord(path, instanceId = '') {
  if (!path) return;
  const current = readRuntimeRecord(path);
  if (instanceId && current.instanceId !== instanceId) return;
  rmSync(path, { force: true });
}
