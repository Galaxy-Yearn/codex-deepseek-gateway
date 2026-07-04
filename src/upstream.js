import { joinUrl, SseParser, safeJsonParse } from './common.js';

function buildHeaders(apiKey, extra = {}) {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

export async function readJsonResponse(response) {
  const text = await response.text();
  const parsed = safeJsonParse(text);
  return parsed.ok ? parsed.value : { raw: text };
}

function mergeAbortSignals(...signals) {
  const activeSignals = signals.filter(Boolean);
  if (!activeSignals.length) return undefined;
  if (activeSignals.length === 1) return activeSignals[0];
  if (typeof AbortSignal?.any === 'function') {
    return AbortSignal.any(activeSignals);
  }

  const controller = new AbortController();
  for (const signal of activeSignals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      return controller.signal;
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

export async function callChatCompletions({
  baseUrl,
  apiKey,
  request,
  timeoutMs,
  signal,
}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const finalSignal = mergeAbortSignals(signal, controller.signal);
  try {
    const response = await fetch(joinUrl(baseUrl, '/chat/completions'), {
      method: 'POST',
      headers: buildHeaders(apiKey),
      body: JSON.stringify(request),
      signal: finalSignal,
    });
    return response;
  } finally {
    clearTimeout(timeout);
  }
}

export async function callModels({
  baseUrl,
  apiKey,
  timeoutMs,
  signal,
}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const finalSignal = mergeAbortSignals(signal, controller.signal);
  try {
    return await fetch(joinUrl(baseUrl, '/models'), {
      method: 'GET',
      headers: buildHeaders(apiKey),
      signal: finalSignal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

export async function relayChatCompletionsResponse({
  upstreamResponse,
  res,
  onStreamChunk,
  passThrough = true,
  writeHeaders = true,
  endResponse = true,
}) {
  const contentType = upstreamResponse.headers.get('content-type') || '';
  const isStream = contentType.includes('text/event-stream');
  const writable = () => !res.destroyed && !res.writableEnded;

  if (!isStream) {
    const data = await readJsonResponse(upstreamResponse);
    if (typeof onStreamChunk === 'function') {
      onStreamChunk({ data });
      onStreamChunk({ done: true });
    }
    if (passThrough && writable()) {
      res.writeHead(upstreamResponse.status, {
        'content-type': 'application/json; charset=utf-8',
      });
      res.end(JSON.stringify(data));
    } else if (endResponse && writable()) {
      res.end();
    }
    return;
  }

  if (writeHeaders && writable()) {
    res.writeHead(upstreamResponse.status, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
  }

  const reader = upstreamResponse.body?.getReader?.();
  if (!reader) {
    if (endResponse && writable()) res.end();
    return;
  }

  const parser = new SseParser();
  let sawDone = false;
  const emitDone = ({ eof = false } = {}) => {
    if (sawDone) return;
    sawDone = true;
    if (typeof onStreamChunk === 'function') onStreamChunk(eof ? { done: true, eof: true } : { done: true });
    if (passThrough && writable()) res.write(`data: [DONE]\n\n`);
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const events = parser.push(value);
    for (const event of events) {
      if (event.done) {
        emitDone();
        if (endResponse && writable()) res.end();
        return;
      }
      if (typeof onStreamChunk === 'function') onStreamChunk(event);
      if (passThrough && writable()) res.write(`data: ${event.data}\n\n`);
    }
  }

  for (const event of parser.end()) {
    if (event.done) {
      emitDone();
      break;
    }
    if (typeof onStreamChunk === 'function') onStreamChunk(event);
    if (passThrough && writable()) res.write(`data: ${event.data}\n\n`);
  }
  emitDone({ eof: true });
  if (endResponse && writable()) res.end();
}
