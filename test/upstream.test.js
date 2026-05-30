import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { callModels } from '../src/upstream.js';

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

test('request timeout still aborts when caller also passes a signal', async () => {
  const upstream = http.createServer(async (_req, res) => {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [] }));
  });
  const upstreamUrl = await listen(upstream);
  const externalController = new AbortController();
  const startedAt = Date.now();

  try {
    await assert.rejects(
      callModels({
        baseUrl: upstreamUrl,
        apiKey: 'test-key',
        timeoutMs: 50,
        signal: externalController.signal,
      }),
      (error) => error?.name === 'AbortError',
    );
    const elapsedMs = Date.now() - startedAt;
    assert.ok(elapsedMs < 400);
  } finally {
    await close(upstream);
  }
});
