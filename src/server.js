import http from 'node:http';
import { appendFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { generateId, hasPseudoToolCallMarkup, safeJsonParse, toText } from './common.js';
import {
  CompactionError,
  createCompactionPlan,
  readCodexCompactionMetadata,
  runCompactionPlan,
} from './compaction.js';
import { listModels, mergeModelLists, normalizeModelList } from './model-map.js';
import {
  assistantMessageFromResponseOutput,
  bridgedCommentaryToolCallsFromMessage,
  chatToolNamesFromTools,
  convertChatCompletionToResponses,
  createResponseEnvelope,
  expandParallelToolCallsInCompletion,
  extractToolCallIdsFromMessages,
  normalizeResponsesRequest,
  resolveEmittedToolCallNamesInCompletion,
  ResponsesStreamMapper,
  serializeResponsesSseEvent,
  stripBridgedCommentaryFromCompletion,
  toChatCompletionsRequest,
  toProviderChatCompletionsRequest,
  unavailableWebSearchToolShims,
} from './protocol.js';
import { ReasoningCache } from './reasoning-cache.js';
import {
  closeServerGracefully,
  connectHttpUrl,
  createControlServer,
  DEFAULT_REQUEST_BODY_MAX_BYTES,
  listenServer,
  positiveInteger,
  removeRuntimeRecord,
  writeRuntimeRecord,
} from './runtime.js';
import { callChatCompletions, callModels, readJsonResponse, relayChatCompletionsResponse } from './upstream.js';
import {
  advanceWebSearchChatRequest,
  annotateMessagePartWithWebCitations,
  applyWebSearchOutputCompatibility,
  buildWebSearchCallItem,
  containsWebSearchTool,
  executeWebSearchRound,
  hasVisibleAssistantContent,
  maxWebSearchRounds,
  prepareWebSearchRequest,
  removeWebSearchInstructions,
  shouldIncludeSearchSources,
  knownExternalToolCallsCompletion,
  webSearchRoundDecision,
} from './web-search-emulator.js';

export { closeServerGracefully } from './runtime.js';

const require = createRequire(import.meta.url);
const packageJson = require('../package.json');

function sendJson(res, statusCode, payload, headers = {}) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    ...headers,
  });
  res.end(JSON.stringify(payload));
}

function requestBodyTooLarge(maxBytes) {
  const error = new Error(`Request body exceeds ${maxBytes} bytes`);
  error.statusCode = 413;
  error.code = 'request_body_too_large';
  return error;
}

async function readRequestBody(req, configuredMaxBytes) {
  const maxBytes = positiveInteger(configuredMaxBytes, DEFAULT_REQUEST_BODY_MAX_BYTES);
  const contentLength = Number(req.headers['content-length']);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    req.resume();
    throw requestBodyTooLarge(maxBytes);
  }
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > maxBytes) {
      req.resume();
      throw requestBodyTooLarge(maxBytes);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, totalBytes).toString('utf8');
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

function prependMissingAssistantToolMessages(messages, reasoningCache) {
  const existingToolCallIds = new Set();
  for (const message of messages) {
    if (message?.role === 'assistant' && Array.isArray(message.tool_calls)) {
      for (const toolCall of message.tool_calls) {
        if (toolCall?.id) existingToolCallIds.add(toolCall.id);
      }
    }
  }
  const inserted = new Set(existingToolCallIds);
  const restored = [];
  let changed = false;
  for (const message of messages) {
    const callId = message?.role === 'tool' ? message.tool_call_id : '';
    if (callId && !inserted.has(callId)) {
      const assistantMessage = reasoningCache.getAssistantMessageForToolCall(callId);
      if (assistantMessage) {
        restored.push(assistantMessage);
        for (const id of extractToolCallIdsFromMessages([assistantMessage])) inserted.add(id);
        changed = true;
      }
    }
    restored.push(message);
  }
  return changed ? restored : messages;
}

function restoreAssistantReasoningContent(messages, reasoningCache) {
  return messages.map((message) => {
    if (message?.role !== 'assistant' || !Array.isArray(message.tool_calls) || !message.tool_calls.length) {
      return message;
    }
    if (typeof message.reasoning_content === 'string' && message.reasoning_content) return message;
    for (const toolCall of message.tool_calls) {
      const stored = reasoningCache.getAssistantMessageForToolCall(toolCall?.id);
      if (typeof stored?.reasoning_content === 'string' && stored.reasoning_content) {
        return { ...message, reasoning_content: stored.reasoning_content };
      }
    }
    return message;
  });
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

function summarizeTool(tool, index) {
  if (!tool || typeof tool !== 'object') {
    return { index, type: typeof tool };
  }
  const fn = tool.type === 'function' && tool.function && typeof tool.function === 'object'
    ? tool.function
    : null;
  return {
    index,
    type: tool.type,
    name: fn?.name || tool.name || tool.tool_name || tool.server_label,
    namespace: fn?.namespace || tool.namespace,
    child_tools: Array.isArray(tool.tools) ? tool.tools.length : undefined,
    has_parameters: Boolean(fn?.parameters || tool.parameters || tool.input_schema),
  };
}

function summarizeTools(tools) {
  return Array.isArray(tools) ? tools.map(summarizeTool) : [];
}

const DEBUG_PAYLOAD_LOG_MAX_BYTES = 5 * 1024 * 1024;

function rotateDebugPayloadLog(logPath, maxBytes) {
  try {
    if (statSync(logPath).size < maxBytes) return;
    rmSync(`${logPath}.1`, { force: true });
    renameSync(logPath, `${logPath}.1`);
  } catch {
  }
}

function writeDebugPayloadLine(config, line) {
  process.stderr.write(line);
  if (!config.debugPayloadLogPath) return;
  try {
    const logPath = resolve(config.debugPayloadLogPath);
    rotateDebugPayloadLog(logPath, config.debugPayloadLogMaxBytes || DEBUG_PAYLOAD_LOG_MAX_BYTES);
    appendFileSync(logPath, line, 'utf8');
  } catch (error) {
    process.stderr.write(`[codex-deepseek-gateway] failed to write debug payload log: ${error.message || error}\n`);
  }
}

function logDebugPayload(config, request, context = {}) {
  if (!config.debugPayload) return;
  const summary = {
    stage: context.stage || 'upstream',
    model: request.model,
    stream: request.stream,
    thinking: request.thinking,
    reasoning_effort: request.reasoning_effort,
    codex_tools: summarizeTools(context.rawRequest?.tools),
    normalized_tools: summarizeTools(context.normalized?.tools),
    chat_tools: summarizeTools(context.chatRequest?.tools),
    upstream_tools: summarizeTools(request.tools),
    tool_choice: request.tool_choice,
    messages: Array.isArray(request.messages) ? request.messages.map(summarizeMessage) : [],
  };
  writeDebugPayloadLine(config, `[codex-deepseek-gateway] upstream request ${JSON.stringify(summary)}\n`);
}

function logCompactionDiagnostic(config, diagnostic) {
  if (!config.debugPayload) return;
  writeDebugPayloadLine(config, `[codex-deepseek-gateway] compact ${JSON.stringify(diagnostic)}\n`);
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

function combineUsage(completions) {
  const usages = completions.map((completion) => completion?.usage).filter(Boolean);
  if (!usages.length) return null;
  const sum = (pick) => usages.reduce((total, usage) => total + (Number(pick(usage)) || 0), 0);
  const promptTokens = sum((usage) => usage.prompt_tokens);
  const completionTokens = sum((usage) => usage.completion_tokens);
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    prompt_tokens_details: {
      cached_tokens: sum((usage) => usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens),
    },
    completion_tokens_details: {
      reasoning_tokens: sum((usage) => usage.completion_tokens_details?.reasoning_tokens ?? usage.reasoning_tokens),
    },
  };
}

function lastUsage(usages) {
  for (let index = usages.length - 1; index >= 0; index -= 1) {
    if (usages[index]) return usages[index];
  }
  return null;
}

function withUsageFallback(completion, usage) {
  if (!completion || completion.usage || !usage) return completion;
  return { ...completion, usage };
}

function toWebSearchUpstreamRequest(chatRequest, config, webTools) {
  const request = toProviderChatCompletionsRequest(chatRequest, config);
  if (
    request.thinking?.type === 'enabled' &&
    request.tool_choice?.type === 'function' &&
    request.tool_choice.function?.name === webTools?.search
  ) {
    return { ...request, thinking: { type: 'disabled' }, reasoning_effort: undefined };
  }
  return request;
}

function logWebSearchUsage(config, stage, usages, finalUsage) {
  if (!config.debugPayload) return;
  const aggregateUsage = combineUsage(usages.map((usage) => ({ usage })));
  if (!aggregateUsage && !finalUsage) return;
  writeDebugPayloadLine(config, `[codex-deepseek-gateway] web search usage ${JSON.stringify({
    stage,
    rounds: usages.length,
    aggregate: aggregateUsage,
    final: finalUsage || null,
  })}\n`);
}

function toolCallsToFinalAnswerRequest(request, webTools) {
  return {
    ...request,
    tool_choice: undefined,
    tools: undefined,
    messages: removeWebSearchInstructions(request.messages, webTools).concat({
      role: 'user',
      content: [
        'Web tools are now unavailable.',
        'Answer now using only completed tool results as visible assistant text, without tool calls or tool-call markup.',
        'If results are incomplete, state what is missing and do not infer beyond them.',
      ].join(' '),
    }),
  };
}

function completionMessage(completion) {
  const choice = Array.isArray(completion?.choices) ? completion.choices[0] : null;
  return choice?.message || null;
}

function pseudoToolCallContentReason(completion) {
  const text = toText(completionMessage(completion)?.content).trim();
  if (!text) return null;
  return hasPseudoToolCallMarkup(text) ? 'pseudo_tool_call_text_after_web_limit' : null;
}

function finalAnswerIncompleteReason(completion) {
  if (!hasVisibleAssistantContent(completion)) return 'no_visible_assistant_content';
  return pseudoToolCallContentReason(completion);
}

function gatewayIncompleteMessageContent(reason) {
  return reason === 'pseudo_tool_call_text_after_web_limit'
    ? 'Gateway incomplete: after web tools were disabled, the model wrote a tool call as text instead of producing a final answer.'
    : 'Gateway incomplete: the model did not produce visible assistant content after web tool results and a final-answer request.';
}

function completionWithGatewayIncompleteMessage(completion, reason = 'no_visible_assistant_content') {
  const next = completion == null ? {} : JSON.parse(JSON.stringify(completion));
  if (!Array.isArray(next.choices) || !next.choices.length) {
    next.choices = [{ index: 0, message: { role: 'assistant' }, finish_reason: 'stop' }];
  }
  const choice = next.choices[0];
  const previousMessage = choice.message || {};
  const content = gatewayIncompleteMessageContent(reason);
  choice.message = {
    role: 'assistant',
    content,
  };
  if (typeof previousMessage.reasoning_content === 'string') {
    choice.message.reasoning_content = previousMessage.reasoning_content;
  }
  choice.finish_reason = 'stop';
  return next;
}

function completionWithoutToolCalls(completion) {
  const message = completionMessage(completion);
  if (!Array.isArray(message?.tool_calls) || !message.tool_calls.length) return completion;
  const next = JSON.parse(JSON.stringify(completion));
  const nextChoice = Array.isArray(next.choices) ? next.choices[0] : null;
  if (nextChoice?.message) delete nextChoice.message.tool_calls;
  if (nextChoice?.finish_reason === 'tool_calls') nextChoice.finish_reason = 'stop';
  return next;
}

async function callUpstreamJson({ upstreamRequest, config, signal }) {
  const response = await callChatCompletions({
    baseUrl: config.upstreamBaseUrl,
    apiKey: config.upstreamApiKey,
    request: upstreamRequest,
    timeoutMs: config.upstreamTimeoutMs,
    signal,
  });
  const data = await readJsonResponse(response);
  return {
    response,
    data: resolveEmittedToolCallNamesInCompletion(
      expandParallelToolCallsInCompletion(data),
      chatToolNamesFromTools(upstreamRequest.tools),
    ),
  };
}

function clientAbortControllerFor(res) {
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });
  return controller;
}

function restoreCommentaryToolCalls(completion, commentaryCalls) {
  if (!Array.isArray(commentaryCalls) || !commentaryCalls.length) return completion;
  const choice = Array.isArray(completion?.choices) ? completion.choices[0] : null;
  if (!choice?.message) return completion;
  const existing = Array.isArray(choice.message.tool_calls) ? choice.message.tool_calls : [];
  return {
    ...completion,
    choices: [
      { ...choice, message: { ...choice.message, tool_calls: [...commentaryCalls, ...existing] } },
      ...completion.choices.slice(1),
    ],
  };
}

async function runWebSearchChatLoop({ rawRequest, normalized, chatRequest, config, clientSignal, onSearchStart, onSearchDone }) {
  const effectiveChatRequest = { ...chatRequest, normalized };
  const state = prepareWebSearchRequest({ normalized, chatRequest: effectiveChatRequest, config });
  const searchConfig = state.config || config;
  const webTools = state.webTools;
  const webCache = state.webCache;
  let currentChatRequest = state.enabled ? state.chatRequest : effectiveChatRequest;
  const completions = [];
  const searches = [];
  const openedPages = [];
  let finalCompletion = null;
  let finalResponse = null;
  let incompleteReason = null;
  const maxRounds = maxWebSearchRounds(searchConfig);

  async function requestFinalAnswer(baseRequest) {
    currentChatRequest = toolCallsToFinalAnswerRequest(baseRequest, webTools);
    const upstreamRequest = toWebSearchUpstreamRequest(currentChatRequest, config, webTools);
    if (!upstreamRequest.model) upstreamRequest.model = config.upstreamModel || currentChatRequest.model;
    logDebugPayload(config, upstreamRequest, {
      stage: 'web_search_final_answer',
      rawRequest,
      normalized,
      chatRequest: currentChatRequest,
    });
    const { response, data } = await callUpstreamJson({
      upstreamRequest: disableStreaming(upstreamRequest),
      config,
      signal: clientSignal,
    });
    finalResponse = response;
    if (!response.ok) return { ok: false, status: response.status, data };
    finalCompletion = completionWithoutToolCalls(data);
    const reason = finalAnswerIncompleteReason(finalCompletion);
    if (reason) {
      incompleteReason = reason;
      finalCompletion = completionWithGatewayIncompleteMessage(finalCompletion, reason);
    }
    completions.push(finalCompletion);
    return null;
  }

  for (let round = 0; round <= maxRounds + 1; round += 1) {
    const upstreamRequest = toWebSearchUpstreamRequest(currentChatRequest, config, webTools);
    if (!upstreamRequest.model) upstreamRequest.model = config.upstreamModel || currentChatRequest.model;
    logDebugPayload(config, upstreamRequest, {
      stage: `web_search_round_${round}`,
      rawRequest,
      normalized,
      chatRequest: currentChatRequest,
    });
    const { response, data } = await callUpstreamJson({
      upstreamRequest: disableStreaming(upstreamRequest),
      config,
      signal: clientSignal,
    });
    finalResponse = response;
    if (!response.ok) return { ok: false, status: response.status, data };
    completions.push(data);
    finalCompletion = data;
    const roundChatMessage = Array.isArray(data?.choices) ? data.choices[0]?.message : null;
    const commentaryCalls = bridgedCommentaryToolCallsFromMessage(roundChatMessage, currentChatRequest.tools);
    const routingData = stripBridgedCommentaryFromCompletion(data, currentChatRequest.tools);

    if (!state.enabled) {
      break;
    }

    const decision = webSearchRoundDecision({
      routingCompletion: routingData,
      commentaryCalls,
      round,
      maxRounds,
      tools: currentChatRequest.tools,
      webTools,
      searches,
      openedPages,
    });

    if (decision.action === 'external') {
      finalCompletion = restoreCommentaryToolCalls(
        knownExternalToolCallsCompletion(routingData, currentChatRequest.tools, webTools),
        commentaryCalls,
      );
      completions[completions.length - 1] = finalCompletion;
      break;
    }

    if (decision.action === 'finish') {
      break;
    }

    if (decision.action === 'final_answer') {
      const finalAnswerError = await requestFinalAnswer({
        ...currentChatRequest,
        messages: currentChatRequest.messages.concat(decision.unsupportedMessages),
      });
      if (finalAnswerError) return finalAnswerError;
      break;
    }

    const toolResult = await executeWebSearchRound({
      completion: data,
      config: searchConfig,
      webTools,
      webCache,
      clientSignal,
      onSearchStart,
      onSearchDone,
    });
    searches.push(...toolResult.searches);
    openedPages.push(...(toolResult.openedPages || []));
    currentChatRequest = advanceWebSearchChatRequest(currentChatRequest, { toolResult, commentaryCalls, webTools });
  }

  const usages = completions.map((completion) => completion?.usage).filter(Boolean);
  const reportedUsage = finalCompletion?.usage || lastUsage(usages);
  logWebSearchUsage(config, 'web_search', usages, finalCompletion?.usage);
  return {
    ok: true,
    response: finalResponse,
    completion: withUsageFallback(finalCompletion, reportedUsage),
    searches,
    openedPages,
    webTools,
    chatRequest: currentChatRequest,
    incompleteReason,
  };
}

const STREAM_HEARTBEAT_MS = 10000;

function streamHeartbeatMs(config) {
  const value = Number(config?.streamHeartbeatMs);
  if (Number.isFinite(value) && value > 0) return value;
  return STREAM_HEARTBEAT_MS;
}

function startStreamHeartbeat({ config, res, write }) {
  const heartbeatMs = streamHeartbeatMs(config);
  let lastActivityAt = Date.now();
  let timer = null;
  const stop = () => {
    if (timer) clearInterval(timer);
    timer = null;
    res.off('close', stop);
  };
  timer = setInterval(() => {
    if (res.writableEnded || res.destroyed || Date.now() - lastActivityAt < heartbeatMs) return;
    write();
    lastActivityAt = Date.now();
  }, heartbeatMs);
  res.once('close', stop);
  return {
    activity() {
      lastActivityAt = Date.now();
    },
    stop,
  };
}

function writeSseEvent(res, event) {
  if (res.writableEnded || res.destroyed) return;
  res.write(serializeResponsesSseEvent(event));
}

function compactionErrorDetails(error) {
  if (error instanceof CompactionError) {
    return {
      code: error.code,
      message: error.message,
      statusCode: error.statusCode,
    };
  }
  return {
    code: 'compact_failed',
    message: error?.message || 'Compact request failed.',
    statusCode: 500,
  };
}

async function handleCompactionResponses({
  request,
  normalized,
  chatRequest,
  metadata,
  config,
  res,
  clientSignal,
}) {
  let plan;
  try {
    plan = createCompactionPlan({
      rawRequest: request,
      normalized,
      chatRequest,
      metadata,
      config,
    });
  } catch (error) {
    const details = compactionErrorDetails(error);
    sendJson(res, details.statusCode, { error: { code: details.code, message: details.message } });
    return;
  }

  if (!plan.upstreamRequest.model) {
    sendJson(res, 400, { error: { message: 'Missing model' } });
    return;
  }
  if (!config.upstreamApiKey) {
    sendJson(res, 500, { error: { message: 'Missing UPSTREAM_API_KEY' } });
    return;
  }

  const responseId = generateId('resp');
  const run = () => runCompactionPlan(plan, {
    signal: clientSignal,
    onDiagnostic: (diagnostic) => logCompactionDiagnostic(config, diagnostic),
  });

  if (!request.stream) {
    try {
      const result = await run();
      const payload = convertChatCompletionToResponses({
        completion: result.completion,
        model: result.upstreamRequest.model,
        normalized: plan.responseNormalized,
        responseId,
        config,
      });
      sendJson(res, 200, payload);
    } catch (error) {
      if (clientSignal.aborted) return;
      const details = compactionErrorDetails(error);
      const payload = createResponseEnvelope({
        id: responseId,
        model: plan.upstreamRequest.model,
        status: 'failed',
        normalized: plan.responseNormalized,
        completedAt: Date.now() / 1000,
        error: { code: details.code, message: details.message },
      });
      sendJson(res, 200, payload);
    }
    return;
  }

  const mapper = new ResponsesStreamMapper({
    responseId,
    model: plan.upstreamRequest.model,
    createdAt: Math.floor(Date.now() / 1000),
    normalized: plan.responseNormalized,
    config,
    emitReasoningSummary: false,
    emitReasoningText: false,
    knownToolNames: [],
  });
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  writeSseEvent(res, mapper.createdEvent());
  writeSseEvent(res, mapper.inProgressEvent());
  const heartbeat = startStreamHeartbeat({
    config,
    res,
    write: () => writeSseEvent(res, mapper.inProgressEvent()),
  });

  try {
    const result = await run();
    if (clientSignal.aborted) return;
    for (const event of mapper.mapChatEvent({ data: result.completion })) {
      writeSseEvent(res, event);
      heartbeat.activity();
    }
    for (const event of mapper.mapChatEvent({ done: true })) {
      writeSseEvent(res, event);
      heartbeat.activity();
    }
    writeSseEvent(res, { done: true });
    res.end();
  } catch (error) {
    if (clientSignal.aborted) return;
    const details = compactionErrorDetails(error);
    const response = mapper.response('failed');
    response.completed_at = Math.floor(Date.now() / 1000);
    response.error = { code: details.code, message: details.message };
    writeSseEvent(res, {
      type: 'response.failed',
      sequence_number: mapper.nextSequence(),
      response,
    });
    writeSseEvent(res, { done: true });
    res.end();
  } finally {
    heartbeat.stop();
  }
}

function webSearchSseWriter({ writeEvent, mapper, outputIndexBySearch, includeSources = false }) {
  return {
    start(search) {
      const outputIndex = mapper.output.length;
      outputIndexBySearch.set(search.id, outputIndex);
      const item = buildWebSearchCallItem(search, { status: 'in_progress', includeSources });
      mapper.output.push(item);
      writeEvent({
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
      writeEvent({
        type: 'response.output_item.done',
        sequence_number: mapper.nextSequence(),
        output_index: Number.isInteger(outputIndex) ? outputIndex : mapper.output.indexOf(item),
        item,
      });
    },
  };
}

async function runStreamingWebSearchTurn({ rawRequest, normalized, chatRequest, config, res, responseId, clientSignal }) {
  const effectiveChatRequest = { ...chatRequest, normalized };
  const state = prepareWebSearchRequest({ normalized, chatRequest: effectiveChatRequest, config });
  if (!state.enabled) return { handled: false };

  const searchConfig = state.config || config;
  const webTools = state.webTools;
  const webCache = state.webCache;
  const maxRounds = maxWebSearchRounds(searchConfig);
  let currentChatRequest = state.chatRequest;

  const buildUpstreamRequest = (stage) => {
    const upstreamRequest = toWebSearchUpstreamRequest(currentChatRequest, config, webTools);
    if (!upstreamRequest.model) upstreamRequest.model = config.upstreamModel || currentChatRequest.model;
    logDebugPayload(config, upstreamRequest, { stage, rawRequest, normalized, chatRequest: currentChatRequest });
    return upstreamRequest;
  };

  const firstUpstreamRequest = buildUpstreamRequest('web_search_stream_round_0');
  let upstreamResponse = await callChatCompletions({
    baseUrl: config.upstreamBaseUrl,
    apiKey: config.upstreamApiKey,
    request: firstUpstreamRequest,
    timeoutMs: config.upstreamTimeoutMs,
    signal: clientSignal,
  });
  if (!upstreamResponse.ok) {
    sendJson(res, upstreamResponse.status, await readJsonResponse(upstreamResponse));
    return { handled: true };
  }

  const mapper = new ResponsesStreamMapper({
    responseId,
    model: firstUpstreamRequest.model,
    createdAt: Math.floor(Date.now() / 1000),
    normalized,
    config,
    ...resolveReasoningStreamMode(config, firstUpstreamRequest),
    holdToolItemEvents: true,
    knownToolNames: chatToolNamesFromTools(firstUpstreamRequest.tools),
  });
  let heartbeat = null;
  const writeEvent = (event) => {
    writeSseEvent(res, event);
    heartbeat?.activity();
  };
  const searchWriter = webSearchSseWriter({
    writeEvent,
    mapper,
    outputIndexBySearch: new Map(),
    includeSources: shouldIncludeSearchSources(normalized),
  });
  const streamSearchItems = new Set();
  const roundUsages = [];
  const searches = [];
  const openedPages = [];
  let finalAnswerForced = false;
  let roundEnd = null;

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  writeEvent(mapper.createdEvent());
  writeEvent(mapper.inProgressEvent());
  heartbeat = startStreamHeartbeat({
    config,
    res,
    write: () => writeEvent(mapper.inProgressEvent()),
  });

  const endStream = () => {
    writeEvent({ done: true });
    res.end();
  };
  const failStream = (message) => {
    for (const event of mapper.streamFailed(message)) writeEvent(event);
    endStream();
    return { handled: true };
  };
  const finishTurn = () => {
    if (mapper.messageItem?.content?.length) {
      annotateMessagePartWithWebCitations(mapper.messageItem.content[0], searches, openedPages);
    }
    const usages = roundUsages.map((completion) => completion.usage).filter(Boolean).concat(mapper.pendingUsage ? [mapper.pendingUsage] : []);
    const reportedUsage = mapper.pendingUsage || lastUsage(usages);
    logWebSearchUsage(config, 'web_search_stream', usages, mapper.pendingUsage);
    for (const event of mapper.finalize(mapper.pendingFinishReason || 'stop', reportedUsage)) {
      writeEvent(event);
    }
    endStream();
    return {
      handled: true,
      chatRequest: currentChatRequest,
      assistantMessage: mapper.terminalStatus === 'completed' ? mapper.roundAssistantMessage() : null,
    };
  };
  const relayRound = async () => {
    roundEnd = null;
    mapper.markRoundStart();
    await relayChatCompletionsResponse({
      upstreamResponse,
      res,
      passThrough: false,
      writeHeaders: false,
      endResponse: false,
      onStreamChunk(event) {
        if (event?.done) {
          roundEnd = { eof: Boolean(event.eof) };
          return;
        }
        for (const responseEvent of mapper.mapChatEvent(event)) {
          writeEvent(responseEvent);
        }
      },
    });
  };

  try {
    await relayRound();
    for (let round = 0; ; round += 1) {
      if (clientSignal?.aborted) {
        return { handled: true };
      }
      if (!mapper.pendingFinishReason && roundEnd?.eof) {
        return failStream('upstream stream ended before completion');
      }
      mapper.expandParallelToolItems();
      const roundMessage = mapper.roundAssistantMessage();
      const commentaryCalls = bridgedCommentaryToolCallsFromMessage(roundMessage, currentChatRequest.tools);
      for (const event of mapper.convertBridgedCommentaryItems()) writeEvent(event);
      const completionLike = {
        choices: [{ index: 0, message: roundMessage, finish_reason: mapper.pendingFinishReason || 'stop' }],
      };
      const routingCompletion = stripBridgedCommentaryFromCompletion(completionLike, currentChatRequest.tools);

      if (finalAnswerForced) {
        mapper.removeToolItems();
        const reason = finalAnswerIncompleteReason(routingCompletion);
        if (reason) {
          const events = mapper.replaceBufferedAssistantText(gatewayIncompleteMessageContent(reason));
          for (const event of events || []) writeEvent(event);
        }
        return finishTurn();
      }

      const decision = webSearchRoundDecision({
        routingCompletion,
        commentaryCalls,
        round,
        maxRounds,
        tools: currentChatRequest.tools,
        webTools,
        searches,
        openedPages,
      });

      if (decision.action === 'external') {
        const kept = knownExternalToolCallsCompletion(routingCompletion, currentChatRequest.tools, webTools);
        const keptIds = new Set(
          (kept.choices?.[0]?.message?.tool_calls || []).map((toolCall) => toolCall.id).filter(Boolean),
        );
        mapper.removeToolItems((item) => !keptIds.has(item.call_id));
        return finishTurn();
      }

      if (decision.action === 'finish') {
        return finishTurn();
      }

      if (decision.action === 'final_answer') {
        currentChatRequest = toolCallsToFinalAnswerRequest({
          ...currentChatRequest,
          messages: currentChatRequest.messages.concat(decision.unsupportedMessages),
        }, webTools);
        finalAnswerForced = true;
        roundUsages.push({ usage: mapper.pendingUsage });
        mapper.removeToolItems();
        for (const event of mapper.beginNextRound()) writeEvent(event);
        mapper.holdVisibleTextUntilDone();
      } else {
        roundUsages.push({ usage: mapper.pendingUsage });
        for (const event of mapper.beginNextRound()) writeEvent(event);
        const toolResult = await executeWebSearchRound({
          completion: completionLike,
          config: searchConfig,
          webTools,
          webCache,
          clientSignal,
          onSearchStart(search) {
            if (search.action && search.auto) return;
            streamSearchItems.add(search);
            searchWriter.start(search);
          },
          onSearchDone(search) {
            if (!streamSearchItems.has(search)) return;
            searchWriter.done(search);
          },
        });
        searches.push(...toolResult.searches);
        openedPages.push(...(toolResult.openedPages || []));
        currentChatRequest = advanceWebSearchChatRequest(currentChatRequest, { toolResult, commentaryCalls, webTools });
      }

      if (clientSignal?.aborted) {
        return { handled: true };
      }
      const upstreamRequest = buildUpstreamRequest(`web_search_stream_round_${round + 1}`);
      upstreamResponse = await callChatCompletions({
        baseUrl: config.upstreamBaseUrl,
        apiKey: config.upstreamApiKey,
        request: upstreamRequest,
        timeoutMs: config.upstreamTimeoutMs,
        signal: clientSignal,
      });
      if (!upstreamResponse.ok) {
        const data = await readJsonResponse(upstreamResponse);
        return failStream(data?.error?.message || `upstream error ${upstreamResponse.status}`);
      }
      await relayRound();
    }
  } catch (error) {
    if (clientSignal?.aborted) {
      return { handled: true };
    }
    throw error;
  } finally {
    heartbeat?.stop();
  }
}

export function createProxyServer({ config = loadConfig(), reasoningCache } = {}) {
  reasoningCache ||= new ReasoningCache({
    persistPath: config.reasoningCacheEnabled === false ? '' : config.reasoningCachePath,
    legacyPath: config.legacyReasoningCachePath,
    maxMessages: config.reasoningCacheMaxMessages,
    maxBytes: config.reasoningCacheMaxBytes,
  });
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
    const raw = await readRequestBody(req, config.requestBodyMaxBytes);
    const parsed = safeJsonParse(raw);
    if (!parsed.ok || !parsed.value || typeof parsed.value !== 'object') {
      sendJson(res, 400, { error: { message: 'Invalid JSON body' } });
      return;
    }

    const request = parsed.value;
    const compactionState = readCodexCompactionMetadata(request, req.headers);
    const normalized = normalizeResponsesRequest(request);
    normalized.messages = prependMissingAssistantToolMessages(normalized.messages, reasoningCache);
    normalized.messages = restoreAssistantReasoningContent(normalized.messages, reasoningCache);

    const chatRequest = toChatCompletionsRequest(normalized);
    const clientAbort = clientAbortControllerFor(res);
    const clientSignal = clientAbort.signal;
    if (compactionState.isCompaction) {
      await handleCompactionResponses({
        request,
        normalized,
        chatRequest,
        metadata: compactionState.metadata,
        config,
        res,
        clientSignal,
      });
      return;
    }

    const useWebSearchEmulator = hasTavilyWebSearch(config, normalized);
    if (!useWebSearchEmulator) {
      const existingToolNames = new Set(chatToolNamesFromTools(chatRequest.tools));
      const webShims = unavailableWebSearchToolShims(normalized.tools)
        .filter((tool) => !existingToolNames.has(tool.function.name));
      if (webShims.length) chatRequest.tools = [...(chatRequest.tools ?? []), ...webShims];
    }
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
    const persistReasoning = (assistantMessage) => reasoningCache.rememberAssistantMessage(assistantMessage);

    if (useWebSearchEmulator && request.stream) {
      const result = await runStreamingWebSearchTurn({
        rawRequest: request,
        normalized,
        chatRequest,
        config,
        res,
        responseId,
        clientSignal,
      });
      if (result.handled) {
        if (result.assistantMessage) persistReasoning(result.assistantMessage);
        return;
      }
    } else if (useWebSearchEmulator) {
      const loop = await runWebSearchChatLoop({
        rawRequest: request,
        normalized,
        chatRequest,
        config,
        clientSignal,
      });
      if (!loop.ok) {
        sendJson(res, loop.status || 500, loop.data);
        return;
      }
      upstreamRequest = toProviderChatCompletionsRequest(loop.chatRequest, config);
      if (!upstreamRequest.model) upstreamRequest.model = config.upstreamModel || normalized.model;
      logDebugPayload(config, upstreamRequest, {
        stage: 'web_search_compatibility_payload',
        rawRequest: request,
        normalized,
        chatRequest: loop.chatRequest,
      });
      const payload = applyWebSearchOutputCompatibility(convertChatCompletionToResponses({
        completion: loop.completion,
        model: upstreamRequest.model,
        normalized,
        responseId,
        config,
      }), loop.searches, normalized, loop.openedPages, loop.webTools);
      if (payload.status === 'completed') {
        persistReasoning(assistantMessageFromResponseOutput(payload.output));
      }
      sendJson(res, 200, payload);
      return;
    }

    logDebugPayload(config, upstreamRequest, { rawRequest: request, normalized, chatRequest });

    const upstreamResponse = await callChatCompletions({
      baseUrl: config.upstreamBaseUrl,
      apiKey: config.upstreamApiKey,
      request: upstreamRequest,
      timeoutMs: config.upstreamTimeoutMs,
      signal: clientSignal,
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
        normalized,
        responseId,
        config,
      });
      if (payload.status === 'completed') {
        persistReasoning(assistantMessageFromResponseOutput(payload.output));
      }
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
      normalized,
      config,
      ...resolveReasoningStreamMode(config, upstreamRequest),
      knownToolNames: chatToolNamesFromTools(upstreamRequest.tools),
    });
    let doneSent = false;
    const writeResponsesDone = () => {
      if (doneSent) return;
      doneSent = true;
      writeSseEvent(res, { done: true });
    };

    writeSseEvent(res, mapper.createdEvent());
    writeSseEvent(res, mapper.inProgressEvent());
    const heartbeat = startStreamHeartbeat({
      config,
      res,
      write: () => {
        if (!doneSent) writeSseEvent(res, mapper.inProgressEvent());
      },
    });

    try {
      await relayChatCompletionsResponse({
        upstreamResponse,
        res,
        passThrough: false,
        writeHeaders: false,
        onStreamChunk(event) {
          const events = mapper.mapChatEvent(event);
          for (const responseEvent of events) {
            writeSseEvent(res, responseEvent);
          }
          if (events.length) {
            heartbeat.activity();
          }
          if (event?.done) writeResponsesDone();
        },
      });
    } catch (error) {
      if (clientSignal.aborted) return;
      throw error;
    } finally {
      heartbeat.stop();
    }

    if (mapper.terminalStatus === 'completed') {
      persistReasoning(mapper.assistantMessage());
    }
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
        const body = safeJsonParse(await readRequestBody(req, config.requestBodyMaxBytes));
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
          signal: clientAbortControllerFor(res).signal,
        });
        await relayChatCompletionsResponse({ upstreamResponse, res, passThrough: true });
        return;
      }

      sendJson(res, 404, { error: { message: 'Not found' } });
    } catch (error) {
      if (res.destroyed) return;
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
      const statusCode = Number.isInteger(error.statusCode) ? error.statusCode : 500;
      sendJson(res, statusCode, { error: { code: error.code, message: error.message || 'Internal server error' } });
    }
  });
}

function reportShutdownFailure(error) {
  process.stderr.write(`[codex-deepseek-gateway] graceful shutdown failed: ${error.message || error}\n`);
  process.exitCode = 1;
}

function installShutdownSignals(shutdown) {
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

async function runMain() {
  const config = loadConfig();
  const server = createProxyServer({ config });
  const runtimePath = process.env.GATEWAY_RUNTIME_FILE || '';
  const instanceId = process.env.GATEWAY_INSTANCE_ID || '';
  const shutdownToken = process.env.GATEWAY_SHUTDOWN_TOKEN || '';
  const startedAt = Date.now();
  const dataUrl = connectHttpUrl(config.host, config.port);
  let controlServer = null;
  let shutdownPromise = null;
  const shutdown = () => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = Promise.all([
      closeServerGracefully(server, config.shutdownTimeoutMs),
      controlServer ? closeServerGracefully(controlServer, config.shutdownTimeoutMs) : Promise.resolve(),
    ]).finally(() => removeRuntimeRecord(runtimePath, instanceId));
    return shutdownPromise;
  };
  const handleShutdown = () => {
    shutdown().catch(reportShutdownFailure);
  };
  installShutdownSignals(handleShutdown);

  try {
    await listenServer(server, config.port, config.host);
    if (runtimePath && instanceId && shutdownToken) {
      controlServer = createControlServer({
        token: shutdownToken,
        instanceId,
        onShutdown: handleShutdown,
        status: {
          packageVersion: packageJson.version,
          startedAt,
          dataUrl,
        },
      });
      const address = await listenServer(controlServer, 0, '127.0.0.1');
      writeRuntimeRecord(runtimePath, {
        version: 3,
        pid: process.pid,
        instanceId,
        controlUrl: `http://127.0.0.1:${address.port}`,
        shutdownToken,
        startedAt,
        packageVersion: packageJson.version,
        dataUrl,
      });
    }
    process.stdout.write(`listening on http://${config.host}:${config.port}\n`);
  } catch (error) {
    await shutdown().catch(reportShutdownFailure);
    throw error;
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  runMain().catch((error) => {
    process.stderr.write(`${error.message || error}\n`);
    process.exitCode = 1;
  });
}
