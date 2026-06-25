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

test('preserves namespaced multi-agent tools through the Chat bridge', () => {
  const normalized = normalizeResponsesRequest({
    model: 'deepseek-v4-flash',
    input: 'delegate work',
    tools: [
      {
        type: 'function',
        namespace: 'multi_agent_v1',
        name: 'spawn_agent',
        description: 'Spawn a sub-agent',
        parameters: {
          type: 'object',
          properties: { message: { type: 'string' } },
          required: ['message'],
        },
      },
      {
        type: 'function',
        namespace: 'multi_agent_v1',
        name: 'wait_agent',
        description: 'Wait for agents',
        parameters: {
          type: 'object',
          properties: { targets: { type: 'array', items: { type: 'string' } } },
          required: ['targets'],
        },
      },
    ],
  });
  const chat = toChatCompletionsRequest(normalized);
  assert.deepEqual(chat.tools.map((tool) => tool.function.name), [
    'multi_agent_v1__spawn_agent',
    'multi_agent_v1__wait_agent',
  ]);
  assert.equal('namespace' in chat.tools[0], false);

  const response = convertChatCompletionToResponses({
    responseId: 'resp_multi_agent',
    model: 'deepseek-v4-flash',
    previousResponseId: null,
    normalized,
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
                id: 'call_wait',
                type: 'function',
                function: {
                  name: 'multi_agent_v1__wait_agent',
                  arguments: '{"targets":["agent_1"]}',
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
  assert.equal(toolCall.namespace, 'multi_agent_v1');
  assert.equal(toolCall.name, 'wait_agent');
});

test('maps Codex tool_search calls back to native Responses items', () => {
  const normalized = normalizeResponsesRequest({
    model: 'deepseek-v4-flash',
    input: 'find sub-agent tools',
    tools: [
      {
        type: 'tool_search',
        execution: 'client',
        description: 'Search deferred tools.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            limit: { type: 'number' },
          },
          required: ['query'],
          additionalProperties: false,
        },
      },
    ],
  });
  const chat = toChatCompletionsRequest(normalized);
  assert.equal(chat.tools[0].type, 'function');
  assert.equal(chat.tools[0].function.name, 'tool_search');

  const response = convertChatCompletionToResponses({
    responseId: 'resp_tool_search',
    model: 'deepseek-v4-flash',
    previousResponseId: null,
    normalized,
    completion: {
      id: 'chatcmpl_tool_search',
      created: 1000,
      choices: [
        {
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'call_search',
                type: 'function',
                function: {
                  name: 'tool_search',
                  arguments: '{"query":"spawn sub agent","limit":8}',
                },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    },
  });
  const toolSearchCall = response.output.find((item) => item.type === 'tool_search_call');
  assert.equal(toolSearchCall.call_id, 'call_search');
  assert.equal(toolSearchCall.execution, 'client');
  assert.deepEqual(toolSearchCall.arguments, { limit: 8, query: 'spawn sub agent' });
  assert.equal(response.output.some((item) => item.type === 'function_call' && item.name === 'tool_search'), false);
});

test('loads tools returned by Codex tool_search_output on the next request', () => {
  const normalized = normalizeResponsesRequest({
    model: 'deepseek-v4-flash',
    input: [
      {
        type: 'tool_search_call',
        id: 'tsc_1',
        call_id: 'call_search',
        status: 'completed',
        execution: 'client',
        arguments: { query: 'spawn agent', limit: 8 },
      },
      {
        type: 'tool_search_output',
        call_id: 'call_search',
        status: 'completed',
        execution: 'client',
        tools: [
          {
            type: 'namespace',
            name: 'multi_agent_v1',
            tools: [
              {
                type: 'function',
                name: 'spawn_agent',
                parameters: {
                  type: 'object',
                  properties: {
                    message: { type: 'string' },
                    model: { type: 'string' },
                    reasoning_effort: { type: 'string' },
                  },
                  required: ['message'],
                  additionalProperties: false,
                },
              },
            ],
          },
        ],
      },
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'use the discovered tool' }],
      },
    ],
  });
  const chat = toChatCompletionsRequest(normalized);
  const names = chat.tools.map((tool) => tool.function.name);
  assert.deepEqual(names, ['multi_agent_v1__spawn_agent']);
  assert.equal(chat.messages.some((message) => Array.isArray(message.tool_calls)), false);
  assert.equal(chat.messages.some((message) => message.role === 'tool'), false);
});

test('expands Codex namespace tool groups before sending Chat tools', () => {
  const normalized = normalizeResponsesRequest({
    model: 'deepseek-v4-flash',
    input: 'delegate work',
    tools: [
      {
        type: 'namespace',
        name: 'multi_agent_v1',
        description: 'Tools for spawning and managing sub-agents.',
        tools: [
          {
            type: 'function',
            name: 'spawn_agent',
            description: 'Spawn a sub-agent',
            parameters: {
              type: 'object',
              properties: {
                agent_type: { type: 'string' },
                message: { type: 'string' },
              },
              additionalProperties: false,
            },
          },
          {
            type: 'function',
            name: 'resume_agent',
            parameters: {
              type: 'object',
              properties: { id: { type: 'string' } },
              required: ['id'],
              additionalProperties: false,
            },
          },
          {
            type: 'function',
            name: 'close_agent',
            parameters: {
              type: 'object',
              properties: { target: { type: 'string' } },
              required: ['target'],
              additionalProperties: false,
            },
          },
          {
            type: 'function',
            name: 'wait_agent',
            parameters: {
              type: 'object',
              properties: {
                targets: { type: 'array', items: { type: 'string' } },
                timeout_ms: { type: 'number' },
              },
              required: ['targets'],
              additionalProperties: false,
            },
          },
          {
            type: 'function',
            name: 'send_input',
            parameters: {
              type: 'object',
              properties: {
                target: { type: 'string' },
                message: { type: 'string' },
                interrupt: { type: 'boolean' },
              },
              required: ['target'],
              additionalProperties: false,
            },
          },
        ],
      },
    ],
  });
  const chat = toChatCompletionsRequest(normalized);
  assert.deepEqual(chat.tools.map((tool) => tool.function.name), [
    'multi_agent_v1__spawn_agent',
    'multi_agent_v1__resume_agent',
    'multi_agent_v1__close_agent',
    'multi_agent_v1__wait_agent',
    'multi_agent_v1__send_input',
  ]);
  assert.equal(chat.tools[0].function.description, 'Spawn a sub-agent');
  assert.deepEqual(chat.tools[0].function.parameters.properties.message, { type: 'string' });
  assert.deepEqual(chat.tools[3].function.parameters.required, ['targets']);

  const response = convertChatCompletionToResponses({
    responseId: 'resp_multi_agent_namespace',
    model: 'deepseek-v4-flash',
    previousResponseId: null,
    normalized,
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
                id: 'call_spawn',
                type: 'function',
                function: {
                  name: 'multi_agent_v1__spawn_agent',
                  arguments: '{"agent_type":"explorer","message":"inspect protocol conversion"}',
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
  assert.equal(toolCall.namespace, 'multi_agent_v1');
  assert.equal(toolCall.name, 'spawn_agent');
  assert.equal(toolCall.arguments, '{"agent_type":"explorer","message":"inspect protocol conversion"}');
});

test('keeps DeepSeek spawn_agent model aliases when schema allows them', () => {
  const normalized = normalizeResponsesRequest({
    model: 'deepseek-v4-pro',
    input: 'delegate work',
    tools: [
      {
        type: 'namespace',
        name: 'multi_agent_v1',
        tools: [
          {
            type: 'function',
            name: 'spawn_agent',
            parameters: {
              type: 'object',
              properties: {
                message: { type: 'string' },
                model: { type: 'string' },
                reasoning_effort: { type: 'string' },
              },
              required: ['message'],
              additionalProperties: false,
            },
          },
        ],
      },
    ],
  });
  const response = convertChatCompletionToResponses({
    responseId: 'resp_spawn_model_alias',
    model: 'deepseek-v4-pro',
    previousResponseId: null,
    normalized,
    config: { upstreamProvider: 'deepseek', modelAliases: DEFAULT_MODEL_ALIASES },
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
                id: 'call_spawn',
                type: 'function',
                function: {
                  name: 'multi_agent_v1__spawn_agent',
                  arguments: '{"message":"say hi","model":"deepseek-v4-flash","reasoning_effort":"low"}',
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
  assert.equal(toolCall.namespace, 'multi_agent_v1');
  assert.equal(toolCall.name, 'spawn_agent');
  assert.equal(toolCall.arguments, '{"message":"say hi","model":"deepseek-v4-flash","reasoning_effort":"low"}');
});

test('keeps explicit spawn_agent DeepSeek model and effort even when the model matches the parent', () => {
  const normalized = normalizeResponsesRequest({
    model: 'deepseek-v4-pro',
    reasoning: { effort: 'xhigh' },
    input: 'delegate work',
    tools: [
      {
        type: 'namespace',
        name: 'multi_agent_v1',
        tools: [
          {
            type: 'function',
            name: 'spawn_agent',
            parameters: {
              type: 'object',
              properties: {
                message: { type: 'string' },
                model: { type: 'string' },
                reasoning_effort: { type: 'string' },
              },
              required: ['message'],
              additionalProperties: false,
            },
          },
        ],
      },
    ],
  });
  const response = convertChatCompletionToResponses({
    responseId: 'resp_spawn_inherited_gateway_model',
    model: 'deepseek-v4-pro',
    previousResponseId: null,
    normalized,
    config: { upstreamProvider: 'deepseek', modelAliases: DEFAULT_MODEL_ALIASES },
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
                id: 'call_spawn',
                type: 'function',
                function: {
                  name: 'multi_agent_v1__spawn_agent',
                  arguments: '{"message":"say hi","model":"deepseek-v4-pro","reasoning_effort":"low"}',
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
  assert.equal(toolCall.arguments, '{"message":"say hi","model":"deepseek-v4-pro","reasoning_effort":"low"}');
});

test('drops non-gateway spawn_agent model overrides before returning to Codex', () => {
  const normalized = normalizeResponsesRequest({
    model: 'deepseek-v4-pro',
    input: 'delegate work',
    tools: [
      {
        type: 'namespace',
        name: 'multi_agent_v1',
        tools: [
          {
            type: 'function',
            name: 'spawn_agent',
            parameters: {
              type: 'object',
              properties: {
                message: { type: 'string' },
                model: { type: 'string' },
                reasoning_effort: { type: 'string' },
              },
              required: ['message'],
              additionalProperties: false,
            },
          },
        ],
      },
    ],
  });
  const response = convertChatCompletionToResponses({
    responseId: 'resp_spawn_gpt_model_dropped',
    model: 'deepseek-v4-pro',
    previousResponseId: null,
    normalized,
    config: { upstreamProvider: 'deepseek', modelAliases: DEFAULT_MODEL_ALIASES },
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
                id: 'call_spawn',
                type: 'function',
                function: {
                  name: 'multi_agent_v1__spawn_agent',
                  arguments: '{"message":"say hi","model":"gpt-5.4-mini","reasoning_effort":"low"}',
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
  assert.equal(toolCall.arguments, '{"message":"say hi","reasoning_effort":"low"}');
});

test('does not split ordinary double-underscore tool names as namespaces', () => {
  const normalized = normalizeResponsesRequest({
    model: 'deepseek-v4-flash',
    input: 'use mcp',
    tools: [
      {
        type: 'function',
        name: 'mcp__context7__query_docs',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string' } },
        },
      },
    ],
  });
  const response = convertChatCompletionToResponses({
    responseId: 'resp_mcp_name',
    model: 'deepseek-v4-flash',
    previousResponseId: null,
    normalized,
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
                id: 'call_mcp',
                type: 'function',
                function: {
                  name: 'mcp__context7__query_docs',
                  arguments: '{"query":"hooks"}',
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
  assert.equal(toolCall.namespace, undefined);
  assert.equal(toolCall.name, 'mcp__context7__query_docs');
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

test('adapts DeepSeek-facing tools without changing internal tool mapping', () => {
  const normalized = normalizeResponsesRequest({
    model: 'deepseek-v4-flash',
    input: 'delegate',
    tools: [
      {
        type: 'namespace',
        name: 'multi_agent_v1',
        description: 'Tools for spawning and managing sub-agents.',
        tools: [
          {
            type: 'function',
            name: 'spawn_agent',
            description: [
              'Spawn a sub-agent to work on a task. This original Codex description can be long, detailed, and tailored for native Codex models.',
              'DeepSeek should receive only a compact function description while the gateway keeps the original schema for Responses mapping.',
            ].join(' '),
            parameters: {
              type: 'object',
              properties: {
                message: {
                  type: 'string',
                  description: 'The task prompt sent to the sub-agent, including all required context for independent execution.',
                },
                model: {
                  type: 'string',
                  enum: ['gpt-5.5'],
                  description: 'Original Codex model override description.',
                },
                reasoning_effort: {
                  type: 'string',
                  enum: ['minimal', 'low', 'medium', 'high'],
                  description: 'Original Codex reasoning effort description.',
                },
              },
              required: ['message'],
              additionalProperties: false,
            },
          },
        ],
      },
    ],
  });
  const chat = toChatCompletionsRequest(normalized);
  assert.match(chat.tools[0].function.description, /original Codex description can be long/);
  assert.deepEqual(chat.tools[0].function.parameters.properties.model.enum, ['gpt-5.5']);
  assert.deepEqual(chat.tools[0].function.parameters.properties.reasoning_effort.enum, ['minimal', 'low', 'medium', 'high']);

  const request = toProviderChatCompletionsRequest(chat, {
    upstreamProvider: 'deepseek',
    modelAliases: {
      ...DEFAULT_MODEL_ALIASES,
      'deepseek-v4-pro-analysis': { model: 'deepseek-v4-pro', thinking: 'auto' },
    },
  });
  assert.match(request.messages[0].content, /real callable functions available now/);
  assert.match(request.messages[0].content, /tool_calls/);
  assert.equal(request.messages[0].content.includes('pseudo XML'), true);
  assert.equal(request.tools[0].function.name, 'multi_agent_v1__spawn_agent');
  assert.ok(request.tools[0].function.description.length < chat.tools[0].function.description.length);
  assert.match(request.tools[0].function.description, /Codex-native sub-agent/);
  assert.match(request.tools[0].function.description, /model\/reasoning_effort to inherit/);
  assert.equal(request.tools[0].function.description.includes('deepseek-v4-flash'), false);
  assert.match(request.tools[0].function.description, /Required: message/);
  assert.ok(request.tools[0].function.parameters.properties.message.description.length < 170);
  assert.deepEqual(request.tools[0].function.parameters.properties.model.enum, [
    'deepseek-v4-flash',
    'deepseek-v4-pro',
    'deepseek-v4-pro-analysis',
  ]);
  assert.deepEqual(request.tools[0].function.parameters.properties.reasoning_effort.enum, ['low', 'medium', 'high', 'xhigh']);
  assert.equal(JSON.stringify(request.tools[0]).includes('gpt-5.5'), false);
  assert.equal(JSON.stringify(request.tools[0]).includes('minimal'), false);
});

test('filters tools for Codex allowed_tools without forcing a call', () => {
  const normalized = normalizeResponsesRequest({
    model: 'deepseek-v4-flash',
    input: 'use a tool',
    tools: [
      { type: 'function', name: 'lookup', parameters: { type: 'object', properties: {} } },
      { type: 'function', namespace: 'multi_agent_v1', name: 'spawn_agent', parameters: { type: 'object', properties: {} } },
    ],
    tool_choice: {
      type: 'allowed_tools',
      mode: 'auto',
      tools: [{ type: 'function', namespace: 'multi_agent_v1', name: 'spawn_agent' }],
    },
  });
  const chat = toChatCompletionsRequest(normalized);
  assert.deepEqual(chat.tools.map((tool) => tool.function.name), ['multi_agent_v1__spawn_agent']);
  assert.equal(chat.tool_choice, 'auto');
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

test('does not feed reasoning summary display text back into DeepSeek history when raw reasoning exists', () => {
  const normalized = normalizeResponsesRequest({
    model: 'deepseek-v4-pro',
    input: [
      {
        type: 'reasoning',
        content: [{ type: 'reasoning_text', text: 'raw thinking' }],
        summary: [{ type: 'summary_text', text: '**Reasoning**\n\nraw thinking' }],
      },
      {
        type: 'function_call',
        call_id: 'call_1',
        name: 'lookup',
        arguments: '{"q":"x"}',
      },
    ],
  });
  const chat = toChatCompletionsRequest(normalized);
  assert.equal(chat.messages[0].reasoning_content, 'raw thinking');
});

test('does not use reasoning summary as DeepSeek history when raw reasoning text is absent', () => {
  const normalized = normalizeResponsesRequest({
    model: 'deepseek-v4-pro',
    input: [
      {
        type: 'reasoning',
        summary: [{ type: 'summary_text', text: '**Reasoning**\n\nsummary fallback' }],
      },
      {
        type: 'function_call',
        call_id: 'call_1',
        name: 'lookup',
        arguments: '{"q":"x"}',
      },
    ],
  });
  const chat = toChatCompletionsRequest(normalized);
  assert.equal('reasoning_content' in chat.messages[0], false);
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
  assert.deepEqual(response.output[0].summary, [{ type: 'summary_text', text: 'reasoning trace' }]);
  assert.deepEqual(response.output[0].content, []);
  assert.equal(response.output[0].reasoning_content, 'reasoning trace');
  assert.equal(response.output[0].encrypted_content, null);
  assert.equal(assistantMessageFromResponseOutput(response.output).reasoning_content, 'reasoning trace');
});

test('normalizes markdown in Codex summary without changing raw reasoning content', () => {
  const reasoningText = [
    'First thought.',
    '',
    '**Reasoning**',
    '',
    'The upstream model emitted this word itself.',
  ].join('\n');
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
  assert.equal(response.output[0].summary[0].text, 'First thought.\n\nReasoning\n\nThe upstream model emitted this word itself.');
  assert.deepEqual(response.output[0].content, []);
  assert.equal(response.output[0].reasoning_content, reasoningText);
  assert.equal(assistantMessageFromResponseOutput(response.output).reasoning_content, reasoningText);
});

test('normalizes markdown summary display while preserving raw reasoning history', () => {
  const reasoningText = '## Plan\n\n*First point*\n\n- **Inspect** files\n\n1. _Report_ findings';
  const displayText = 'Plan\n\nFirst point\n\n\u2022 Inspect files\n\n1) Report findings';
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
  assert.deepEqual(response.output[0].summary, [{ type: 'summary_text', text: displayText }]);
  assert.deepEqual(response.output[0].content, []);
  assert.equal(response.output[0].reasoning_content, reasoningText);
  assert.equal(assistantMessageFromResponseOutput(response.output).reasoning_content, reasoningText);
});

test('normalizes numbered and bulleted reasoning markdown only in Codex summary display', () => {
  const reasoningText = [
    'From the search results:',
    '',
    '1. **Reddit user feedback on V4 creative writing** (r/DeepSeek):',
    '   - The snippet says: "It relies heavily on abstract emotions."',
    '',
    '- **Keep bullet emphasis** unchanged.',
  ].join('\n');
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
  assert.equal(
    response.output[0].summary[0].text,
    [
      'From the search results:',
      '',
      '1) Reddit user feedback on V4 creative writing (r/DeepSeek):',
      '\u2022 The snippet says: "It relies heavily on abstract emotions."',
      '',
      '\u2022 Keep bullet emphasis unchanged.',
    ].join('\n'),
  );
  assert.equal(response.output[0].reasoning_content, reasoningText);
  assert.equal(assistantMessageFromResponseOutput(response.output).reasoning_content, reasoningText);
});

test('uses summary only for visible reasoning to avoid duplicate display', () => {
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
            reasoning_content: '1. Inspect\n2. Answer',
            content: 'done',
          },
          finish_reason: 'stop',
        },
      ],
    },
  });
  assert.equal(response.output[0].summary[0].text, '1) Inspect\n2) Answer');
  assert.deepEqual(response.output[0].content, []);
  assert.equal(response.output[0].reasoning_content, '1. Inspect\n2. Answer');
});

test('default reasoning stream exposes summary only while retaining raw history text', () => {
  const mapper = new ResponsesStreamMapper({ responseId: 'resp_stream', model: 'deepseek-v4-flash' });
  const events = [
    ...mapper.mapChatEvent({
      data: JSON.stringify({
        choices: [{ delta: { reasoning_content: '1. Inspect' }, finish_reason: null }],
      }),
    }),
    ...mapper.mapChatEvent({
      data: JSON.stringify({
        choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }],
      }),
    }),
  ];
  assert.equal(events.some((event) => event.type === 'response.reasoning_text.delta'), false);
  assert.equal(events.some((event) => event.type === 'response.reasoning_text.done'), false);
  assert.equal(events.at(-1).response.output[0].summary[0].text, '1) Inspect');
  assert.deepEqual(events.at(-1).response.output[0].content, []);
  assert.equal(events.at(-1).response.output[0].reasoning_content, '1. Inspect');
  assert.equal(mapper.assistantMessage().reasoning_content, '1. Inspect');
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
  assert.equal(events.at(-1).response.output[0].summary[0].text, 'think');
  assert.deepEqual(events.at(-1).response.output[0].content, []);
  assert.equal(events.at(-1).response.output[0].encrypted_content, null);
  assert.equal(events.at(-1).response.usage.input_tokens, 2);
  assert.equal(events.at(-1).response.usage.output_tokens, 1);
  assert.equal(events.at(-1).response.usage.total_tokens, 3);
  assert.equal(mapper.assistantMessage().content, 'hi');
  assert.equal(mapper.assistantMessage().reasoning_content, 'think');
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
  assert.equal(events.at(-1).response.output[1].summary[0].text, 'Inspecting hidden tail');
  assert.deepEqual(events.at(-1).response.output[1].content, []);
  assert.equal(events.at(-1).response.output[1].reasoning_content, '**Inspecting** hidden tail');
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
  assert.equal(events.at(-1).response.output[0].summary[0].text, 'Plan gather facts. Let me compile the report now.');
  assert.deepEqual(events.at(-1).response.output[0].content, []);
  assert.equal(events.at(-1).response.output_text, 'Now I have enough context. I will write the report.');
  assert.equal(mapper.assistantMessage().reasoning_content, '**Plan** gather facts. Let me compile the report now.');
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
  assert.equal(summaryDeltaEvents[0].delta.startsWith('Opening line one.'), true);
  assert.equal(summaryDeltaEvents.map((event) => event.delta).join(''), reasoningText);
  assert.equal(summaryDoneEvents.length, 1);
  assert.equal(summaryDoneEvents[0].text, reasoningText);
  assert.equal(finalSummaryText, reasoningText);
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
  assert.equal(events.at(-1).response.output[0].summary[0].text, 'First thought.');
  assert.deepEqual(events.at(-1).response.output[0].content, []);
  assert.equal(events.at(-1).response.output_text, 'final answer');
});

test('streams normalized reasoning summary while keeping raw reasoning content', () => {
  const reasoningText = '## Plan\n\n*First point*\n\n- **Inspect** files\n\n1. _Report_ findings';
  const displayText = 'Plan\n\nFirst point\n\n\u2022 Inspect files\n\n1) Report findings';
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
  assert.equal(summaryText, displayText);
  assert.equal(events.at(-1).response.output[0].summary.map((part) => part.text).join(''), displayText);
  assert.deepEqual(events.at(-1).response.output[0].content, []);
  assert.equal(events.at(-1).response.output[0].reasoning_content, reasoningText);
  assert.equal(mapper.assistantMessage().reasoning_content, reasoningText);
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

test('buffers native tool_search calls without function argument events', () => {
  const mapper = new ResponsesStreamMapper({
    responseId: 'resp_stream',
    model: 'deepseek-v4-flash',
    bufferOutputUntilDone: true,
    normalized: normalizeResponsesRequest({
      model: 'deepseek-v4-flash',
      input: 'find sub-agent tools',
      tools: [
        {
          type: 'tool_search',
          execution: 'client',
          description: 'Search deferred tools.',
          parameters: {
            type: 'object',
            properties: {
              query: { type: 'string' },
              limit: { type: 'number' },
            },
            required: ['query'],
            additionalProperties: false,
          },
        },
      ],
    }),
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
                  id: 'call_search',
                  type: 'function',
                  function: {
                    name: 'tool_search',
                    arguments: '{"query":"spawn',
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
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  function: {
                    arguments: ' agent","limit":8}',
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
  const outputDone = events.find((event) => event.type === 'response.output_item.done' && event.item.type === 'tool_search_call');
  assert.equal(outputDone.item.call_id, 'call_search');
  assert.equal(outputDone.item.execution, 'client');
  assert.deepEqual(outputDone.item.arguments, { limit: 8, query: 'spawn agent' });
  assert.equal(events.some((event) => event.type === 'response.function_call_arguments.done'), false);
});

test('streams namespace tool group calls back with namespace restored', () => {
  const normalized = normalizeResponsesRequest({
    model: 'deepseek-v4-flash',
    input: 'delegate work',
    tools: [
      {
        type: 'namespace',
        name: 'multi_agent_v1',
        tools: [
          {
            type: 'function',
            name: 'send_input',
            parameters: {
              type: 'object',
              properties: {
                target: { type: 'string' },
                message: { type: 'string' },
              },
              required: ['target'],
              additionalProperties: false,
            },
          },
        ],
      },
    ],
  });
  const mapper = new ResponsesStreamMapper({
    responseId: 'resp_stream',
    model: 'deepseek-v4-flash',
    normalized,
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
                  id: 'call_send',
                  type: 'function',
                  function: {
                    name: 'multi_agent_v1__send_input',
                    arguments: '{"target":"agent_1"',
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
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  function: {
                    arguments: ',"message":"continue"}',
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
  const outputDone = events.find((event) => event.type === 'response.output_item.done' && event.item.type === 'function_call');
  assert.equal(outputDone.item.namespace, 'multi_agent_v1');
  assert.equal(outputDone.item.name, 'send_input');
  assert.equal(outputDone.item.arguments, '{"target":"agent_1","message":"continue"}');
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
