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
import {
  applyWebSearchOutputCompatibility,
  buildWebSearchCallItem,
  containsWebSearchTool,
  executeWebSearchCalls,
  INTERNAL_WEB_SEARCH_TOOL,
  maxWebSearchRounds,
  prepareWebSearchRequest,
  shouldIncludeSearchSources,
  shouldContinueWebSearchLoop,
} from './web-search-emulator.js';

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
    if (Array.isArray(turn.historyMessages)) {
      messages.push(...turn.historyMessages);
      continue;
    }
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

function hasTavilyWebSearch(config, normalized) {
  return Boolean(config.tavilyWebSearchEnabled && config.tavilyApiKey && containsWebSearchTool(normalized));
}

function disableStreaming(request) {
  return {
    ...request,
    stream: false,
    stream_options: undefined,
  };
}

function addUsage(left, right) {
  if (!left) return right || null;
  if (!right) return left;
  return {
    prompt_tokens: (left.prompt_tokens || 0) + (right.prompt_tokens || 0),
    completion_tokens: (left.completion_tokens || 0) + (right.completion_tokens || 0),
    total_tokens: (left.total_tokens || 0) + (right.total_tokens || 0),
    reasoning_tokens: (left.reasoning_tokens || 0) + (right.reasoning_tokens || 0),
    prompt_tokens_details: {
      cached_tokens: (left.prompt_tokens_details?.cached_tokens || 0) + (right.prompt_tokens_details?.cached_tokens || 0),
    },
    completion_tokens_details: {
      reasoning_tokens:
        (left.completion_tokens_details?.reasoning_tokens || 0) +
        (right.completion_tokens_details?.reasoning_tokens || 0),
    },
  };
}

function combineUsage(completions) {
  return completions.reduce((usage, completion) => addUsage(usage, completion?.usage), null);
}

function cloneCompletionWithUsage(completion, usage) {
  if (!usage) return completion;
  return {
    ...completion,
    usage,
  };
}

async function callUpstreamJson({ upstreamRequest, config }) {
  const response = await callChatCompletions({
    baseUrl: config.upstreamBaseUrl,
    apiKey: config.upstreamApiKey,
    request: upstreamRequest,
    timeoutMs: config.upstreamTimeoutMs,
  });
  const data = await readJsonResponse(response);
  return { response, data };
}

async function runWebSearchChatLoop({ normalized, chatRequest, config, onSearchStart, onSearchDone }) {
  const effectiveChatRequest = { ...chatRequest, normalized };
  const state = prepareWebSearchRequest({ normalized, chatRequest: effectiveChatRequest, config });
  const searchConfig = state.config || config;
  let currentChatRequest = state.enabled ? state.chatRequest : effectiveChatRequest;
  const completions = [];
  const searches = [];
  let finalCompletion = null;
  let finalResponse = null;

  for (let round = 0; round <= maxWebSearchRounds(searchConfig); round += 1) {
    const upstreamRequest = toProviderChatCompletionsRequest(currentChatRequest, config);
    if (!upstreamRequest.model) upstreamRequest.model = config.upstreamModel || currentChatRequest.model;
    const { response, data } = await callUpstreamJson({
      upstreamRequest: disableStreaming(upstreamRequest),
      config,
    });
    finalResponse = response;
    if (!response.ok) return { ok: false, status: response.status, data };
    completions.push(data);
    finalCompletion = data;

    if (!state.enabled || !shouldContinueWebSearchLoop(data) || round >= maxWebSearchRounds(searchConfig)) {
      break;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), searchConfig.tavilyTimeoutMs || 15000);
    let toolResult;
    try {
      toolResult = await executeWebSearchCalls({
        completion: data,
        config: searchConfig,
        signal: controller.signal,
        onSearchStart,
        onSearchDone,
      });
    } finally {
      clearTimeout(timeout);
    }
    searches.push(...toolResult.searches);
    currentChatRequest = {
      ...currentChatRequest,
      messages: currentChatRequest.messages.concat(toolResult.messages),
      tool_choice:
        currentChatRequest.tool_choice?.function?.name === INTERNAL_WEB_SEARCH_TOOL
          ? 'auto'
          : currentChatRequest.tool_choice,
    };
  }

  return {
    ok: true,
    response: finalResponse,
    completion: cloneCompletionWithUsage(finalCompletion, combineUsage(completions)),
    searches,
    chatRequest: currentChatRequest,
  };
}

function responseEventsFromPayload(payload, { responseId, model, previousResponseId, normalized }) {
  const mapper = new ResponsesStreamMapper({
    responseId,
    model,
    createdAt: payload.created_at || Math.floor(Date.now() / 1000),
    previousResponseId,
    normalized,
    emitReasoningSummary: true,
    emitReasoningText: false,
  });
  const events = [mapper.createdEvent(), mapper.inProgressEvent()];
  events.push(...outputEventsFromPayload(payload, mapper));
  events.push(completedEventFromPayload(payload, mapper));
  return events;
}

function outputEventsFromPayload(payload, mapper, { skipTypes = new Set() } = {}) {
  const events = [];
  const output = Array.isArray(payload.output) ? payload.output : [];
  for (const [outputIndex, item] of output.entries()) {
    if (skipTypes.has(item?.type)) continue;
    mapper.output[outputIndex] = item;
    events.push({
      type: 'response.output_item.added',
      sequence_number: mapper.nextSequence(),
      output_index: outputIndex,
      item,
    });
    if (item.type === 'message' && Array.isArray(item.content)) {
      for (const [contentIndex, part] of item.content.entries()) {
        events.push({
          type: 'response.content_part.added',
          sequence_number: mapper.nextSequence(),
          output_index: outputIndex,
          content_index: contentIndex,
          item_id: item.id,
          part: part.type === 'output_text' ? { ...part, text: '', annotations: [] } : part,
        });
        if (part.type === 'output_text' && part.text) {
          events.push({
            type: 'response.output_text.delta',
            sequence_number: mapper.nextSequence(),
            output_index: outputIndex,
            content_index: contentIndex,
            item_id: item.id,
            delta: part.text,
            logprobs: [],
          });
          for (const [annotationIndex, annotation] of (Array.isArray(part.annotations) ? part.annotations : []).entries()) {
            events.push({
              type: 'response.output_text.annotation.added',
              sequence_number: mapper.nextSequence(),
              output_index: outputIndex,
              content_index: contentIndex,
              item_id: item.id,
              annotation_index: annotationIndex,
              annotation,
            });
          }
          events.push({
            type: 'response.output_text.done',
            sequence_number: mapper.nextSequence(),
            output_index: outputIndex,
            content_index: contentIndex,
            item_id: item.id,
            text: part.text,
            logprobs: [],
          });
        }
        events.push({
          type: 'response.content_part.done',
          sequence_number: mapper.nextSequence(),
          output_index: outputIndex,
          content_index: contentIndex,
          item_id: item.id,
          part,
        });
      }
    }
    events.push({
      type: 'response.output_item.done',
      sequence_number: mapper.nextSequence(),
      output_index: outputIndex,
      item,
    });
  }
  return events;
}

function completedEventFromPayload(payload, mapper) {
  return {
    type: payload.status === 'incomplete' ? 'response.incomplete' : 'response.completed',
    sequence_number: mapper.nextSequence(),
    response: payload,
  };
}

function writeSseEvent(res, event) {
  res.write(serializeResponsesSseEvent(event));
}

function writeSseDone(res) {
  writeSseEvent(res, { done: true });
}

function webSearchSseWriter({ res, mapper, outputIndexBySearch, includeSources = false }) {
  return {
    start(search) {
      const outputIndex = mapper.output.length;
      outputIndexBySearch.set(search.id, outputIndex);
      const item = buildWebSearchCallItem(search, { status: 'in_progress', includeSources });
      mapper.output.push(item);
      writeSseEvent(res, {
        type: 'response.output_item.added',
        sequence_number: mapper.nextSequence(),
        output_index: outputIndex,
        item,
      });
    },
    done(search) {
      const outputIndex = outputIndexBySearch.get(search.id);
      const item = buildWebSearchCallItem(search, { includeSources });
      if (Number.isInteger(outputIndex)) mapper.output[outputIndex] = item;
      writeSseEvent(res, {
        type: 'response.output_item.done',
        sequence_number: mapper.nextSequence(),
        output_index: Number.isInteger(outputIndex) ? outputIndex : mapper.output.indexOf(item),
        item,
      });
    },
  };
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
    const useWebSearchEmulator = hasTavilyWebSearch(config, normalized);
    let upstreamRequest = toProviderChatCompletionsRequest(chatRequest, config);
    if (!upstreamRequest.model) upstreamRequest.model = config.upstreamModel || normalized.model;

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

    if (useWebSearchEmulator) {
      const streamWebSearch = Boolean(request.stream);
      let streamMapper = null;
      let streamSearchWriter = null;
      if (streamWebSearch) {
        const createdAt = Math.floor(Date.now() / 1000);
        streamMapper = new ResponsesStreamMapper({
          responseId,
          model: upstreamRequest.model,
          createdAt,
          previousResponseId,
          normalized,
          emitReasoningSummary: true,
          emitReasoningText: false,
        });
        streamSearchWriter = webSearchSseWriter({
          res,
          mapper: streamMapper,
          outputIndexBySearch: new Map(),
          includeSources: shouldIncludeSearchSources(normalized),
        });
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        });
        writeSseEvent(res, streamMapper.createdEvent());
        writeSseEvent(res, streamMapper.inProgressEvent());
      }

      const loop = await runWebSearchChatLoop({
        normalized,
        chatRequest,
        config,
        onSearchStart: streamWebSearch ? (search) => streamSearchWriter.start(search) : undefined,
        onSearchDone: streamWebSearch ? (search) => streamSearchWriter.done(search) : undefined,
      });
      if (!loop.ok) {
        if (streamWebSearch) {
          writeSseEvent(res, {
            type: 'response.failed',
            sequence_number: streamMapper.nextSequence(),
            response: streamMapper.response('failed'),
          });
          writeSseDone(res);
          res.end();
          return;
        }
        sendJson(res, loop.status || 500, loop.data);
        return;
      }
      upstreamRequest = toProviderChatCompletionsRequest(loop.chatRequest, config);
      if (!upstreamRequest.model) upstreamRequest.model = config.upstreamModel || normalized.model;
      const model = upstreamRequest.model;
      const payload = applyWebSearchOutputCompatibility(convertChatCompletionToResponses({
        completion: loop.completion,
        model,
        previousResponseId,
        normalized,
        responseId,
      }), loop.searches, normalized);
      const assistantMessage = assistantMessageFromResponseOutput(payload.output);

      nextSession.history.push({
        request: normalized,
        chatRequest: loop.chatRequest,
        upstreamRequest,
        inputMessages: currentInputMessages,
        historyMessages: loop.chatRequest.messages.concat(assistantMessage),
        assistantMessage,
        createdAt: Date.now(),
      });
      sessions.set(responseId, nextSession);
      sessions.setConversation(conversationId, responseId);

      if (!streamWebSearch) {
        sendJson(res, 200, payload);
        return;
      }

      for (const event of outputEventsFromPayload(payload, streamMapper, { skipTypes: new Set(['web_search_call']) })) {
        writeSseEvent(res, event);
      }
      writeSseEvent(res, completedEventFromPayload(payload, streamMapper));
      writeSseDone(res);
      res.end();
      return;
    }

    logDebugPayload(config, upstreamRequest);

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
      if (res.headersSent) {
        if (!res.writableEnded) {
          res.write(serializeResponsesSseEvent({
            type: 'response.failed',
            response: {
              status: 'failed',
              error: { message: error.message || 'Internal server error' },
            },
          }));
          res.write(serializeResponsesSseEvent({ done: true }));
          res.end();
        }
        return;
      }
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
