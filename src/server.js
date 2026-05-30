import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { generateId, safeJsonParse } from './common.js';
import { listModels, mergeModelLists, normalizeModelList } from './model-map.js';
import {
  assistantMessageFromResponseOutput,
  convertChatCompletionToResponses,
  extractToolCallIdsFromMessages,
  normalizeResponsesRequest,
  ResponsesStreamMapper,
  serializeResponsesSseEvent,
  toChatCompletionsRequest,
  toProviderChatCompletionsRequest,
} from './protocol.js';
import { SessionStore } from './session-store.js';
import { callChatCompletions, callModels, readJsonResponse, relayChatCompletionsResponse } from './upstream.js';

function sendJson(res, statusCode, payload, headers = {}) {
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    ...headers,
  });
  res.end(JSON.stringify(payload));
}

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function getRequestPath(req) {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  return url.pathname;
}

function isAuthorized(req, config) {
  if (!config.proxyApiKey) return true;
  const authorization = req.headers.authorization || '';
  const bearerToken = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  return bearerToken === config.proxyApiKey || req.headers['x-api-key'] === config.proxyApiKey;
}

function conversationIdFromRequest(request, normalized) {
  const conversation = normalized.conversation ?? request.conversation;
  if (typeof conversation === 'string') return conversation;
  if (conversation && typeof conversation === 'object') return conversation.id || conversation.conversation_id || null;
  return request.conversation_id || null;
}

function historyMessagesFromSession(session) {
  if (!session?.history?.length) return [];
  const messages = [];
  for (const turn of session.history) {
    if (Array.isArray(turn.inputMessages)) {
      messages.push(...turn.inputMessages);
    } else if (Array.isArray(turn.chatRequest?.messages)) {
      messages.push(...turn.chatRequest.messages);
    }
    if (turn.assistantMessage) {
      messages.push(turn.assistantMessage);
    }
  }
  return messages;
}

function prependMissingAssistantToolMessages(messages, sessions) {
  const existingToolCallIds = new Set();
  const missingToolOutputIds = [];
  for (const message of messages) {
    if (message?.role === 'assistant' && Array.isArray(message.tool_calls)) {
      for (const toolCall of message.tool_calls) {
        if (toolCall?.id) existingToolCallIds.add(toolCall.id);
      }
      continue;
    }
    if (message?.role === 'tool' && message.tool_call_id && !existingToolCallIds.has(message.tool_call_id)) {
      missingToolOutputIds.push(message.tool_call_id);
    }
  }

  if (!missingToolOutputIds.length) return messages;
  const prefix = [];
  const inserted = new Set(existingToolCallIds);
  for (const callId of missingToolOutputIds) {
    if (inserted.has(callId)) continue;
    const assistantMessage = sessions.getAssistantMessageForToolCall(callId);
    if (!assistantMessage) continue;
    prefix.push(assistantMessage);
    for (const id of extractToolCallIdsFromMessages([assistantMessage])) inserted.add(id);
  }
  return prefix.length ? prefix.concat(messages) : messages;
}

function summarizeMessage(message, index) {
  return {
    index,
    role: message?.role,
    content_type: Array.isArray(message?.content) ? 'array' : typeof message?.content,
    has_reasoning_content: typeof message?.reasoning_content === 'string',
    reasoning_content_length: typeof message?.reasoning_content === 'string' ? message.reasoning_content.length : undefined,
    tool_call_ids: Array.isArray(message?.tool_calls) ? message.tool_calls.map((toolCall) => toolCall?.id).filter(Boolean) : undefined,
    tool_call_id: message?.tool_call_id,
  };
}

function logDebugPayload(config, request) {
  if (!config.debugPayload) return;
  const summary = {
    model: request.model,
    stream: request.stream,
    thinking: request.thinking,
    reasoning_effort: request.reasoning_effort,
    messages: Array.isArray(request.messages) ? request.messages.map(summarizeMessage) : [],
  };
  process.stderr.write(`[codex-deepseek-gateway] upstream request ${JSON.stringify(summary)}\n`);
}

function resolveReasoningStreamMode(config, upstreamRequest) {
  if (String(config.codexHideAgentReasoning).toLowerCase() === 'true') {
    return { emitReasoningSummary: false, emitReasoningText: false };
  }
  const thinkingEnabled = upstreamRequest?.thinking?.type === 'enabled';
  if (thinkingEnabled) {
    return { emitReasoningSummary: true, emitReasoningText: false };
  }
  return { emitReasoningSummary: false, emitReasoningText: false };
}

export function createProxyServer({ config = loadConfig(), sessions = new SessionStore() } = {}) {
  let modelCache = null;

  async function getModelList() {
    const localModels = listModels(config);
    if (!config.fetchUpstreamModels || !config.upstreamApiKey) return localModels;
    if (modelCache && modelCache.expiresAt > Date.now()) return modelCache.data;

    try {
      const response = await callModels({
        baseUrl: config.upstreamBaseUrl,
        apiKey: config.upstreamApiKey,
        timeoutMs: config.modelsTimeoutMs || 5000,
      });
      if (!response.ok) return localModels;
      const data = await readJsonResponse(response);
      const upstreamModels = normalizeModelList(data, config);
      const models = mergeModelLists(upstreamModels, localModels);
      modelCache = {
        data: models,
        expiresAt: Date.now() + (config.modelsCacheMs || 60000),
      };
      return models;
    } catch {
      return localModels;
    }
  }

  async function handleResponsesWithState(req, res) {
    const raw = await readRequestBody(req);
    const parsed = safeJsonParse(raw);
    if (!parsed.ok || !parsed.value || typeof parsed.value !== 'object') {
      sendJson(res, 400, { error: { message: 'Invalid JSON body' } });
      return;
    }

    const request = parsed.value;
    const normalized = normalizeResponsesRequest(request);
    const currentInputMessages = normalized.messages.slice();
    const previousResponseId = normalized.previous_response_id || request.previous_response_id || null;
    const conversationId = conversationIdFromRequest(request, normalized);
    const priorSession = previousResponseId ? sessions.get(previousResponseId) : conversationId ? sessions.getConversation(conversationId) : null;
    if (priorSession?.history?.length) {
      const priorMessages = historyMessagesFromSession(priorSession);
      normalized.messages = priorMessages.concat(normalized.messages);
    }
    normalized.messages = prependMissingAssistantToolMessages(normalized.messages, sessions);

    const chatRequest = toChatCompletionsRequest(normalized);
    const upstreamRequest = toProviderChatCompletionsRequest(chatRequest, config);
    if (!upstreamRequest.model) upstreamRequest.model = config.upstreamModel || normalized.model;
    logDebugPayload(config, upstreamRequest);

    if (!upstreamRequest.model) {
      sendJson(res, 400, { error: { message: 'Missing model' } });
      return;
    }
    if (!config.upstreamApiKey) {
      sendJson(res, 500, { error: { message: 'Missing UPSTREAM_API_KEY' } });
      return;
    }

    const responseId = generateId('resp');
    const nextSession = { id: responseId, history: [] };

    const upstreamResponse = await callChatCompletions({
      baseUrl: config.upstreamBaseUrl,
      apiKey: config.upstreamApiKey,
      request: upstreamRequest,
      timeoutMs: config.upstreamTimeoutMs,
    });

    const model = upstreamRequest.model;

    if (!upstreamResponse.ok) {
      const data = await readJsonResponse(upstreamResponse);
      sendJson(res, upstreamResponse.status, data);
      return;
    }

    if (!upstreamRequest.stream) {
      const data = await readJsonResponse(upstreamResponse);
      const payload = convertChatCompletionToResponses({
        completion: data,
        model,
        previousResponseId,
        normalized,
        responseId,
      });
      nextSession.history.push({
        request: normalized,
        chatRequest,
        upstreamRequest,
        inputMessages: currentInputMessages,
        assistantMessage: assistantMessageFromResponseOutput(payload.output),
        createdAt: Date.now(),
      });
      sessions.set(responseId, nextSession);
      sessions.setConversation(conversationId, responseId);
      sendJson(res, 200, payload);
      return;
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });

    const mapper = new ResponsesStreamMapper({
      responseId,
      model,
      createdAt: Math.floor(Date.now() / 1000),
      previousResponseId,
      normalized,
      ...(() => {
        const reasoningMode = resolveReasoningStreamMode(config, upstreamRequest);
        return {
          bufferOutputUntilDone: upstreamRequest?.thinking?.type === 'enabled',
          ...reasoningMode,
        };
      })(),
    });
    let doneSent = false;
    const writeResponsesDone = () => {
      if (doneSent) return;
      doneSent = true;
      res.write(serializeResponsesSseEvent({ done: true }));
    };

    res.write(serializeResponsesSseEvent(mapper.createdEvent()));
    res.write(serializeResponsesSseEvent(mapper.inProgressEvent()));

    await relayChatCompletionsResponse({
      upstreamResponse,
      res,
      passThrough: false,
      writeHeaders: false,
      onStreamChunk(event) {
        const events = mapper.mapChatEvent(event);
        for (const responseEvent of events) {
          res.write(serializeResponsesSseEvent(responseEvent));
        }
        if (event?.done) writeResponsesDone();
      },
    });

    nextSession.history.push({
      request: normalized,
      chatRequest,
      upstreamRequest,
      inputMessages: currentInputMessages,
      assistantMessage: mapper.assistantMessage(),
      createdAt: Date.now(),
    });
    sessions.set(responseId, nextSession);
    sessions.setConversation(conversationId, responseId);
  }

  return http.createServer(async (req, res) => {
    try {
      const path = getRequestPath(req);

      if (req.method === 'GET' && path === '/health') {
        sendJson(res, 200, { ok: true });
        return;
      }

      if (path.startsWith('/v1/') && !isAuthorized(req, config)) {
        sendJson(res, 401, { error: { message: 'Unauthorized' } });
        return;
      }

      if (req.method === 'GET' && path === '/v1/models') {
        sendJson(res, 200, { object: 'list', data: await getModelList() });
        return;
      }

      if (req.method === 'POST' && path === '/v1/responses') {
        await handleResponsesWithState(req, res);
        return;
      }

      if (req.method === 'POST' && path === '/v1/chat/completions') {
        const body = safeJsonParse(await readRequestBody(req));
        if (!body.ok) {
          sendJson(res, 400, { error: { message: 'Invalid JSON body' } });
          return;
        }
        const upstreamRequest = body.value;
        if (!config.upstreamApiKey) {
          sendJson(res, 500, { error: { message: 'Missing UPSTREAM_API_KEY' } });
          return;
        }
        const upstreamResponse = await callChatCompletions({
          baseUrl: config.upstreamBaseUrl,
          apiKey: config.upstreamApiKey,
          request: upstreamRequest,
          timeoutMs: config.upstreamTimeoutMs,
        });
        await relayChatCompletionsResponse({ upstreamResponse, res, passThrough: true });
        return;
      }

      sendJson(res, 404, { error: { message: 'Not found' } });
    } catch (error) {
      sendJson(res, 500, { error: { message: error.message || 'Internal server error' } });
    }
  });
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const config = loadConfig();
  const server = createProxyServer({ config });
  server.listen(config.port, config.host, () => {
    process.stdout.write(`listening on http://${config.host}:${config.port}\n`);
  });
}
