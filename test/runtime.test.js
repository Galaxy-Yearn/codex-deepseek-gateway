import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  closeServerGracefully,
  connectHttpUrl,
  listenServer,
  parseRuntimeRecord,
  positiveInteger,
  readRuntimeRecord,
  removeRuntimeRecord,
  writeRuntimeRecord,
} from '../src/runtime.js';

test('runtime addressing, server lifecycle, and records', async () => {
  assert.equal(positiveInteger('42', 7), 42);
  assert.equal(positiveInteger('0', 7), 7);
  assert.equal(connectHttpUrl('127.0.0.1', 3000, '/health'), 'http://127.0.0.1:3000/health');
  assert.equal(connectHttpUrl('0.0.0.0', 3000, '/health'), 'http://127.0.0.1:3000/health');
  assert.equal(connectHttpUrl('::1', 3000, '/health'), 'http://[::1]:3000/health');
  assert.equal(connectHttpUrl('::', 3000, '/health'), 'http://[::1]:3000/health');
  assert.deepEqual(parseRuntimeRecord('42'), {
    version: 0,
    pid: 42,
    instanceId: '',
    controlUrl: '',
    shutdownToken: '',
  });

  const server = http.createServer((_request, response) => response.end('ok'));
  const address = await listenServer(server, 0, '127.0.0.1');
  const response = await fetch(`http://127.0.0.1:${address.port}`);
  assert.equal(await response.text(), 'ok');
  const closing = closeServerGracefully(server, 1000);
  assert.equal(closeServerGracefully(server, 1000), closing);
  await closing;

  const occupied = http.createServer();
  const occupiedAddress = await listenServer(occupied, 0, '127.0.0.1');
  const conflict = http.createServer();
  try {
    await assert.rejects(listenServer(conflict, occupiedAddress.port, '127.0.0.1'), (error) => error.code === 'EADDRINUSE');
  } finally {
    await closeServerGracefully(conflict, 1000);
    await closeServerGracefully(occupied, 1000);
  }

  const dir = await mkdtemp(join(tmpdir(), 'gateway-runtime-'));
  const file = join(dir, 'gateway.pid');
  const record = {
    version: 3,
    pid: 123,
    instanceId: 'instance',
    controlUrl: 'http://127.0.0.1:4567',
    shutdownToken: 'token',
    startedAt: 1,
    packageVersion: '1.2.3',
    dataUrl: 'http://127.0.0.1:3000',
  };
  try {
    writeRuntimeRecord(file, record);
    assert.deepEqual(readRuntimeRecord(file), record);
    removeRuntimeRecord(file, 'other');
    assert.deepEqual(readRuntimeRecord(file), record);
    removeRuntimeRecord(file, 'instance');
    assert.equal(readRuntimeRecord(file).pid, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
