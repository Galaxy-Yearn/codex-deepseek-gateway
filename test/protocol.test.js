import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assistantMessageFromResponseOutput,
  convertChatCompletionToResponses,
  normalizeResponsesRequest,
  ResponsesStreamMapper,
  serializeResponsesSseEvent,
  toChatCompletionsRequest,
  toProviderChatCompletionsRequest,
} from '../src/protocol.js';
import { SseParser } from '../src/common.js';
import { DEFAULT_MODEL_ALIASES } from '../src/model-map.js';

test('normalizes Responses input to chat completions messages', () => {
  const normalized = normalizeResponsesRequest({
    model: 'codex-model',
    instructions: 'Be direct.',
    input: [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'hello' }],
      },
      {
        type: 'function_call_output',
        call_id: 'call_1',
        output: '{"ok":true}',
      },
    ],
    max_output_tokens: 64,
    text: { format: { type: 'json_object' } },
  });
  const chat = toChatCompletionsRequest(normalized);
  assert.equal(chat.model, 'codex-model');
  assert.equal(chat.max_tokens, 64);
  assert.deepEqual(chat.response_format, { type: 'json_object' });
  assert.deepEqual(chat.messages, [
    { role: 'system', content: 'Be direct.' },
    { role: 'user', content: 'hello', tool_calls: undefined, tool_call_id: undefined, name: undefined },
    { role: 'tool', content: '{"ok":true}', tool_call_id: 'call_1' },
  ]);
});

test('converts Responses function tools to chat completions tools', () => {
  const normalized = normalizeResponsesRequest({
    model: 'deepseek-v4-flash',
    input: 'call a tool',
    tools: [
      {
        type: 'function',
        name: 'lookup',
        description: 'Look up a value',
        parameters: {
          type: 'object',
          properties: { q: { type: 'string' } },
          required: ['q'],
        },
      },
    ],
  });
  const chat = toChatCompletionsRequest(normalized);
  assert.deepEqual(chat.tools, [
    {
      type: 'function',
      function: {
        name: 'lookup',
        description: 'Look up a value',
        parameters: {
          type: 'object',
          properties: { q: { type: 'string' } },
          required: ['q'],
        },
      },
    },
  ]);
});

test('converts Responses custom tools and drops unsupported hosted tools', () => {
  const normalized = normalizeResponsesRequest({
    model: 'deepseek-v4-flash',
    input: 'call tools',
    tools: [
      {
        type: 'custom',
        name: 'apply.patch',
        description: 'Apply a patch',
        input_schema: { type: 'object', properties: { patch: { type: 'string' } } },
      },
      {
        type: 'local_shell',
        description: 'Run a command',
      },
      {
        type: 'mcp',
        server_label: 'context7',
      },
      {
        type: 'web_search',
      },
    ],
  });
  const chat = toChatCompletionsRequest(normalized);
  assert.deepEqual(chat.tools, [
    {
      type: 'function',
      function: {
        name: 'apply_patch',
        description: 'Apply a patch',
        parameters: { type: 'object', properties: { patch: { type: 'string' } } },
      },
    },
  ]);
});

test('normalizes invalid tool parameter schemas for DeepSeek compatibility', () => {
  const normalized = normalizeResponsesRequest({
    model: 'deepseek-v4-flash',
    input: 'use mcp',
    tools: [
      {
        type: 'function',
        function: {
          name: 'mcp__context7__',
          description: 'Broken MCP schema',
          parameters: { type: null, properties: null },
        },
      },
      {
        type: 'function',
        name: 'string_tool',
        parameters: { type: 'string' },
      },
    ],
  });
  const chat = toChatCompletionsRequest(normalized);
  assert.deepEqual(chat.tools, [
    {
      type: 'function',
      function: {
        name: 'mcp__context7__',
        description: 'Broken MCP schema',
        parameters: { type: 'object', properties: {} },
      },
    },
    {
      type: 'function',
      function: {
        name: 'string_tool',
        parameters: {
          type: 'object',
          properties: {
            value: { type: 'string' },
          },
          required: ['value'],
          additionalProperties: false,
        },
      },
    },
  ]);
});

test('maps provider request for DeepSeek', () => {
  const request = toProviderChatCompletionsRequest(
    {
      model: 'codex',
      messages: [{ role: 'developer', content: 'rules' }],
      stream: true,
      parallel_tool_calls: true,
      response_format: { type: 'json_schema', json_schema: { name: 'answer' } },
      user: 'codex-user',
      reasoning: { effort: 'xhigh' },
    },
    { upstreamProvider: 'deepseek', upstreamModel: 'deepseek-v4-pro' },
  );
  assert.equal(request.model, 'deepseek-v4-pro');
  assert.equal(request.messages[0].role, 'system');
  assert.equal(request.reasoning_effort, 'max');
  assert.deepEqual(request.thinking, { type: 'enabled' });
  assert.equal('parallel_tool_calls' in request, false);
  assert.equal(request.user_id, 'codex-user');
  assert.deepEqual(request.response_format, { type: 'json_object' });
  assert.deepEqual(request.stream_options, { include_usage: true });
});

test('normalizes Responses tool choice and DeepSeek stream options', () => {
  const normalized = normalizeResponsesRequest({
    model: 'deepseek-v4-flash',
    input: 'inspect',
    stream: true,
    stream_options: { include_obfuscation: true },
    tool_choice: { type: 'local_shell' },
  });
  const chat = toChatCompletionsRequest(normalized);
  assert.deepEqual(chat.tool_choice, {
    type: 'function',
    function: { name: 'local_shell' },
  });

  const request = toProviderChatCompletionsRequest(chat, {
    upstreamProvider: 'deepseek',
    modelAliases: DEFAULT_MODEL_ALIASES,
  });
  assert.deepEqual(request.stream_options, { include_usage: true });
});

test('preserves Responses multimodal and file content for chat completions', () => {
  const normalized = normalizeResponsesRequest({
    model: 'deepseek-v4-flash',
    input: [
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'describe this' },
          { type: 'input_image', image_url: 'data:image/png;base64,AAAA', detail: 'high' },
          { type: 'input_file', filename: 'notes.txt', file_data: 'data:text/plain;base64,SGk=' },
        ],
      },
    ],
  });
  const chat = toChatCompletionsRequest(normalized);
  assert.deepEqual(chat.messages[0], {
    role: 'user',
    content: [
      { type: 'text', text: 'describe this' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA', detail: 'high' } },
      { type: 'file', file: { filename: 'notes.txt', file_data: 'data:text/plain;base64,SGk=' } },
    ],
    tool_calls: undefined,
    tool_call_id: undefined,
    name: undefined,
  });
});

test('groups top-level Responses input content parts as a user message', () => {
  const normalized = normalizeResponsesRequest({
    model: 'deepseek-v4-flash',
    input: [
      { type: 'input_text', text: 'inspect' },
      { type: 'input_image', file_id: 'file_img_1', detail: 'low' },
    ],
  });
  const chat = toChatCompletionsRequest(normalized);
  assert.deepEqual(chat.messages, [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'inspect' },
        { type: 'image_url', image_url: { file_id: 'file_img_1', detail: 'low' } },
      ],
    },
  ]);
});

test('maps Responses tool call history to chat completions messages', () => {
  const normalized = normalizeResponsesRequest({
    model: 'deepseek-v4-flash',
    input: [
      {
        type: 'custom_tool_call',
        id: 'call_custom',
        name: 'apply.patch',
        input: '*** Begin Patch',
      },
      {
        type: 'custom_tool_call_output',
        call_id: 'call_custom',
        output: [
          { type: 'input_text', text: 'ok' },
          { type: 'input_file', file_id: 'file_1', filename: 'result.txt' },
        ],
      },
    ],
  });
  const chat = toChatCompletionsRequest(normalized);
  assert.deepEqual(chat.messages, [
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'call_custom',
          type: 'function',
          function: { name: 'apply_patch', arguments: '{"input":"*** Begin Patch"}' },
        },
      ],
    },
    {
      role: 'tool',
      content: [
        { type: 'text', text: 'ok' },
        { type: 'file', file: { file_id: 'file_1', filename: 'result.txt' } },
      ],
      tool_call_id: 'call_custom',
    },
  ]);
});

test('does not replay Responses web_search_call history as chat tool calls', () => {
  const normalized = normalizeResponsesRequest({
    model: 'deepseek-v4-flash',
    input: [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'search gold' }],
      },
      {
        type: 'web_search_call',
        id: 'ws_1',
        status: 'completed',
        action: {
          type: 'search',
          query: 'gold futures price',
          sources: [{ type: 'url', title: 'Gold source', url: 'https://example.com/gold' }],
        },
      },
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Gold moved today [1].' }],
      },
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'now search oil' }],
      },
    ],
  });
  const chat = toChatCompletionsRequest(normalized);
  assert.equal(chat.messages.some((message) => Array.isArray(message.tool_calls)), false);
  assert.deepEqual(chat.messages.map((message) => message.role), ['user', 'assistant', 'user']);
});

test('preserves DeepSeek reasoning content in assistant history', () => {
  const request = toProviderChatCompletionsRequest(
    {
      model: 'deepseek-v4-pro',
      messages: [
        {
          role: 'assistant',
          content: '',
          reasoning_content: 'need a tool',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'lookup', arguments: '{"q":"x"}' },
            },
          ],
        },
      ],
    },
    { upstreamProvider: 'deepseek', modelAliases: DEFAULT_MODEL_ALIASES },
  );
  assert.equal(request.messages[0].reasoning_content, 'need a tool');
});

test('adds empty DeepSeek reasoning_content on assistant history when thinking is enabled', () => {
  const request = toProviderChatCompletionsRequest(
    {
      model: 'deepseek-v4-pro',
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
        { role: 'user', content: 'review' },
      ],
      reasoning: { effort: 'high' },
    },
    { upstreamProvider: 'deepseek', modelAliases: DEFAULT_MODEL_ALIASES },
  );
  assert.equal(request.thinking.type, 'enabled');
  assert.equal(request.messages[1].reasoning_content, '');
});

test('does not add DeepSeek reasoning_content when thinking is disabled', () => {
  const request = toProviderChatCompletionsRequest(
    {
      model: 'deepseek-v4-pro',
      messages: [
        { role: 'assistant', content: 'hi' },
      ],
      reasoning: { effort: 'low' },
    },
    { upstreamProvider: 'deepseek', modelAliases: DEFAULT_MODEL_ALIASES },
  );
  assert.equal(request.thinking.type, 'disabled');
  assert.equal('reasoning_content' in request.messages[0], false);
});

test('preserves Responses reasoning items next to tool calls for DeepSeek history', () => {
  const normalized = normalizeResponsesRequest({
    model: 'deepseek-v4-pro',
    input: [
      {
        type: 'reasoning',
        content: [{ type: 'reasoning_text', text: 'need a lookup' }],
      },
      {
        type: 'function_call',
        call_id: 'call_1',
        name: 'lookup',
        arguments: '{"q":"x"}',
      },
      {
        type: 'function_call_output',
        call_id: 'call_1',
        output: '{"ok":true}',
      },
    ],
  });
  const chat = toChatCompletionsRequest(normalized);
  assert.deepEqual(chat.messages, [
    {
      role: 'assistant',
      content: '',
      reasoning_content: 'need a lookup',
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'lookup', arguments: '{"q":"x"}' },
        },
      ],
    },
    {
      role: 'tool',
      content: '{"ok":true}',
      tool_call_id: 'call_1',
    },
  ]);

  const request = toProviderChatCompletionsRequest(chat, {
    upstreamProvider: 'deepseek',
    modelAliases: DEFAULT_MODEL_ALIASES,
  });
  assert.equal(request.messages[0].reasoning_content, 'need a lookup');
});

test('maps DeepSeek v4 thinking aliases and Codex reasoning effort', () => {
  const noThinking = toProviderChatCompletionsRequest(
    {
      model: 'deepseek-v4-pro',
      messages: [{ role: 'user', content: 'ping' }],
      reasoning: { effort: 'none' },
    },
    { upstreamProvider: 'deepseek', modelAliases: DEFAULT_MODEL_ALIASES },
  );
  assert.equal(noThinking.model, 'deepseek-v4-pro');
  assert.deepEqual(noThinking.thinking, { type: 'disabled' });
  assert.equal('reasoning_effort' in noThinking, false);

  const fallbackEffort = toProviderChatCompletionsRequest(
    {
      model: 'deepseek-v4-pro',
      messages: [{ role: 'user', content: 'ping' }],
    },
    { upstreamProvider: 'deepseek', modelAliases: DEFAULT_MODEL_ALIASES, codexReasoningEffort: 'xhigh' },
  );
  assert.equal(fallbackEffort.model, 'deepseek-v4-pro');
  assert.deepEqual(fallbackEffort.thinking, { type: 'enabled' });
  assert.equal(fallbackEffort.reasoning_effort, 'max');

  const lowNoThinking = toProviderChatCompletionsRequest(
    {
      model: 'deepseek-v4-pro',
      messages: [{ role: 'user', content: 'ping' }],
      reasoning: { effort: 'low' },
    },
    { upstreamProvider: 'deepseek', modelAliases: DEFAULT_MODEL_ALIASES },
  );
  assert.equal(lowNoThinking.model, 'deepseek-v4-pro');
  assert.deepEqual(lowNoThinking.thinking, { type: 'disabled' });
  assert.equal('reasoning_effort' in lowNoThinking, false);

  const mediumThinking = toProviderChatCompletionsRequest(
    {
      model: 'deepseek-v4-pro',
      messages: [{ role: 'user', content: 'ping' }],
      reasoning: { effort: 'medium' },
    },
    { upstreamProvider: 'deepseek', modelAliases: DEFAULT_MODEL_ALIASES },
  );
  assert.equal(mediumThinking.model, 'deepseek-v4-pro');
  assert.deepEqual(mediumThinking.thinking, { type: 'enabled' });
  assert.equal(mediumThinking.reasoning_effort, 'high');

  const maxThinking = toProviderChatCompletionsRequest(
    {
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'ping' }],
      reasoning: { effort: 'xhigh' },
    },
    { upstreamProvider: 'deepseek', modelAliases: DEFAULT_MODEL_ALIASES },
  );
  assert.equal(maxThinking.model, 'deepseek-v4-flash');
  assert.deepEqual(maxThinking.thinking, { type: 'enabled' });
  assert.equal(maxThinking.reasoning_effort, 'max');

  const aliasWins = toProviderChatCompletionsRequest(
    {
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'ping' }],
      reasoning: { effort: 'low' },
    },
    {
      upstreamProvider: 'deepseek',
      modelAliases: {
        ...DEFAULT_MODEL_ALIASES,
        'deepseek-v4-flash': { model: 'deepseek-v4-flash', thinking: 'enabled', reasoning_effort: 'high' },
      },
    },
  );
  assert.equal(aliasWins.model, 'deepseek-v4-flash');
  assert.deepEqual(aliasWins.thinking, { type: 'enabled' });
  assert.equal(aliasWins.reasoning_effort, 'high');
});

test('converts chat completion to Responses object', () => {
  const response = convertChatCompletionToResponses({
    responseId: 'resp_test',
    model: 'deepseek-v4-flash',
    previousResponseId: null,
    normalized: normalizeResponsesRequest({ model: 'deepseek-v4-flash', input: 'hi' }),
    completion: {
      id: 'chatcmpl_test',
      created: 1000,
      choices: [{ message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    },
  });
  assert.equal(response.id, 'resp_test');
  assert.equal(response.object, 'response');
  assert.equal(response.status, 'completed');
  assert.equal(response.output[0].type, 'message');
  assert.equal(response.output[0].content[0].text, 'hello');
  assert.equal(response.output_text, 'hello');
  assert.equal(response.usage.input_tokens, 1);
  assert.equal(response.usage.output_tokens, 1);
  assert.equal(response.usage.total_tokens, 2);
  assert.deepEqual(assistantMessageFromResponseOutput(response.output), { role: 'assistant', content: 'hello' });
});

test('maps DeepSeek reasoning content to Responses reasoning summary', () => {
  const response = convertChatCompletionToResponses({
    responseId: 'resp_reasoning',
    model: 'deepseek-v4-pro',
    previousResponseId: null,
    normalized: normalizeResponsesRequest({ model: 'deepseek-v4-pro', input: 'think' }),
    completion: {
      id: 'chatcmpl_test',
      created: 1000,
      choices: [
        {
          message: {
            role: 'assistant',
            reasoning_content: 'reasoning trace',
            content: 'answer',
          },
          finish_reason: 'stop',
        },
      ],
    },
  });
  assert.equal(response.output[0].type, 'reasoning');
  assert.deepEqual(response.output[0].summary, [{ type: 'summary_text', text: '**Reasoning**\n\nreasoning trace' }]);
  assert.deepEqual(response.output[0].content, [{ type: 'reasoning_text', text: 'reasoning trace' }]);
  assert.equal(response.output[0].encrypted_content, null);
});

test('normalizes markdown markers in reasoning summary while preserving raw reasoning text', () => {
  const reasoningText = '## Plan\n\n*First point*\n\n- **Inspect** files\n\n1. _Report_ findings';
  const response = convertChatCompletionToResponses({
    responseId: 'resp_reasoning',
    model: 'deepseek-v4-pro',
    previousResponseId: null,
    normalized: normalizeResponsesRequest({ model: 'deepseek-v4-pro', input: 'think' }),
    completion: {
      id: 'chatcmpl_test',
      created: 1000,
      choices: [
        {
          message: {
            role: 'assistant',
            reasoning_content: reasoningText,
            content: 'answer',
          },
          finish_reason: 'stop',
        },
      ],
    },
  });
  assert.deepEqual(response.output[0].summary, [{ type: 'summary_text', text: '**Reasoning**\n\nPlan\n\nFirst point\n\n\u2022 Inspect files\n\n1) Report findings' }]);
  assert.deepEqual(response.output[0].content, [{ type: 'reasoning_text', text: reasoningText }]);
});

test('maps chat completion stream chunks to Responses events', () => {
  const mapper = new ResponsesStreamMapper({ responseId: 'resp_stream', model: 'deepseek-v4-flash' });
  const events = [
    ...mapper.mapChatEvent({
      data: JSON.stringify({
        choices: [{ delta: { reasoning_content: 'think' }, finish_reason: null }],
      }),
    }),
    ...mapper.mapChatEvent({
      data: JSON.stringify({
        choices: [{ delta: { content: 'hi' }, finish_reason: null }],
      }),
    }),
    ...mapper.mapChatEvent({
      data: JSON.stringify({
        choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
      }),
    }),
  ];
  assert.equal(events.some((event) => event.type === 'response.reasoning_text.delta'), false);
  assert.equal(events.some((event) => event.type === 'response.reasoning_summary_part.added'), true);
  assert.equal(events.some((event) => event.type === 'response.reasoning_summary_text.delta'), true);
  assert.equal(events.some((event) => event.type === 'response.reasoning_summary_text.done'), true);
  assert.equal(events.some((event) => event.type === 'response.reasoning_summary_part.done'), true);
  assert.equal(events.some((event) => event.type === 'response.output_text.delta'), true);
  assert.equal(events.some((event) => event.type === 'response.content_part.added'), true);
  assert.equal(events.some((event) => event.type === 'response.content_part.done'), true);
  const messageAdded = events.find((event) => event.type === 'response.output_item.added' && event.item.type === 'message');
  assert.deepEqual(messageAdded.item.content, []);
   const reasoningDoneIndex = events.findIndex((event) => event.type === 'response.output_item.done' && event.item.type === 'reasoning');
   const messageAddedIndex = events.findIndex((event) => event.type === 'response.output_item.added' && event.item.type === 'message');
   assert.ok(reasoningDoneIndex !== -1 && messageAddedIndex !== -1 && reasoningDoneIndex < messageAddedIndex);
  assert.equal(events.at(-1).type, 'response.completed');
  assert.equal(events.at(-1).response.output_text, 'hi');
  assert.equal(events.at(-1).response.output[0].summary[0].text, '**Reasoning**\n\nthink');
  assert.equal(events.at(-1).response.output[0].content[0].text, 'think');
  assert.equal(events.at(-1).response.output[0].encrypted_content, null);
  assert.equal(events.at(-1).response.usage.input_tokens, 2);
  assert.equal(events.at(-1).response.usage.output_tokens, 1);
  assert.equal(events.at(-1).response.usage.total_tokens, 3);
  assert.equal(mapper.assistantMessage().content, 'hi');
});

test('can stream raw reasoning text deltas when summary mode is disabled', () => {
  const mapper = new ResponsesStreamMapper({
    responseId: 'resp_stream',
    model: 'deepseek-v4-flash',
    emitReasoningSummary: false,
    emitReasoningText: true,
  });
  const events = [
    ...mapper.mapChatEvent({
      data: JSON.stringify({
        choices: [{ delta: { reasoning_content: 'think' }, finish_reason: null }],
      }),
    }),
    ...mapper.mapChatEvent({
      data: JSON.stringify({
        choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }],
        usage: { total_tokens: 3 },
      }),
    }),
  ];
  const contentPartAddedIndex = events.findIndex((event) => event.type === 'response.content_part.added');
  const reasoningDeltaIndex = events.findIndex((event) => event.type === 'response.reasoning_text.delta');
  const reasoningDoneIndex = events.findIndex((event) => event.type === 'response.reasoning_text.done');
  const contentPartDoneIndex = events.findIndex((event) => event.type === 'response.content_part.done');
  assert.notEqual(contentPartAddedIndex, -1);
  assert.notEqual(reasoningDeltaIndex, -1);
  assert.notEqual(reasoningDoneIndex, -1);
  assert.notEqual(contentPartDoneIndex, -1);
  assert.ok(contentPartAddedIndex < reasoningDeltaIndex);
  assert.ok(reasoningDeltaIndex < reasoningDoneIndex);
  assert.ok(reasoningDoneIndex < contentPartDoneIndex);
  assert.equal(events.some((event) => event.type === 'response.reasoning_summary_text.delta'), false);
  assert.equal(events.some((event) => event.type === 'response.reasoning_text.delta'), true);
  assert.equal(events.at(-1).response.output[0].content[0].text, 'think');
  assert.equal(events.at(-1).response.output[0].summary.length, 0);
});

test('buffers late reasoning deltas instead of streaming them after visible output starts', () => {
  const mapper = new ResponsesStreamMapper({ responseId: 'resp_stream', model: 'deepseek-v4-flash' });
  const events = [
    ...mapper.mapChatEvent({
      data: JSON.stringify({
        choices: [{ delta: { content: 'hi' }, finish_reason: null }],
      }),
    }),
    ...mapper.mapChatEvent({
      data: JSON.stringify({
        choices: [{ delta: { reasoning_content: '**Inspecting** hidden tail' }, finish_reason: null }],
      }),
    }),
    ...mapper.mapChatEvent({
      data: JSON.stringify({
        choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: { total_tokens: 3 },
      }),
    }),
  ];
  assert.equal(events.some((event) => event.type === 'response.reasoning_summary_text.delta'), false);
  const messageDoneIndex = events.findIndex((event) => event.type === 'response.output_item.done' && event.item.type === 'message');
  const reasoningDoneIndex = events.findIndex((event) => event.type === 'response.output_item.done' && event.item.type === 'reasoning');
  assert.notEqual(messageDoneIndex, -1);
  assert.notEqual(reasoningDoneIndex, -1);
  assert.ok(messageDoneIndex < reasoningDoneIndex);
  assert.equal(events.at(-1).response.output[1].summary[0].text, '**Reasoning**\n\nInspecting hidden tail');
  assert.equal(events.at(-1).response.output[1].content[0].text, '**Inspecting** hidden tail');
});

test('can buffer assistant output until done so reasoning appears before final answer', () => {
  const mapper = new ResponsesStreamMapper({
    responseId: 'resp_stream',
    model: 'deepseek-v4-flash',
    bufferOutputUntilDone: true,
  });
  const events = [
    ...mapper.mapChatEvent({
      data: JSON.stringify({
        choices: [{ delta: { reasoning_content: '**Plan** gather facts. ' }, finish_reason: null }],
      }),
    }),
    ...mapper.mapChatEvent({
      data: JSON.stringify({
        choices: [{ delta: { reasoning_content: 'Let me compile the report now.' }, finish_reason: null }],
      }),
    }),
    ...mapper.mapChatEvent({
      data: JSON.stringify({
        choices: [{ delta: { content: 'Now I have enough context. I will write the report.' }, finish_reason: null }],
      }),
    }),
    ...mapper.mapChatEvent({
      data: JSON.stringify({
        choices: [{ delta: {}, finish_reason: 'stop' }],
      }),
    }),
  ];
  assert.equal(events.some((event) => event.type === 'response.output_text.delta'), true);
  const reasoningDoneIndex = events.findIndex((event) => event.type === 'response.output_item.done' && event.item.type === 'reasoning');
  const messageAddedIndex = events.findIndex((event) => event.type === 'response.output_item.added' && event.item.type === 'message');
  assert.notEqual(reasoningDoneIndex, -1);
  assert.notEqual(messageAddedIndex, -1);
  assert.ok(reasoningDoneIndex < messageAddedIndex);
  assert.equal(events.at(-1).response.output[0].summary[0].text, '**Reasoning**\n\nPlan gather facts. Let me compile the report now.');
  assert.equal(events.at(-1).response.output[0].content[0].text, '**Plan** gather facts. Let me compile the report now.');
  assert.equal(events.at(-1).response.output_text, 'Now I have enough context. I will write the report.');
});

test('buffers summary reasoning in one part with ordered deltas before final answer', () => {
  const reasoningText = [
    'Opening line one.\nOpening line two.',
    'A'.repeat(1300),
    'Closing line.',
  ].join('\n\n');
  const mapper = new ResponsesStreamMapper({
    responseId: 'resp_stream',
    model: 'deepseek-v4-flash',
    bufferOutputUntilDone: true,
  });
  const events = [
    ...mapper.mapChatEvent({
      data: JSON.stringify({
        choices: [{ delta: { reasoning_content: reasoningText.slice(0, 20) }, finish_reason: null }],
      }),
    }),
    ...mapper.mapChatEvent({
      data: JSON.stringify({
        choices: [{ delta: { reasoning_content: reasoningText.slice(20) }, finish_reason: null }],
      }),
    }),
    ...mapper.mapChatEvent({
      data: JSON.stringify({
        choices: [{ delta: { content: 'final answer' }, finish_reason: null }],
      }),
    }),
    ...mapper.mapChatEvent({
      data: JSON.stringify({
        choices: [{ delta: {}, finish_reason: 'stop' }],
      }),
    }),
  ];
  const summaryPartAdded = events.filter((event) => event.type === 'response.reasoning_summary_part.added');
  const summaryDeltaEvents = events.filter((event) => event.type === 'response.reasoning_summary_text.delta');
  const summaryDoneEvents = events.filter((event) => event.type === 'response.reasoning_summary_text.done');
  const reasoningDoneIndex = events.findIndex((event) => event.type === 'response.output_item.done' && event.item.type === 'reasoning');
  const messageAddedIndex = events.findIndex((event) => event.type === 'response.output_item.added' && event.item.type === 'message');
  const finalSummaryText = events.at(-1).response.output[0].summary.map((part) => part.text).join('');

  assert.equal(summaryPartAdded.length, 1);
  assert.equal(summaryPartAdded[0].summary_index, 0);
  assert.ok(summaryDeltaEvents.length > 1);
  assert.equal(summaryDeltaEvents[0].delta.startsWith('**Reasoning**'), true);
  assert.equal(summaryDeltaEvents.map((event) => event.delta).join(''), `**Reasoning**\n\n${reasoningText}`);
  assert.equal(summaryDoneEvents.length, 1);
  assert.equal(summaryDoneEvents[0].text, `**Reasoning**\n\n${reasoningText}`);
  assert.equal(finalSummaryText, `**Reasoning**\n\n${reasoningText}`);
  assert.notEqual(reasoningDoneIndex, -1);
  assert.notEqual(messageAddedIndex, -1);
  assert.ok(reasoningDoneIndex < messageAddedIndex);
});

test('streams buffered reasoning summary before final completion while holding visible output', () => {
  const mapper = new ResponsesStreamMapper({
    responseId: 'resp_stream',
    model: 'deepseek-v4-flash',
    bufferOutputUntilDone: true,
  });
  const first = mapper.mapChatEvent({
    data: JSON.stringify({
      choices: [{ delta: { reasoning_content: 'First thought. ' }, finish_reason: null }],
    }),
  });
  const second = mapper.mapChatEvent({
    data: JSON.stringify({
      choices: [{ delta: { content: 'final answer' }, finish_reason: null }],
    }),
  });
  const done = mapper.mapChatEvent({
    data: JSON.stringify({
      choices: [{ delta: {}, finish_reason: 'stop' }],
    }),
  });
  const events = [...first, ...second, ...done];
  assert.equal(first.some((event) => event.type === 'response.output_item.added' && event.item.type === 'reasoning'), true);
  assert.equal(first.some((event) => event.type === 'response.reasoning_summary_part.added'), true);
  assert.equal(first.some((event) => event.type === 'response.reasoning_summary_text.delta'), true);
  assert.equal(second.some((event) => event.type === 'response.output_text.delta'), false);
  const summaryDeltaIndex = events.findIndex((event) => event.type === 'response.reasoning_summary_text.delta');
  const messageAddedIndex = events.findIndex((event) => event.type === 'response.output_item.added' && event.item.type === 'message');
  const reasoningDoneIndex = events.findIndex((event) => event.type === 'response.output_item.done' && event.item.type === 'reasoning');
  assert.notEqual(summaryDeltaIndex, -1);
  assert.notEqual(messageAddedIndex, -1);
  assert.notEqual(reasoningDoneIndex, -1);
  assert.ok(summaryDeltaIndex < reasoningDoneIndex);
  assert.ok(reasoningDoneIndex < messageAddedIndex);
  assert.equal(events.at(-1).response.output[0].summary[0].text, '**Reasoning**\n\nFirst thought.');
  assert.equal(events.at(-1).response.output[0].content[0].text, 'First thought. ');
  assert.equal(events.at(-1).response.output_text, 'final answer');
});

test('streams normalized summary text for markdown-heavy reasoning while keeping raw reasoning content', () => {
  const reasoningText = '## Plan\n\n*First point*\n\n- **Inspect** files\n\n1. _Report_ findings';
  const mapper = new ResponsesStreamMapper({
    responseId: 'resp_stream',
    model: 'deepseek-v4-flash',
    bufferOutputUntilDone: true,
  });
  const events = [
    ...mapper.mapChatEvent({
      data: JSON.stringify({
        choices: [{ delta: { reasoning_content: reasoningText }, finish_reason: null }],
      }),
    }),
    ...mapper.mapChatEvent({
      data: JSON.stringify({
        choices: [{ delta: { content: 'final answer' }, finish_reason: null }],
      }),
    }),
    ...mapper.mapChatEvent({
      data: JSON.stringify({
        choices: [{ delta: {}, finish_reason: 'stop' }],
      }),
    }),
  ];
  const summaryText = events
    .filter((event) => event.type === 'response.reasoning_summary_text.delta')
    .map((event) => event.delta)
    .join('');
  assert.equal(summaryText, '**Reasoning**\n\nPlan\n\nFirst point\n\n\u2022 Inspect files\n\n1) Report findings');
  assert.equal(events.at(-1).response.output[0].summary.map((part) => part.text).join(''), '**Reasoning**\n\nPlan\n\nFirst point\n\n\u2022 Inspect files\n\n1) Report findings');
  assert.equal(events.at(-1).response.output[0].content[0].text, reasoningText);
});

test('flushes buffered raw reasoning completely before final answer', () => {
  const reasoningText = `Line 1
Line 2
${'A'.repeat(1400)}
Line 3`;
  const mapper = new ResponsesStreamMapper({
    responseId: 'resp_stream',
    model: 'deepseek-v4-flash',
    bufferOutputUntilDone: true,
    emitReasoningSummary: false,
    emitReasoningText: true,
  });
  const events = [
    ...mapper.mapChatEvent({
      data: JSON.stringify({
        choices: [{ delta: { reasoning_content: reasoningText.slice(0, 18) }, finish_reason: null }],
      }),
    }),
    ...mapper.mapChatEvent({
      data: JSON.stringify({
        choices: [{ delta: { reasoning_content: reasoningText.slice(18) }, finish_reason: null }],
      }),
    }),
    ...mapper.mapChatEvent({
      data: JSON.stringify({
        choices: [{ delta: { content: 'final answer' }, finish_reason: null }],
      }),
    }),
    ...mapper.mapChatEvent({
      data: JSON.stringify({
        choices: [{ delta: {}, finish_reason: 'stop' }],
      }),
    }),
  ];
  const reasoningContentAddedIndex = events.findIndex(
    (event) => event.type === 'response.content_part.added' && event.item_id?.startsWith('rs_'),
  );
  const reasoningDeltaEvents = events.filter((event) => event.type === 'response.reasoning_text.delta');
  const reasoningDeltaIndex = events.findIndex(
    (event) => event.type === 'response.reasoning_text.delta',
  );
  const reasoningDoneIndex = events.findIndex((event) => event.type === 'response.output_item.done' && event.item.type === 'reasoning');
  const messageAddedIndex = events.findIndex((event) => event.type === 'response.output_item.added' && event.item.type === 'message');
  assert.notEqual(reasoningContentAddedIndex, -1);
  assert.ok(reasoningDeltaEvents.length > 1);
  assert.equal(reasoningDeltaEvents[0].delta.startsWith('Line 1\nLine 2\n'), true);
  assert.equal(reasoningDeltaEvents.map((event) => event.delta).join(''), reasoningText);
  assert.notEqual(reasoningDeltaIndex, -1);
  assert.notEqual(reasoningDoneIndex, -1);
  assert.notEqual(messageAddedIndex, -1);
  assert.ok(reasoningContentAddedIndex < reasoningDeltaIndex);
  assert.ok(reasoningDeltaIndex < reasoningDoneIndex);
  assert.ok(reasoningDoneIndex < messageAddedIndex);
  assert.equal(events.at(-1).response.output[0].content[0].text, reasoningText);
  assert.equal(events.at(-1).response.output_text, 'final answer');
});

test('normalizes stringified shell command arrays in buffered tool calls', () => {
  const mapper = new ResponsesStreamMapper({
    responseId: 'resp_stream',
    model: 'deepseek-v4-flash',
    bufferOutputUntilDone: true,
    normalized: {
      tools: [
        {
          type: 'function',
          function: {
            name: 'shell',
            parameters: {
              type: 'object',
              properties: {
                command: { type: 'array', items: { type: 'string' } },
              },
            },
          },
        },
      ],
    },
  });
  const events = [
    ...mapper.mapChatEvent({
      data: JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_shell',
                  function: {
                    name: 'shell',
                    arguments: '{"command":"[\\"powershell.exe\\",\\"-Command\\",\\"Get-Content package.json\\"]"}',
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      }),
    }),
    ...mapper.mapChatEvent({
      data: JSON.stringify({
        choices: [{ delta: {}, finish_reason: 'tool_calls' }],
      }),
    }),
  ];
  const done = events.find((event) => event.type === 'response.function_call_arguments.done');
  assert.equal(done.arguments, '{"command":["powershell.exe","-Command","Get-Content package.json"]}');
});

test('normalizes stringified command arrays from Responses input_schema tools', () => {
  const mapper = new ResponsesStreamMapper({
    responseId: 'resp_stream',
    model: 'deepseek-v4-flash',
    bufferOutputUntilDone: true,
    normalized: {
      tools: [
        {
          type: 'function',
          name: 'shell',
          input_schema: {
            type: 'object',
            properties: {
              command: { type: 'array', items: { type: 'string' } },
            },
          },
        },
      ],
    },
  });
  const events = [
    ...mapper.mapChatEvent({
      data: JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_shell',
                  function: {
                    name: 'shell',
                    arguments: '{"command":"[\\"cmd\\",\\"/c\\",\\"echo hello\\"]"}',
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      }),
    }),
    ...mapper.mapChatEvent({
      data: JSON.stringify({
        choices: [{ delta: {}, finish_reason: 'tool_calls' }],
      }),
    }),
  ];
  const done = events.find((event) => event.type === 'response.function_call_arguments.done');
  assert.equal(done.arguments, '{"command":["cmd","/c","echo hello"]}');
});

test('normalizes stringified command arrays in non-buffered tool calls', () => {
  const mapper = new ResponsesStreamMapper({
    responseId: 'resp_stream',
    model: 'deepseek-v4-flash',
    normalized: {
      tools: [
        {
          type: 'function',
          name: 'shell',
          input_schema: {
            type: 'object',
            properties: {
              command: { type: 'array', items: { type: 'string' } },
            },
          },
        },
      ],
    },
  });
  const events = [
    ...mapper.mapChatEvent({
      data: JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_shell',
                  function: {
                    name: 'shell',
                    arguments: '{"command":"[\\"cmd\\",\\"/c\\",\\"echo hello\\"]"}',
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      }),
    }),
    ...mapper.mapChatEvent({
      data: JSON.stringify({
        choices: [{ delta: {}, finish_reason: 'tool_calls' }],
      }),
    }),
  ];
  const done = events.find((event) => event.type === 'response.function_call_arguments.done');
  const outputDone = events.find((event) => event.type === 'response.output_item.done' && event.item.type === 'function_call');
  assert.equal(done.arguments, '{"command":["cmd","/c","echo hello"]}');
  assert.equal(outputDone.item.arguments, '{"command":["cmd","/c","echo hello"]}');
});

test('normalizes stringified tool argument values according to schema', () => {
  const mapper = new ResponsesStreamMapper({
    responseId: 'resp_stream',
    model: 'deepseek-v4-flash',
    bufferOutputUntilDone: true,
    normalized: {
      tools: [
        {
          type: 'function',
          function: {
            name: 'configure',
            parameters: {
              type: 'object',
              properties: {
                options: { type: 'object', properties: { mode: { type: 'string' } } },
                ids: { type: 'array', items: { type: 'string' } },
                dry_run: { type: 'boolean' },
                count: { type: 'integer' },
                note: { type: 'string' },
              },
            },
          },
        },
      ],
    },
  });
  const events = [
    ...mapper.mapChatEvent({
      data: JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_configure',
                  function: {
                    name: 'configure',
                    arguments: JSON.stringify({
                      options: '{"mode":"fast"}',
                      ids: '["a","b"]',
                      dry_run: 'true',
                      count: '2',
                      note: '["keep as string"]',
                    }),
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      }),
    }),
    ...mapper.mapChatEvent({
      data: JSON.stringify({
        choices: [{ delta: {}, finish_reason: 'tool_calls' }],
      }),
    }),
  ];
  const done = events.find((event) => event.type === 'response.function_call_arguments.done');
  assert.deepEqual(JSON.parse(done.arguments), {
    options: { mode: 'fast' },
    ids: ['a', 'b'],
    dry_run: true,
    count: 2,
    note: '["keep as string"]',
  });
});

test('normalizes stringified command arrays in non-streaming chat completions', () => {
  const response = convertChatCompletionToResponses({
    responseId: 'resp_tool',
    model: 'deepseek-v4-flash',
    previousResponseId: null,
    normalized: normalizeResponsesRequest({
      model: 'deepseek-v4-flash',
      input: 'run command',
      tools: [
        {
          type: 'function',
          name: 'shell',
          input_schema: {
            type: 'object',
            properties: {
              command: { type: 'array', items: { type: 'string' } },
            },
          },
        },
      ],
    }),
    completion: {
      id: 'chatcmpl_test',
      created: 1000,
      choices: [
        {
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'call_shell',
                type: 'function',
                function: {
                  name: 'shell',
                  arguments: '{"command":"[\\"cmd\\",\\"/c\\",\\"echo hello\\"]"}',
                },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    },
  });
  const toolCall = response.output.find((item) => item.type === 'function_call');
  assert.equal(toolCall.arguments, '{"command":["cmd","/c","echo hello"]}');
});

test('finalizes Responses stream when upstream sends DONE without finish reason', () => {
  const mapper = new ResponsesStreamMapper({ responseId: 'resp_stream', model: 'deepseek-v4-flash' });
  const events = [
    ...mapper.mapChatEvent({
      data: JSON.stringify({
        choices: [{ delta: { content: 'hi' }, finish_reason: null }],
      }),
    }),
    ...mapper.mapChatEvent({ done: true }),
  ];
  assert.equal(events.at(-1).type, 'response.completed');
  assert.equal(events.at(-1).response.output[0].content[0].text, 'hi');
});

test('maps a full chat completion object through the streaming mapper fallback', () => {
  const mapper = new ResponsesStreamMapper({ responseId: 'resp_stream', model: 'deepseek-v4-flash' });
  const events = mapper.mapChatEvent({
    data: {
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'hi',
            reasoning_content: 'think',
          },
          finish_reason: 'stop',
        },
      ],
      usage: { total_tokens: 3 },
    },
  });
  assert.equal(events.some((event) => event.type === 'response.reasoning_summary_text.delta'), true);
  assert.equal(events.some((event) => event.type === 'response.reasoning_text.delta'), false);
  assert.equal(events.some((event) => event.type === 'response.output_text.delta'), true);
  assert.equal(events.at(-1).type, 'response.completed');
  assert.equal(events.at(-1).response.usage.input_tokens, 0);
  assert.equal(events.at(-1).response.usage.output_tokens, 0);
  assert.equal(events.at(-1).response.usage.total_tokens, 3);
});

test('serializes and parses SSE frames with CRLF', () => {
  const parser = new SseParser();
  const frame = serializeResponsesSseEvent({ type: 'response.created', sequence_number: 1, response: { id: 'resp_1' } });
  const parsed = parser.push(Buffer.from(frame.replaceAll('\n', '\r\n')));
  assert.equal(parsed.length, 1);
  assert.equal(JSON.parse(parsed[0].data).type, 'response.created');
});
