import http from 'node:http';
import { appendFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { generateId, safeJsonParse, toText } from './common.js';
import { listModels, mergeModelLists, normalizeModelList } from './model-map.js';
import {
  assistantMessageFromResponseOutput,
  bridgedCommentaryToolCallsFromMessage,
  chatToolNamesFromTools,
  convertChatCompletionToResponses,
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
import { callChatCompletions, callModels, readJsonResponse, relayChatCompletionsResponse } from './upstream.js';
import {
  annotateMessagePartWithWebCitations,
  applyWebSearchOutputCompatibility,
  buildWebSearchCallItem,
  containsWebSearchTool,
  executeWebSearchCalls,
  hasAnyToolCalls,
  hasKnownExternalToolCalls,
  hasUnknownExternalToolCalls,
  INTERNAL_WEB_SEARCH_TOOL,
  maxWebSearchRounds,
  prepareWebSearchRequest,
  removeWebSearchInstructions,
  shouldIncludeSearchSources,
  shouldContinueWebSearchLoop,
  knownExternalToolCallsCompletion,
  unhandledToolMessagesFromCompletion,
} from './web-search-emulator.js';

function sendJson(res, statusCode, payload, headers = {}) {
  if (res.destroyed || res.writableEnded) return;
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

function codexRequestKind(req) {
  const value = req.headers['x-codex-turn-metadata'];
  if (typeof value !== 'string') return '';
  const parsed = safeJsonParse(value);
  if (!parsed.ok || !parsed.value || typeof parsed.value !== 'object') return '';
  return String(parsed.value.request_kind || '');
}

function isAuthorized(req, config) {
  if (!config.proxyApiKey) return true;
  const authorization = req.headers.authorization || '';
  const bearerToken = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  return bearerToken === config.proxyApiKey || req.headers['x-api-key'] === config.proxyApiKey;
}

function prependMissingAssistantToolMessages(messages, reasoningCache) {
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
    const assistantMessage = reasoningCache.getAssistantMessageForToolCall(callId);
    if (!assistantMessage) continue;
    prefix.push(assistantMessage);
    for (const id of extractToolCallIdsFromMessages([assistantMessage])) inserted.add(id);
  }
  return prefix.length ? prefix.concat(messages) : messages;
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

function webToolTimeoutMs(config = {}) {
  const tavilyTimeout = Number(config.tavilyTimeoutMs) || 15000;
  if (!config.firecrawlWebFetchEnabled || !config.firecrawlApiKey) return tavilyTimeout;
  const firecrawlTimeout = Number(config.firecrawlTimeoutMs) || 30000;
  return Math.max(tavilyTimeout, firecrawlTimeout);
}

function combineUsage(completions) {
  const usages = completions.map((completion) => completion?.usage).filter(Boolean);
  if (!usages.length) return null;
  const last = usages[usages.length - 1];
  const sum = (pick) => usages.reduce((total, usage) => total + (Number(pick(usage)) || 0), 0);
  const promptTokens = Number(last.prompt_tokens) || 0;
  const completionTokens = sum((usage) => usage.completion_tokens);
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    prompt_tokens_details: {
      cached_tokens: last.prompt_tokens_details?.cached_tokens ?? last.prompt_cache_hit_tokens ?? 0,
    },
    completion_tokens_details: {
      reasoning_tokens: sum((usage) => usage.completion_tokens_details?.reasoning_tokens ?? usage.reasoning_tokens),
    },
  };
}

function cloneCompletionWithUsage(completion, usage) {
  if (!usage) return completion;
  return {
    ...completion,
    usage,
  };
}

function toolCallsToFinalAnswerRequest(request) {
  return {
    ...request,
    tool_choice: undefined,
    tools: undefined,
    messages: removeWebSearchInstructions(request.messages).concat({
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

function hasVisibleAssistantContent(completion) {
  return Boolean(toText(completionMessage(completion)?.content).trim());
}

function pseudoToolCallContentReason(completion) {
  const text = toText(completionMessage(completion)?.content).trim();
  if (!text) return null;
  if (/<[^>]*DSML[^>]*tool_calls/i.test(text)) return 'pseudo_tool_call_text_after_web_limit';
  if (/<[^>]*invoke\s+name\s*=/i.test(text)) return 'pseudo_tool_call_text_after_web_limit';
  if (/^\s*```(?:json|xml|dsml)?\s*[\s\S]*\btool_calls\b/i.test(text)) return 'pseudo_tool_call_text_after_web_limit';
  if (/^\s*\{[\s\S]*"tool_calls"\s*:/i.test(text)) return 'pseudo_tool_call_text_after_web_limit';
  return null;
}

function finalAnswerIncompleteReason(completion) {
  if (!hasVisibleAssistantContent(completion)) return 'no_visible_assistant_content';
  return pseudoToolCallContentReason(completion);
}

function hasWebSearchContext(searches, openedPages) {
  return searches.length > 0 || openedPages.length > 0;
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

function mergeAbortSignals(signals) {
  const active = signals.filter(Boolean);
  if (!active.length) return undefined;
  if (active.length === 1) return active[0];
  return AbortSignal.any(active);
}

function commentaryToolMessages(commentaryCalls) {
  return (Array.isArray(commentaryCalls) ? commentaryCalls : []).map((toolCall) => ({
    role: 'tool',
    tool_call_id: toolCall.id || generateId('call'),
    content: 'Delivered to the user.',
  }));
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
  let currentChatRequest = state.enabled ? state.chatRequest : effectiveChatRequest;
  const completions = [];
  const searches = [];
  const openedPages = [];
  let finalCompletion = null;
  let finalResponse = null;
  let incompleteReason = null;
  const maxRounds = maxWebSearchRounds(searchConfig);

  async function requestFinalAnswer(baseRequest) {
    currentChatRequest = toolCallsToFinalAnswerRequest(baseRequest);
    const upstreamRequest = toProviderChatCompletionsRequest(currentChatRequest, config);
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
    const upstreamRequest = toProviderChatCompletionsRequest(currentChatRequest, config);
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

    if (state.enabled && hasKnownExternalToolCalls(routingData, currentChatRequest.tools)) {
      finalCompletion = restoreCommentaryToolCalls(
        knownExternalToolCallsCompletion(routingData, currentChatRequest.tools),
        commentaryCalls,
      );
      completions[completions.length - 1] = finalCompletion;
      break;
    }

    if (!state.enabled) {
      break;
    }

    const wantsInternalWeb = shouldContinueWebSearchLoop(routingData);
    const wantsInternalRound = wantsInternalWeb || commentaryCalls.length > 0;
    const hasToolCalls = hasAnyToolCalls(routingData);

    if (!wantsInternalRound || round >= maxRounds) {
      if (hasToolCalls && hasUnknownExternalToolCalls(routingData, currentChatRequest.tools)) {
        const unsupportedMessages = unhandledToolMessagesFromCompletion(routingData, undefined, {
          onlyUnknownExternal: true,
          tools: currentChatRequest.tools,
        });
        const finalAnswerError = await requestFinalAnswer({
          ...currentChatRequest,
          messages: currentChatRequest.messages.concat(unsupportedMessages),
        });
        if (finalAnswerError) return finalAnswerError;
        break;
      }

      if (wantsInternalRound || (!hasToolCalls && hasWebSearchContext(searches, openedPages) && !hasVisibleAssistantContent(routingData))) {
        const finalAnswerError = await requestFinalAnswer(currentChatRequest);
        if (finalAnswerError) return finalAnswerError;
        break;
      }
      break;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), webToolTimeoutMs(searchConfig));
    let toolResult;
    try {
      toolResult = await executeWebSearchCalls({
        completion: data,
        config: searchConfig,
        signal: mergeAbortSignals([controller.signal, clientSignal]),
        onSearchStart,
        onSearchDone,
      });
    } finally {
      clearTimeout(timeout);
    }
    searches.push(...toolResult.searches);
    openedPages.push(...(toolResult.openedPages || []));
    currentChatRequest = {
      ...currentChatRequest,
      messages: currentChatRequest.messages.concat(toolResult.messages, commentaryToolMessages(commentaryCalls)),
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
    openedPages,
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

function writeSseEvent(res, event) {
  if (res.writableEnded || res.destroyed) return;
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

async function runStreamingWebSearchTurn({ rawRequest, normalized, chatRequest, config, res, responseId, clientSignal }) {
  const effectiveChatRequest = { ...chatRequest, normalized };
  const state = prepareWebSearchRequest({ normalized, chatRequest: effectiveChatRequest, config });
  if (!state.enabled) return { handled: false };

  const searchConfig = state.config || config;
  const maxRounds = maxWebSearchRounds(searchConfig);
  let currentChatRequest = state.chatRequest;

  const buildUpstreamRequest = (stage) => {
    const upstreamRequest = toProviderChatCompletionsRequest(currentChatRequest, config);
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
  const searchWriter = webSearchSseWriter({
    res,
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
  writeSseEvent(res, mapper.createdEvent());
  writeSseEvent(res, mapper.inProgressEvent());
  const heartbeat = setInterval(() => {
    writeSseEvent(res, mapper.inProgressEvent());
  }, STREAM_HEARTBEAT_MS);

  const endStream = () => {
    writeSseDone(res);
    res.end();
  };
  const failStream = (message) => {
    for (const event of mapper.streamFailed(message)) writeSseEvent(res, event);
    endStream();
    return { handled: true };
  };
  const finishTurn = () => {
    if (mapper.messageItem?.content?.length) {
      annotateMessagePartWithWebCitations(mapper.messageItem.content[0], searches, openedPages);
    }
    const combinedUsage = combineUsage(roundUsages.concat([{ usage: mapper.pendingUsage }]));
    for (const event of mapper.finalize(mapper.pendingFinishReason || 'stop', combinedUsage)) {
      writeSseEvent(res, event);
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
          writeSseEvent(res, responseEvent);
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
      for (const event of mapper.convertBridgedCommentaryItems()) writeSseEvent(res, event);
      const completionLike = {
        choices: [{ index: 0, message: roundMessage, finish_reason: mapper.pendingFinishReason || 'stop' }],
      };
      const routingCompletion = stripBridgedCommentaryFromCompletion(completionLike, currentChatRequest.tools);

      if (finalAnswerForced) {
        mapper.removeToolItems();
        const reason = finalAnswerIncompleteReason(routingCompletion);
        if (reason) {
          const events = mapper.replaceBufferedAssistantText(gatewayIncompleteMessageContent(reason));
          for (const event of events || []) writeSseEvent(res, event);
        }
        return finishTurn();
      }

      if (hasKnownExternalToolCalls(routingCompletion, currentChatRequest.tools)) {
        const kept = knownExternalToolCallsCompletion(routingCompletion, currentChatRequest.tools);
        const keptIds = new Set(
          (kept.choices?.[0]?.message?.tool_calls || []).map((toolCall) => toolCall.id).filter(Boolean),
        );
        mapper.removeToolItems((item) => !keptIds.has(item.call_id));
        return finishTurn();
      }

      const wantsInternalWeb = shouldContinueWebSearchLoop(routingCompletion);
      const wantsInternalRound = wantsInternalWeb || commentaryCalls.length > 0;
      const hasToolCallsRound = hasAnyToolCalls(routingCompletion);

      if (!wantsInternalRound || round >= maxRounds) {
        if (hasToolCallsRound && hasUnknownExternalToolCalls(routingCompletion, currentChatRequest.tools)) {
          const unsupportedMessages = unhandledToolMessagesFromCompletion(routingCompletion, undefined, {
            onlyUnknownExternal: true,
            tools: currentChatRequest.tools,
          });
          currentChatRequest = toolCallsToFinalAnswerRequest({
            ...currentChatRequest,
            messages: currentChatRequest.messages.concat(unsupportedMessages),
          });
        } else if (wantsInternalRound || (!hasToolCallsRound && hasWebSearchContext(searches, openedPages) && !hasVisibleAssistantContent(routingCompletion))) {
          currentChatRequest = toolCallsToFinalAnswerRequest(currentChatRequest);
        } else {
          return finishTurn();
        }
        finalAnswerForced = true;
        roundUsages.push({ usage: mapper.pendingUsage });
        mapper.removeToolItems();
        for (const event of mapper.beginNextRound()) writeSseEvent(res, event);
        mapper.holdVisibleTextUntilDone();
      } else {
        roundUsages.push({ usage: mapper.pendingUsage });
        for (const event of mapper.beginNextRound()) writeSseEvent(res, event);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), webToolTimeoutMs(searchConfig));
        let toolResult;
        try {
          toolResult = await executeWebSearchCalls({
            completion: completionLike,
            config: searchConfig,
            signal: mergeAbortSignals([controller.signal, clientSignal]),
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
        } finally {
          clearTimeout(timeout);
        }
        searches.push(...toolResult.searches);
        openedPages.push(...(toolResult.openedPages || []));
        currentChatRequest = {
          ...currentChatRequest,
          messages: currentChatRequest.messages.concat(toolResult.messages, commentaryToolMessages(commentaryCalls)),
          tool_choice:
            currentChatRequest.tool_choice?.function?.name === INTERNAL_WEB_SEARCH_TOOL
              ? 'auto'
              : currentChatRequest.tool_choice,
        };
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
    clearInterval(heartbeat);
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
    const raw = await readRequestBody(req);
    const parsed = safeJsonParse(raw);
    if (!parsed.ok || !parsed.value || typeof parsed.value !== 'object') {
      sendJson(res, 400, { error: { message: 'Invalid JSON body' } });
      return;
    }

    const request = parsed.value;
    const normalized = normalizeResponsesRequest(request, {
      restoreDiscoveredTools: codexRequestKind(req) !== 'compaction',
    });
    normalized.messages = prependMissingAssistantToolMessages(normalized.messages, reasoningCache);
    normalized.messages = restoreAssistantReasoningContent(normalized.messages, reasoningCache);

    const chatRequest = toChatCompletionsRequest(normalized);
    const useWebSearchEmulator = hasTavilyWebSearch(config, normalized);
    if (!useWebSearchEmulator) {
      const existingToolNames = new Set(chatToolNamesFromTools(chatRequest.tools));
      const webShims = unavailableWebSearchToolShims(normalized.tools)
        .filter((tool) => !existingToolNames.has(tool.function.name));
      if (webShims.length) chatRequest.tools = [...(chatRequest.tools ?? []), ...webShims];
    }
    const clientAbort = clientAbortControllerFor(res);
    const clientSignal = clientAbort.signal;
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
      }), loop.searches, normalized, loop.openedPages);
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
    let lastEventWriteAt = Date.now();
    const heartbeatMs = streamHeartbeatMs(config);
    const heartbeat = setInterval(() => {
      if (doneSent || Date.now() - lastEventWriteAt < heartbeatMs) return;
      writeSseEvent(res, mapper.inProgressEvent());
      lastEventWriteAt = Date.now();
    }, heartbeatMs);

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
            lastEventWriteAt = Date.now();
          }
          if (event?.done) writeResponsesDone();
        },
      });
    } catch (error) {
      if (clientSignal.aborted) return;
      throw error;
    } finally {
      clearInterval(heartbeat);
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

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const config = loadConfig();
  const server = createProxyServer({ config });
  server.listen(config.port, config.host, () => {
    process.stdout.write(`listening on http://${config.host}:${config.port}\n`);
  });
}
