import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

async function scenario(name, run) {
  try {
    await run();
  } catch (error) {
    error.message = `${name}: ${error.message}`;
    throw error;
  }
}
import {
  callChatCompletions,
  callModels,
  readJsonResponse,
  relayChatCompletionsResponse,
} from '../src/upstream.js';

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function responseCollector() {
  return {
    destroyed: false,
    writableEnded: false,
    status: null,
    headers: null,
    chunks: [],
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    write(chunk) {
      this.chunks.push(String(chunk));
      return true;
    },
    end(chunk) {
      if (chunk !== undefined) this.chunks.push(String(chunk));
      this.writableEnded = true;
    },
  };
}

test('upstream request contract and failure propagation', async () => {
  await scenario('reads JSON responses and preserves non-JSON bodies for diagnostics', async () => {
  assert.deepEqual(await readJsonResponse(new Response('{"ok":true}')), { ok: true });
  assert.deepEqual(await readJsonResponse(new Response('gateway unavailable')), { raw: 'gateway unavailable' });
  });
  await scenario('sends chat completion and model requests with the expected wire contract', async () => {
  const requests = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({
      method: req.method,
      url: req.url,
      authorization: req.headers.authorization,
      contentType: req.headers['content-type'],
      body: Buffer.concat(chunks).toString('utf8'),
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(req.url === '/models' ? '{"data":[]}' : '{"choices":[]}');
  });
  const baseUrl = await listen(upstream);

  try {
    const chatResponse = await callChatCompletions({
      baseUrl: `${baseUrl}/`,
      apiKey: 'secret',
      request: { model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'hi' }] },
      timeoutMs: 1000,
    });
    const modelsResponse = await callModels({ baseUrl, apiKey: 'secret', timeoutMs: 1000 });
    assert.equal(chatResponse.status, 200);
    assert.equal(modelsResponse.status, 200);
    assert.deepEqual(requests.map((request) => [request.method, request.url]), [
      ['POST', '/chat/completions'],
      ['GET', '/models'],
    ]);
    assert.equal(requests.every((request) => request.authorization === 'Bearer secret'), true);
    assert.equal(requests.every((request) => request.contentType === 'application/json'), true);
    assert.deepEqual(JSON.parse(requests[0].body), {
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(requests[1].body, '');
  } finally {
    await close(upstream);
  }
  });
  await scenario('honors caller aborts and request timeouts when signals are combined', async () => {
  const upstream = http.createServer(async (_req, res) => {
    await new Promise((resolve) => setTimeout(resolve, 500));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"data":[]}');
  });
  const baseUrl = await listen(upstream);

  try {
    const caller = new AbortController();
    const callerRequest = callModels({ baseUrl, apiKey: 'key', timeoutMs: 1000, signal: caller.signal });
    caller.abort(new Error('cancelled by caller'));
    await assert.rejects(callerRequest, (error) => error?.message === 'cancelled by caller');

    const startedAt = Date.now();
    await assert.rejects(
      callModels({ baseUrl, apiKey: 'key', timeoutMs: 40, signal: new AbortController().signal }),
      (error) => error?.name === 'AbortError',
    );
    assert.ok(Date.now() - startedAt < 400);
  } finally {
    await close(upstream);
  }
  });
  await scenario('surfaces network failures without rewriting them', async () => {
  const server = http.createServer();
  const baseUrl = await listen(server);
  await close(server);
  await assert.rejects(
    callChatCompletions({
      baseUrl,
      apiKey: 'key',
      request: { model: 'deepseek-v4-flash', messages: [] },
      timeoutMs: 1000,
    }),
    (error) => error instanceof TypeError,
  );
  });
});

test('upstream response relay lifecycle', async () => {
  await scenario('relays non-streaming responses and reports one synthetic stream completion', async () => {
  const res = responseCollector();
  const chunks = [];
  await relayChatCompletionsResponse({
    upstreamResponse: new Response('not json', {
      status: 502,
      headers: { 'content-type': 'text/plain' },
    }),
    res,
    onStreamChunk: (chunk) => chunks.push(chunk),
  });

  assert.equal(res.status, 502);
  assert.deepEqual(res.headers, { 'content-type': 'application/json; charset=utf-8' });
  assert.equal(res.chunks.join(''), '{"raw":"not json"}');
  assert.equal(res.writableEnded, true);
  assert.deepEqual(chunks, [{ data: { raw: 'not json' } }, { done: true }]);
  });
  await scenario('relays fragmented SSE frames, preserves data, and terminates exactly once', async () => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"he"}}]}\r\n'));
      controller.enqueue(encoder.encode('\r\ndata: {"choices":[{"delta":{"content":"llo"}}]}\n\n'));
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
  const res = responseCollector();
  const chunks = [];
  await relayChatCompletionsResponse({
    upstreamResponse: new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
    }),
    res,
    onStreamChunk: (chunk) => chunks.push(chunk),
  });

  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'text/event-stream; charset=utf-8');
  assert.match(res.chunks.join(''), /"he"/);
  assert.match(res.chunks.join(''), /"llo"/);
  assert.equal(res.chunks.join('').match(/\[DONE\]/g)?.length, 1);
  assert.deepEqual(chunks.map((chunk) => chunk.done || JSON.parse(chunk.data).choices[0].delta.content), [
    'he',
    'llo',
    true,
  ]);
  assert.equal(res.writableEnded, true);
  });
  await scenario('marks premature SSE EOF and tolerates absent stream bodies', async () => {
  const encoder = new TextEncoder();
  const eofChunks = [];
  const eofRes = responseCollector();
  await relayChatCompletionsResponse({
    upstreamResponse: new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[]}\n\n'));
        controller.close();
      },
    }), { headers: { 'content-type': 'text/event-stream' } }),
    res: eofRes,
    onStreamChunk: (chunk) => eofChunks.push(chunk),
    passThrough: false,
  });
  assert.deepEqual(eofChunks, [{ event: 'message', data: '{"choices":[]}' }, { done: true, eof: true }]);
  assert.equal(eofRes.writableEnded, true);

  const emptyRes = responseCollector();
  await relayChatCompletionsResponse({
    upstreamResponse: new Response(null, { headers: { 'content-type': 'text/event-stream' } }),
    res: emptyRes,
  });
  assert.equal(emptyRes.writableEnded, true);
  });
  await scenario('does not write after the downstream response is closed', async () => {
  const res = responseCollector();
  res.destroyed = true;
  const chunks = [];
  await relayChatCompletionsResponse({
    upstreamResponse: new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } }),
    res,
    onStreamChunk: (chunk) => chunks.push(chunk),
  });
  assert.equal(res.status, null);
  assert.deepEqual(res.chunks, []);
  assert.equal(res.writableEnded, false);
  assert.deepEqual(chunks, [{ data: { ok: true } }, { done: true }]);
  });
});
