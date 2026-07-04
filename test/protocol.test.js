import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assistantMessageFromResponseOutput,
  convertChatCompletionToResponses,
  expandParallelToolCalls,
  isParallelToolWrapperName,
  normalizeResponsesRequest,
  resolveEmittedToolName,
  ResponsesStreamMapper,
  serializeResponsesSseEvent,
  toChatCompletionsRequest,
  toProviderChatCompletionsRequest,
  unavailableWebSearchToolShims,
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

test('keeps developer role in generic chat requests and downgrades it only for DeepSeek', () => {
  const chat = toChatCompletionsRequest(normalizeResponsesRequest({
    model: 'codex-model',
    instructions: 'system rules',
    input: [
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'dev rules' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
    ],
  }));
  assert.equal(chat.messages[0].role, 'system');
  assert.equal(chat.messages[1].role, 'developer');

  const request = toProviderChatCompletionsRequest(chat, {
    upstreamProvider: 'deepseek',
    upstreamModel: 'deepseek-v4-flash',
  });
  assert.equal(request.messages[0].role, 'system');
  assert.equal(request.messages[1].role, 'user');
  assert.match(request.messages[0].content, /System instructions \(highest priority\):\nsystem rules/);
  assert.match(request.messages[0].content, /Developer instructions \(priority below system\):\ndev rules/);
  assert.equal(request.messages[0].content.indexOf('system rules') < request.messages[0].content.indexOf('dev rules'), true);
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

test('preserves Codex local and namespaced tools through the DeepSeek provider request', () => {
  const normalized = normalizeResponsesRequest({
    model: 'deepseek-v4-flash',
    input: 'inspect repo',
    stream: true,
    tools: [
      {
        type: 'function',
        name: 'shell_command',
        description: 'Run a shell command',
        parameters: {
          type: 'object',
          properties: { command: { type: 'string' } },
          required: ['command'],
          additionalProperties: false,
        },
      },
      {
        type: 'function',
        name: 'update_plan',
        description: 'Update the task plan',
        parameters: {
          type: 'object',
          properties: { plan: { type: 'array', items: { type: 'object' } } },
          required: ['plan'],
          additionalProperties: false,
        },
      },
      {
        type: 'custom',
        name: 'apply_patch',
        description: 'Apply a patch',
        input_schema: {
          type: 'object',
          properties: { input: { type: 'string' } },
          required: ['input'],
          additionalProperties: false,
        },
      },
      {
        type: 'namespace',
        name: 'multi_tool_use',
        tools: [
          {
            type: 'function',
            name: 'parallel',
            description: 'Run multiple tools in parallel',
            parameters: {
              type: 'object',
              properties: { tool_uses: { type: 'array', items: { type: 'object' } } },
              required: ['tool_uses'],
              additionalProperties: false,
            },
          },
        ],
      },
      {
        type: 'namespace',
        name: 'mcp__context7',
        tools: [
          {
            type: 'function',
            name: 'query_docs',
            description: 'Query library docs',
            parameters: {
              type: 'object',
              properties: {
                libraryId: { type: 'string' },
                query: { type: 'string' },
              },
              required: ['libraryId', 'query'],
              additionalProperties: false,
            },
          },
        ],
      },
    ],
  });
  const chat = toChatCompletionsRequest(normalized);
  assert.deepEqual(chat.tools.map((tool) => tool.function.name), [
    'shell_command',
    'update_plan',
    'apply_patch',
    'multi_tool_use__parallel',
    'mcp__context7__query_docs',
  ]);

  const request = toProviderChatCompletionsRequest(chat, { upstreamProvider: 'deepseek' });
  assert.deepEqual(request.tools.map((tool) => tool.function.name), [
    'shell_command',
    'update_plan',
    'apply_patch',
    'multi_tool_use__parallel',
    'mcp__context7__query_docs',
    'commentary',
  ]);
  assert.match(request.messages[0].content, /real callable functions available now/);

  const response = convertChatCompletionToResponses({
    responseId: 'resp_multi_tool_use',
    model: 'deepseek-v4-flash',
    previousResponseId: null,
    normalized,
    completion: {
      id: 'chatcmpl_multi_tool_use',
      created: 1000,
      choices: [
        {
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'call_parallel',
                type: 'function',
                function: {
                  name: 'multi_tool_use__parallel',
                  arguments: '{"tool_uses":[]}',
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
  assert.equal(toolCall.namespace, 'multi_tool_use');
  assert.equal(toolCall.name, 'parallel');
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

test('keeps native tool_search calls in assistant history messages', () => {
  const assistant = assistantMessageFromResponseOutput([
    {
      type: 'tool_search_call',
      id: 'tsc_1',
      call_id: 'call_search',
      status: 'completed',
      execution: 'client',
      arguments: { query: 'multi_agent_v1', limit: 5 },
    },
  ]);
  assert.deepEqual(assistant.tool_calls, [
    {
      id: 'call_search',
      type: 'function',
      function: {
        name: 'tool_search',
        arguments: '{"query":"multi_agent_v1","limit":5}',
      },
    },
  ]);
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
                description: 'Spawn a sub-agent for a well-scoped task. The model should receive this short contract.',
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
  assert.equal(chat.messages.some((message) => Array.isArray(message.tool_calls)), true);
  assert.equal(chat.messages.some((message) => message.role === 'tool'), true);
  assert.equal(chat.messages[0].tool_calls[0].function.name, 'tool_search');
  assert.match(chat.messages[1].content, /multi_agent_v1__spawn_agent/);
  assert.match(chat.messages[1].content, /loaded into the current tool list/);
  assert.match(chat.messages[1].content, /"required":\["message"\]/);
  assert.match(chat.messages[1].content, /"properties":\["message","model","reasoning_effort"\]/);
  assert.match(chat.messages[1].content, /short contract/);
  assert.doesNotMatch(chat.messages[1].content, /"additionalProperties"/);
});

test('deduplicates repeated tool_search_output discoveries across turns', () => {
  const namespaceGroup = {
    type: 'namespace',
    name: 'multi_agent_v1',
    tools: [
      {
        type: 'function',
        name: 'spawn_agent',
        description: 'Spawn a sub-agent.',
        defer_loading: true,
        parameters: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },
      },
    ],
  };
  const normalized = normalizeResponsesRequest({
    model: 'deepseek-v4-flash',
    input: [
      { type: 'tool_search_call', id: 'tsc_1', call_id: 'call_a', status: 'completed', arguments: { query: 'agents' } },
      { type: 'tool_search_output', call_id: 'call_a', status: 'completed', tools: [namespaceGroup] },
      { type: 'tool_search_call', id: 'tsc_2', call_id: 'call_b', status: 'completed', arguments: { query: 'sub agents' } },
      { type: 'tool_search_output', call_id: 'call_b', status: 'completed', tools: [namespaceGroup] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'go' }] },
    ],
    tools: [
      { type: 'function', name: 'shell_command', parameters: { type: 'object', properties: {} } },
    ],
  });
  assert.equal(normalized.tools.length, 2);
  const chat = toChatCompletionsRequest(normalized);
  assert.deepEqual(chat.tools.map((tool) => tool.function.name), ['shell_command', 'multi_agent_v1__spawn_agent']);
});

test('keeps defer_loading out of Chat function tools', () => {
  const normalized = normalizeResponsesRequest({
    model: 'deepseek-v4-flash',
    input: 'hello',
    tools: [
      {
        type: 'function',
        function: {
          name: 'deferred_nested',
          defer_loading: true,
          parameters: { type: 'object', properties: {} },
        },
      },
      {
        type: 'function',
        name: 'deferred_flat',
        defer_loading: true,
        parameters: { type: 'object', properties: {} },
      },
    ],
  });
  const chat = toChatCompletionsRequest(normalized);
  assert.deepEqual(chat.tools.map((tool) => tool.function.name), ['deferred_nested', 'deferred_flat']);
  for (const tool of chat.tools) {
    assert.equal('defer_loading' in tool.function, false);
  }
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

test('restores encoded ordinary tool names on Responses output', () => {
  const normalized = normalizeResponsesRequest({
    model: 'deepseek-v4-flash',
    input: 'apply',
    tools: [
      {
        type: 'function',
        name: 'apply.patch',
        parameters: { type: 'object', properties: { patch: { type: 'string' } } },
      },
    ],
  });
  const chat = toChatCompletionsRequest(normalized);
  const encodedName = chat.tools[0].function.name;
  assert.match(encodedName, /^apply_patch__[a-f0-9]{8}$/);
  const response = convertChatCompletionToResponses({
    responseId: 'resp_encoded_name',
    model: 'deepseek-v4-flash',
    normalized,
    completion: {
      choices: [
        {
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'call_patch',
                type: 'function',
                function: { name: encodedName, arguments: '{"patch":"*** Begin Patch"}' },
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
  assert.equal(toolCall.name, 'apply.patch');
});

test('keeps colliding sanitized tool names distinct and reversible', () => {
  const normalized = normalizeResponsesRequest({
    model: 'deepseek-v4-flash',
    input: 'call one',
    tools: [
      {
        type: 'function',
        name: 'apply.patch',
        parameters: { type: 'object', properties: { patch: { type: 'string' } } },
      },
      {
        type: 'function',
        name: 'apply_patch',
        parameters: { type: 'object', properties: { patch: { type: 'string' } } },
      },
    ],
  });
  const chat = toChatCompletionsRequest(normalized);
  const names = chat.tools.map((tool) => tool.function.name);
  assert.equal(names.length, 2);
  assert.equal(new Set(names).size, 2);
  assert.match(names[0], /^apply_patch__[a-f0-9]{8}$/);
  assert.equal(names[1], 'apply_patch');

  const response = convertChatCompletionToResponses({
    responseId: 'resp_collision_name',
    model: 'deepseek-v4-flash',
    normalized,
    completion: {
      choices: [
        {
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'call_patch_dotted',
                type: 'function',
                function: { name: names[0], arguments: '{"patch":"a"}' },
              },
              {
                id: 'call_patch_plain',
                type: 'function',
                function: { name: names[1], arguments: '{"patch":"b"}' },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    },
  });
  const calls = response.output.filter((item) => item.type === 'function_call');
  assert.deepEqual(calls.map((item) => item.name), ['apply.patch', 'apply_patch']);
});

test('does not rewrite ordinary bare spawn_agent tools as Codex sub-agent tools', () => {
  const normalized = normalizeResponsesRequest({
    model: 'deepseek-v4-flash',
    input: 'spawn business job',
    tools: [
      {
        type: 'function',
        name: 'spawn_agent',
        description: 'Create a business workflow agent.',
        parameters: {
          type: 'object',
          properties: {
            model: { type: 'string', enum: ['business-model'] },
            message: { type: 'string' },
          },
          required: ['message'],
        },
      },
    ],
  });
  const request = toProviderChatCompletionsRequest(toChatCompletionsRequest(normalized), {
    upstreamProvider: 'deepseek',
    modelAliases: DEFAULT_MODEL_ALIASES,
  });
  assert.match(request.tools[0].function.description, /business workflow agent/);
  assert.deepEqual(request.tools[0].function.parameters.properties.model.enum, ['business-model']);
});

test('converts Responses custom tools and shims unsupported hosted tools as unavailable functions', () => {
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
        type: 'file_search',
        name: 'search_files',
        parameters: { type: 'object', properties: { query: { type: 'string' } } },
      },
      {
        type: 'code_interpreter',
        name: 'python',
        input_schema: { type: 'object', properties: { code: { type: 'string' } } },
      },
      {
        type: 'image_generation',
        name: 'generate_image',
      },
      {
        type: 'computer_use',
        name: 'computer',
      },
      {
        type: 'web_search',
      },
    ],
  });
  const chat = toChatCompletionsRequest(normalized);
  assert.match(chat.tools[0].function.name, /^apply_patch__[a-f0-9]{8}$/);
  assert.equal(chat.tools[0].gateway_custom_tool, true);
  assert.match(chat.tools[0].function.description, /^Apply a patch/);
  assert.match(chat.tools[0].function.description, /"input" string argument/);
  assert.deepEqual(chat.tools[0].function.parameters.required, ['input']);
  assert.equal(chat.tools[0].function.parameters.properties.input.type, 'string');
  assert.equal(chat.tools[0].function.parameters.additionalProperties, false);

  const shims = chat.tools.slice(1);
  assert.deepEqual(
    shims.map((tool) => tool.function.name),
    ['local_shell', 'context7', 'search_files', 'python', 'generate_image', 'computer'],
  );
  for (const shim of shims) {
    assert.match(shim.function.description, /^Unavailable capability:/);
    assert.match(shim.function.description, /Do not call this tool/);
    assert.deepEqual(shim.function.parameters, { type: 'object', properties: {}, additionalProperties: false });
  }
  assert.equal(chat.tools.some((tool) => tool.function.name === 'web_search'), false);
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

test('keeps critical Codex tool contracts visible in DeepSeek-facing tools', () => {
  const normalized = normalizeResponsesRequest({
    model: 'deepseek-v4-flash',
    input: 'edit and research',
    tools: [
      {
        type: 'custom',
        name: 'apply_patch',
        description: [
          'Use the apply_patch tool to edit files. This is a FREEFORM tool.',
          'Input must obey the grammar: begin_patch, hunk, end_patch.',
          'Do not wrap the patch in JSON.',
        ].join(' '),
        input_schema: {
          type: 'object',
          properties: {
            input: {
              type: 'string',
              description: 'Patch text containing *** Begin Patch and *** End Patch.',
            },
          },
          required: ['input'],
          additionalProperties: false,
        },
      },
      {
        type: 'namespace',
        name: 'mcp__context7',
        tools: [
          {
            type: 'function',
            name: 'query_docs',
            description: 'Query documentation only after Resolve Context7 Library ID has selected a /org/project library id.',
            parameters: {
              type: 'object',
              properties: {
                libraryId: { type: 'string', description: 'Exact /org/project id from resolve-library-id.' },
                query: { type: 'string', description: 'Specific docs question.' },
              },
              required: ['libraryId', 'query'],
              additionalProperties: false,
            },
          },
        ],
      },
      {
        type: 'namespace',
        name: 'multi_agent_v1',
        tools: [
          {
            type: 'function',
            name: 'spawn_agent',
            description: 'Spawn a sub-agent for a well-scoped task. Do not spawn sub-agents unless explicitly asked for sub-agents, delegation, or parallel agent work.',
            parameters: {
              type: 'object',
              properties: {
                agent_type: { type: 'string' },
                message: { type: 'string' },
              },
              required: ['message'],
              additionalProperties: false,
            },
          },
        ],
      },
    ],
  });
  const request = toProviderChatCompletionsRequest(toChatCompletionsRequest(normalized), {
    upstreamProvider: 'deepseek',
    modelAliases: DEFAULT_MODEL_ALIASES,
  });
  const byName = new Map(request.tools.map((tool) => [tool.function.name, tool.function]));

  assert.match(byName.get('apply_patch').description, /FREEFORM/);
  assert.match(byName.get('apply_patch').description, /begin_patch/);
  assert.match(byName.get('apply_patch').description, /Do not wrap/);
  assert.deepEqual(byName.get('apply_patch').parameters.required, ['input']);
  assert.match(byName.get('apply_patch').parameters.properties.input.description, /Begin Patch/);

  assert.match(byName.get('mcp__context7__query_docs').description, /Resolve Context7 Library ID/);
  assert.match(byName.get('mcp__context7__query_docs').description, /\/org\/project/);
  assert.deepEqual(byName.get('mcp__context7__query_docs').parameters.required, ['libraryId', 'query']);

  assert.match(byName.get('multi_agent_v1__spawn_agent').description, /Codex-native sub-agent/);
  assert.match(byName.get('multi_agent_v1__spawn_agent').description, /inherit/);
  assert.match(byName.get('multi_agent_v1__spawn_agent').description, /Required: message/);
  assert.deepEqual(byName.get('multi_agent_v1__spawn_agent').parameters.required, ['message']);
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

test('omits tools and DeepSeek tool instructions when tool_choice disables tool calls', () => {
  const normalized = normalizeResponsesRequest({
    model: 'deepseek-v4-flash',
    input: 'answer directly',
    tools: [
      { type: 'function', name: 'lookup', parameters: { type: 'object', properties: {} } },
    ],
    tool_choice: 'none',
  });
  const chat = toChatCompletionsRequest(normalized);
  assert.equal(chat.tools, undefined);
  assert.equal(chat.tool_choice, 'none');

  const request = toProviderChatCompletionsRequest(chat, {
    upstreamProvider: 'deepseek',
    modelAliases: DEFAULT_MODEL_ALIASES,
  });
  assert.equal(request.tools, undefined);
  assert.equal(request.tool_choice, 'none');
  assert.equal(request.messages.some((message) => String(message.content || '').includes('real callable functions available now')), false);
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
  const encodedHistoryName = chat.messages[0].tool_calls[0].function.name;
  assert.deepEqual(chat.messages, [
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'call_custom',
          type: 'function',
          function: { name: encodedHistoryName, arguments: '{"input":"*** Begin Patch"}' },
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
  assert.match(encodedHistoryName, /^apply_patch__[a-f0-9]{8}$/);
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
  assert.deepEqual(chat.messages.map((message) => message.role), ['user', 'assistant', 'assistant', 'user']);
  const note = String(chat.messages[1].content);
  assert.match(note, /Earlier web activity/);
  assert.match(note, /gold futures price/);
  assert.match(note, /https:\/\/example\.com\/gold/);
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

test('adds empty DeepSeek reasoning_content only on assistant tool-call history when thinking is enabled', () => {
  const request = toProviderChatCompletionsRequest(
    {
      model: 'deepseek-v4-pro',
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'call_lookup',
              type: 'function',
              function: { name: 'lookup', arguments: '{"q":"x"}' },
            },
          ],
        },
        { role: 'user', content: 'review' },
      ],
      reasoning: { effort: 'high' },
    },
    { upstreamProvider: 'deepseek', modelAliases: DEFAULT_MODEL_ALIASES },
  );
  assert.equal(request.thinking.type, 'enabled');
  assert.equal('reasoning_content' in request.messages[1], false);
  assert.equal(request.messages[2].reasoning_content, '');
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
        summary: [{ type: 'summary_text', text: 'raw thinking' }],
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
        summary: [{ type: 'summary_text', text: 'summary fallback' }],
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

test('does not pass unsupported DeepSeek reasoning efforts through', () => {
  for (const effort of ['minimal', 'foo']) {
    const request = toProviderChatCompletionsRequest(
      {
        model: 'deepseek-v4-pro',
        messages: [{ role: 'user', content: 'ping' }],
        reasoning: { effort },
      },
      { upstreamProvider: 'deepseek', modelAliases: DEFAULT_MODEL_ALIASES },
    );
    assert.deepEqual(request.thinking, { type: 'enabled' });
    assert.equal('reasoning_effort' in request, false);
  }

  const falseNoThinking = toProviderChatCompletionsRequest(
    {
      model: 'deepseek-v4-pro',
      messages: [{ role: 'user', content: 'ping' }],
      reasoning: { effort: 'false' },
    },
    { upstreamProvider: 'deepseek', modelAliases: DEFAULT_MODEL_ALIASES },
  );
  assert.deepEqual(falseNoThinking.thinking, { type: 'disabled' });
  assert.equal('reasoning_effort' in falseNoThinking, false);

  const explicitThinkingAlias = toProviderChatCompletionsRequest(
    {
      model: 'deepseek-v4-pro',
      messages: [{ role: 'user', content: 'ping' }],
      reasoning: { effort: 'minimal' },
    },
    {
      upstreamProvider: 'deepseek',
      modelAliases: {
        'deepseek-v4-pro': { model: 'deepseek-v4-pro', thinking: 'enabled' },
      },
    },
  );
  assert.deepEqual(explicitThinkingAlias.thinking, { type: 'enabled' });
  assert.equal('reasoning_effort' in explicitThinkingAlias, false);
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
  assert.deepEqual(response.output[0].content, []);
  assert.equal(response.output[0].reasoning_content, 'reasoning trace');
  assert.match(response.output[0].encrypted_content, /^dsgw1:/);
  assert.equal(
    Buffer.from(response.output[0].encrypted_content.slice('dsgw1:'.length), 'base64').toString('utf8'),
    'reasoning trace',
  );
  assert.equal(assistantMessageFromResponseOutput(response.output).reasoning_content, 'reasoning trace');
});

test('prefixes the summary display with the Reasoning header and cleans model markdown', () => {
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
  assert.equal(
    response.output[0].summary[0].text,
    '**Reasoning**\n\nFirst thought.\n\nReasoning\n\nThe upstream model emitted this word itself.',
  );
  assert.deepEqual(response.output[0].content, []);
  assert.equal(response.output[0].reasoning_content, reasoningText);
  assert.equal(assistantMessageFromResponseOutput(response.output).reasoning_content, reasoningText);
});

test('cleans the summary display while keeping raw reasoning history markdown intact', () => {
  const reasoningText = '## Plan\n\n*First point*\n\n- **Inspect** files\n\n1. _Report_ findings';
  const displayText = '**Reasoning**\n\nPlan\n\nFirst point\n\n• Inspect files\n\n1) Report findings';
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

test('flattens numbered and bulleted reasoning into plain summary lines', () => {
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
      '**Reasoning**',
      '',
      'From the search results:',
      '',
      '1) Reddit user feedback on V4 creative writing (r/DeepSeek):',
      '• The snippet says: "It relies heavily on abstract emotions."',
      '',
      '• Keep bullet emphasis unchanged.',
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
  assert.equal(response.output[0].summary[0].text, '**Reasoning**\n\n1) Inspect\n2) Answer');
  assert.deepEqual(response.output[0].content, []);
  assert.equal(response.output[0].reasoning_content, '1. Inspect\n2. Answer');
});

test('does not create empty assistant messages for tool-only chat completions', () => {
  const normalized = normalizeResponsesRequest({
    model: 'deepseek-v4-flash',
    input: 'find tools',
    tools: [
      {
        type: 'tool_search',
        execution: 'client',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
        },
      },
    ],
  });
  const response = convertChatCompletionToResponses({
    responseId: 'resp_tool_only',
    model: 'deepseek-v4-flash',
    previousResponseId: null,
    normalized,
    completion: {
      id: 'chatcmpl_tool_only',
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
                  arguments: '{"query":"multi_tool_use.parallel"}',
                },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    },
  });

  assert.equal(response.output.some((item) => item.type === 'message'), false);
  assert.equal(response.output.length, 1);
  assert.equal(response.output[0].type, 'tool_search_call');
  assert.deepEqual(response.output[0].arguments, { query: 'multi_tool_use.parallel' });
});

test('marks assistant content that accompanies tool calls as commentary', () => {
  const normalized = normalizeResponsesRequest({
    model: 'deepseek-v4-flash',
    input: 'find tools',
    tools: [
      {
        type: 'tool_search',
        execution: 'client',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
        },
      },
    ],
  });
  const response = convertChatCompletionToResponses({
    responseId: 'resp_text_and_tool',
    model: 'deepseek-v4-flash',
    previousResponseId: null,
    normalized,
    completion: {
      id: 'chatcmpl_text_and_tool',
      created: 1000,
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'I will check the deferred tools first.',
            tool_calls: [
              {
                id: 'call_search',
                type: 'function',
                function: {
                  name: 'tool_search',
                  arguments: '{"query":"multi_tool_use.parallel"}',
                },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    },
  });

  const message = response.output.find((item) => item.type === 'message');
  assert.equal(message.phase, 'commentary');
  assert.equal(response.output_text, '');
  assert.equal(response.output.some((item) => item.type === 'tool_search_call'), true);
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
    ...mapper.mapChatEvent({ done: true }),
  ];
  assert.equal(events.some((event) => event.type === 'response.reasoning_text.delta'), false);
  assert.equal(events.some((event) => event.type === 'response.reasoning_text.done'), false);
  assert.equal(events.at(-1).response.output[0].summary[0].text, '**Reasoning**\n\n1) Inspect');
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
    ...mapper.mapChatEvent({ done: true }),
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
  assert.deepEqual(events.at(-1).response.output[0].content, []);
  assert.match(events.at(-1).response.output[0].encrypted_content, /^dsgw1:/);
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
    ...mapper.mapChatEvent({ done: true }),
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

test('flushes late reasoning as a trailing summary after visible output completes', () => {
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
    ...mapper.mapChatEvent({ done: true }),
  ];
  const summaryDeltas = events.filter((event) => event.type === 'response.reasoning_summary_text.delta');
  assert.equal(summaryDeltas.map((event) => event.delta).join(''), '**Reasoning**\n\nInspecting hidden tail');
  const lateReasoningAddedIndex = events.findIndex((event) => event.type === 'response.output_item.added' && event.item.type === 'reasoning');
  const firstSummaryDeltaIndex = events.findIndex((event) => event.type === 'response.reasoning_summary_text.delta');
  assert.ok(lateReasoningAddedIndex !== -1 && lateReasoningAddedIndex < firstSummaryDeltaIndex);
  const messageDoneIndex = events.findIndex((event) => event.type === 'response.output_item.done' && event.item.type === 'message');
  const reasoningDoneIndex = events.findIndex((event) => event.type === 'response.output_item.done' && event.item.type === 'reasoning');
  assert.notEqual(messageDoneIndex, -1);
  assert.notEqual(reasoningDoneIndex, -1);
  assert.ok(messageDoneIndex < reasoningDoneIndex);
  assert.equal(events.at(-1).response.output[1].summary[0].text, '**Reasoning**\n\nInspecting hidden tail');
  assert.deepEqual(events.at(-1).response.output[1].content, []);
  assert.equal(events.at(-1).response.output[1].reasoning_content, '**Inspecting** hidden tail');
});

test('streams reasoning ahead of the final answer in thinking mode', () => {
  const mapper = new ResponsesStreamMapper({
    responseId: 'resp_stream',
    model: 'deepseek-v4-flash',
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
    ...mapper.mapChatEvent({ done: true }),
  ];
  assert.equal(events.some((event) => event.type === 'response.output_text.delta'), true);
  const reasoningDoneIndex = events.findIndex((event) => event.type === 'response.output_item.done' && event.item.type === 'reasoning');
  const messageAddedIndex = events.findIndex((event) => event.type === 'response.output_item.added' && event.item.type === 'message');
  assert.notEqual(reasoningDoneIndex, -1);
  assert.notEqual(messageAddedIndex, -1);
  assert.ok(reasoningDoneIndex < messageAddedIndex);
  assert.equal(events.at(-1).response.output[0].summary[0].text, '**Reasoning**\n\nPlan gather facts. Let me compile the report now.');
  assert.deepEqual(events.at(-1).response.output[0].content, []);
  assert.equal(events.at(-1).response.output_text, 'Now I have enough context. I will write the report.');
  assert.equal(mapper.assistantMessage().reasoning_content, '**Plan** gather facts. Let me compile the report now.');
});

test('streams summary reasoning in one part with ordered deltas before final answer', () => {
  const reasoningText = [
    'Opening line one.\nOpening line two.',
    'A'.repeat(1300),
    'Closing line.',
  ].join('\n\n');
  const mapper = new ResponsesStreamMapper({
    responseId: 'resp_stream',
    model: 'deepseek-v4-flash',
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
    ...mapper.mapChatEvent({ done: true }),
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
  assert.equal(summaryDeltaEvents[0].delta.startsWith('**Reasoning**\n\nOpening line one.'), true);
  assert.equal(summaryDeltaEvents.map((event) => event.delta).join(''), `**Reasoning**\n\n${reasoningText}`);
  assert.equal(summaryDoneEvents.length, 1);
  assert.equal(summaryDoneEvents[0].text, `**Reasoning**\n\n${reasoningText}`);
  assert.equal(finalSummaryText, `**Reasoning**\n\n${reasoningText}`);
  assert.notEqual(reasoningDoneIndex, -1);
  assert.notEqual(messageAddedIndex, -1);
  assert.ok(reasoningDoneIndex < messageAddedIndex);
});

test('flushes markdown-heavy reasoning summary completely before numbered list content', () => {
  const reasoningText = [
    '### Reasoning Trace',
    '',
    '**Goal**: inspect the current implementation.',
    '',
    'Before the numbered list, keep this context visible.',
    '',
    '1. Check the stream reducer.',
    '2. Emit the full summary once.',
  ].join('\n');
  const displayText = [
    '**Reasoning**',
    '',
    'Reasoning Trace',
    '',
    'Goal: inspect the current implementation.',
    '',
    'Before the numbered list, keep this context visible.',
    '',
    '1) Check the stream reducer.',
    '2) Emit the full summary once.',
  ].join('\n');
  const mapper = new ResponsesStreamMapper({
    responseId: 'resp_stream',
    model: 'deepseek-v4-flash',
  });
  const events = [
    ...mapper.mapChatEvent({
      data: JSON.stringify({
        choices: [{ delta: { reasoning_content: reasoningText.slice(0, 24) }, finish_reason: null }],
      }),
    }),
    ...mapper.mapChatEvent({
      data: JSON.stringify({
        choices: [{ delta: { reasoning_content: reasoningText.slice(24) }, finish_reason: null }],
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
    ...mapper.mapChatEvent({ done: true }),
  ];
  const summaryText = events
    .filter((event) => event.type === 'response.reasoning_summary_text.delta')
    .map((event) => event.delta)
    .join('');
  const firstSummaryDeltaIndex = events.findIndex((event) => event.type === 'response.reasoning_summary_text.delta');
  const firstOutputTextDeltaIndex = events.findIndex((event) => event.type === 'response.output_text.delta');

  assert.equal(summaryText, displayText);
  assert.ok(firstSummaryDeltaIndex !== -1 && firstOutputTextDeltaIndex !== -1);
  assert.ok(firstSummaryDeltaIndex < firstOutputTextDeltaIndex);
  assert.equal(events.at(-1).response.output[0].summary[0].text, displayText);
  assert.equal(events.at(-1).response.output[0].reasoning_content, reasoningText);
});

test('closes the reasoning summary at first visible output and keeps late reasoning in raw history', () => {
  const mapper = new ResponsesStreamMapper({
    responseId: 'resp_stream',
    model: 'deepseek-v4-flash',
  });
  const events = [
    ...mapper.mapChatEvent({
      data: JSON.stringify({
        choices: [{ delta: { reasoning_content: 'First thought. ' }, finish_reason: null }],
      }),
    }),
    ...mapper.mapChatEvent({
      data: JSON.stringify({
        choices: [{ delta: { content: 'final answer' }, finish_reason: null }],
      }),
    }),
    ...mapper.mapChatEvent({
      data: JSON.stringify({
        choices: [{ delta: { reasoning_content: 'Second thought.' }, finish_reason: null }],
      }),
    }),
    ...mapper.mapChatEvent({
      data: JSON.stringify({
        choices: [{ delta: {}, finish_reason: 'stop' }],
      }),
    }),
    ...mapper.mapChatEvent({ done: true }),
  ];
  const summaryDeltaEvents = events.filter((event) => event.type === 'response.reasoning_summary_text.delta');
  const reasoningDoneIndex = events.findIndex((event) => event.type === 'response.output_item.done' && event.item.type === 'reasoning');
  const messageAddedIndex = events.findIndex((event) => event.type === 'response.output_item.added' && event.item.type === 'message');

  assert.equal(summaryDeltaEvents.map((event) => event.delta).join(''), '**Reasoning**\n\nFirst thought.');
  assert.equal(summaryDeltaEvents.length, 1);
  assert.notEqual(reasoningDoneIndex, -1);
  assert.notEqual(messageAddedIndex, -1);
  assert.ok(reasoningDoneIndex < messageAddedIndex);
  assert.equal(events.at(-1).response.output[0].type, 'reasoning');
  assert.equal(events.at(-1).response.output[1].type, 'message');
  assert.equal(events.at(-1).response.output[0].reasoning_content, 'First thought. Second thought.');
});

test('streams visible output live and flushes reasoning that arrives after it as a trailing summary', () => {
  const mapper = new ResponsesStreamMapper({
    responseId: 'resp_stream',
    model: 'deepseek-v4-flash',
  });
  const events = [
    ...mapper.mapChatEvent({
      data: JSON.stringify({
        choices: [{ delta: { content: 'final answer' }, finish_reason: null }],
      }),
    }),
    ...mapper.mapChatEvent({
      data: JSON.stringify({
        choices: [{ delta: { reasoning_content: 'late thought' }, finish_reason: null }],
      }),
    }),
    ...mapper.mapChatEvent({
      data: JSON.stringify({
        choices: [{ delta: {}, finish_reason: 'stop' }],
      }),
    }),
    ...mapper.mapChatEvent({ done: true }),
  ];
  const reasoningAdded = events.find((event) => event.type === 'response.output_item.added' && event.item.type === 'reasoning');
  const messageAdded = events.find((event) => event.type === 'response.output_item.added' && event.item.type === 'message');
  const firstTextDeltaIndex = events.findIndex((event) => event.type === 'response.output_text.delta');
  const reasoningAddedIndex = events.findIndex((event) => event.type === 'response.output_item.added' && event.item.type === 'reasoning');
  const summaryText = events
    .filter((event) => event.type === 'response.reasoning_summary_text.delta')
    .map((event) => event.delta)
    .join('');

  assert.equal(summaryText, '**Reasoning**\n\nlate thought');
  assert.equal(messageAdded.output_index, 0);
  assert.equal(reasoningAdded.output_index, 1);
  assert.ok(firstTextDeltaIndex !== -1 && firstTextDeltaIndex < reasoningAddedIndex);
  assert.equal(events.at(-1).response.output[0].type, 'message');
  assert.equal(events.at(-1).response.output[1].type, 'reasoning');
  assert.equal(events.at(-1).response.output[1].reasoning_content, 'late thought');
});

test('closes the reasoning summary and streams visible output live at the first content delta', () => {
  const mapper = new ResponsesStreamMapper({
    responseId: 'resp_stream',
    model: 'deepseek-v4-flash',
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
  const finished = mapper.mapChatEvent({ done: true });
  const events = [...first, ...second, ...done, ...finished];
  assert.equal(first.some((event) => event.type === 'response.output_item.added' && event.item.type === 'reasoning'), true);
  assert.equal(first.some((event) => event.type === 'response.reasoning_summary_part.added'), true);
  assert.equal(first.some((event) => event.type === 'response.output_text.delta'), false);
  assert.equal(second.some((event) => event.type === 'response.output_text.delta' && event.delta === 'final answer'), true);
  const summaryDeltaIndex = events.findIndex((event) => event.type === 'response.reasoning_summary_text.delta');
  const messageAddedIndex = events.findIndex((event) => event.type === 'response.output_item.added' && event.item.type === 'message');
  const reasoningDoneIndex = events.findIndex((event) => event.type === 'response.output_item.done' && event.item.type === 'reasoning');
  const firstTextDeltaIndex = events.findIndex((event) => event.type === 'response.output_text.delta');
  assert.notEqual(summaryDeltaIndex, -1);
  assert.notEqual(messageAddedIndex, -1);
  assert.notEqual(reasoningDoneIndex, -1);
  assert.ok(summaryDeltaIndex < reasoningDoneIndex);
  assert.ok(reasoningDoneIndex < messageAddedIndex);
  assert.ok(messageAddedIndex < firstTextDeltaIndex);
  assert.equal(events.at(-1).response.output[0].summary[0].text, '**Reasoning**\n\nFirst thought.');
  assert.deepEqual(events.at(-1).response.output[0].content, []);
  assert.equal(events.at(-1).response.output_text, 'final answer');
});

test('streams normalized reasoning summary while keeping raw reasoning content', () => {
  const reasoningText = '## Plan\n\n*First point*\n\n- **Inspect** files\n\n1. _Report_ findings';
  const displayText = '**Reasoning**\n\nPlan\n\nFirst point\n\n• Inspect files\n\n1) Report findings';
  const mapper = new ResponsesStreamMapper({
    responseId: 'resp_stream',
    model: 'deepseek-v4-flash',
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
    ...mapper.mapChatEvent({ done: true }),
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

test('flushes raw reasoning completely before final answer', () => {
  const reasoningText = `Line 1
Line 2
${'A'.repeat(1400)}
Line 3`;
  const mapper = new ResponsesStreamMapper({
    responseId: 'resp_stream',
    model: 'deepseek-v4-flash',
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
    ...mapper.mapChatEvent({ done: true }),
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

test('normalizes stringified shell command arrays in schema-normalized tool calls', () => {
  const mapper = new ResponsesStreamMapper({
    responseId: 'resp_stream',
    model: 'deepseek-v4-flash',
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
    ...mapper.mapChatEvent({ done: true }),
  ];
  const done = events.find((event) => event.type === 'response.function_call_arguments.done');
  assert.equal(done.arguments, '{"command":["powershell.exe","-Command","Get-Content package.json"]}');
});

test('emits native tool_search calls without function argument events', () => {
  const mapper = new ResponsesStreamMapper({
    responseId: 'resp_stream',
    model: 'deepseek-v4-flash',
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
    ...mapper.mapChatEvent({ done: true }),
  ];
  const outputDone = events.find((event) => event.type === 'response.output_item.done' && event.item.type === 'tool_search_call');
  assert.equal(outputDone.item.call_id, 'call_search');
  assert.equal(outputDone.item.execution, 'client');
  assert.deepEqual(outputDone.item.arguments, { limit: 8, query: 'spawn agent' });
  assert.equal(events.some((event) => event.type === 'response.function_call_arguments.done'), false);
});

test('marks streamed assistant content before tool calls as commentary', () => {
  const mapper = new ResponsesStreamMapper({
    responseId: 'resp_stream',
    model: 'deepseek-v4-flash',
    config: { upstreamProvider: 'deepseek' },
    normalized: normalizeResponsesRequest({
      model: 'deepseek-v4-flash',
      input: 'find sub-agent tools',
      tools: [
        {
          type: 'tool_search',
          execution: 'client',
          parameters: {
            type: 'object',
            properties: { query: { type: 'string' } },
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
        choices: [{ delta: { content: 'I need to inspect the available tools first.' }, finish_reason: null }],
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
                  id: 'call_search',
                  type: 'function',
                  function: {
                    name: 'tool_search',
                    arguments: '{"query":"multi_tool_use.parallel"}',
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
    ...mapper.mapChatEvent({ done: true }),
  ];
  const messageAdded = events.find((event) => event.type === 'response.output_item.added' && event.item.type === 'message');
  const messageDone = events.find((event) => event.type === 'response.output_item.done' && event.item.type === 'message');
  const completed = events.find((event) => event.type === 'response.completed');
  assert.equal(messageAdded.item.phase, 'commentary');
  assert.equal(messageDone.item.phase, 'commentary');
  assert.equal(completed.response.output_text, '');
  assert.equal(events.some((event) => event.type === 'response.output_item.done' && event.item.type === 'tool_search_call'), true);
});

test('starts DeepSeek streamed text as commentary while tools are still possible', () => {
  const mapper = new ResponsesStreamMapper({
    responseId: 'resp_stream',
    model: 'deepseek-v4-flash',
    config: { upstreamProvider: 'deepseek' },
    normalized: normalizeResponsesRequest({
      model: 'deepseek-v4-flash',
      input: 'find sub-agent tools',
      tools: [
        {
          type: 'tool_search',
          execution: 'client',
          parameters: {
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query'],
          },
        },
      ],
    }),
  });
  const firstEvents = mapper.mapChatEvent({
    data: JSON.stringify({
      choices: [{ delta: { content: 'I will inspect the tools first.' }, finish_reason: null }],
    }),
  });
  assert.equal(
    firstEvents.some((event) => event.type === 'response.output_item.added' && event.item.type === 'message' && event.item.phase === 'commentary'),
    true,
  );
  assert.equal(
    firstEvents.some((event) => event.type === 'response.output_text.delta' && event.delta === 'I will inspect the tools first.'),
    true,
  );

  const events = [
    ...firstEvents,
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
                    arguments: '{"query":"multi_tool_use.parallel"}',
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
    ...mapper.mapChatEvent({ done: true }),
  ];
  const messageDone = events.find((event) => event.type === 'response.output_item.done' && event.item.type === 'message');
  const completed = events.find((event) => event.type === 'response.completed');
  const messageDoneIndex = events.findIndex((event) => event.type === 'response.output_item.done' && event.item.type === 'message');
  const toolAddedIndex = events.findIndex((event) => event.type === 'response.output_item.added' && event.item.type === 'tool_search_call');
  assert.equal(messageDone.item.phase, 'commentary');
  assert.ok(messageDoneIndex !== -1 && toolAddedIndex !== -1 && messageDoneIndex < toolAddedIndex);
  assert.equal(completed.response.output_text, '');
});

test('promotes DeepSeek streamed text to final answer when no tool call arrives', () => {
  const mapper = new ResponsesStreamMapper({
    responseId: 'resp_stream',
    model: 'deepseek-v4-flash',
    config: { upstreamProvider: 'deepseek' },
    normalized: normalizeResponsesRequest({
      model: 'deepseek-v4-flash',
      input: 'answer directly',
      tools: [
        {
          type: 'function',
          name: 'lookup',
          parameters: {
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query'],
          },
        },
      ],
    }),
  });
  const events = [
    ...mapper.mapChatEvent({
      data: JSON.stringify({
        choices: [{ delta: { content: 'direct answer' }, finish_reason: null }],
      }),
    }),
    ...mapper.mapChatEvent({
      data: JSON.stringify({
        choices: [{ delta: {}, finish_reason: 'stop' }],
      }),
    }),
    ...mapper.mapChatEvent({ done: true }),
  ];
  const messageAdded = events.find((event) => event.type === 'response.output_item.added' && event.item.type === 'message');
  const messageDone = events.find((event) => event.type === 'response.output_item.done' && event.item.type === 'message');
  const completed = events.find((event) => event.type === 'response.completed');
  assert.equal(messageAdded.item.phase, 'commentary');
  assert.equal(messageDone.item.phase, 'final_answer');
  assert.equal(events.some((event) => event.type === 'response.output_text.delta' && event.delta === 'direct answer'), true);
  assert.equal(completed.response.output_text, 'direct answer');
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
    ...mapper.mapChatEvent({ done: true }),
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
    ...mapper.mapChatEvent({ done: true }),
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
    ...mapper.mapChatEvent({ done: true }),
  ];
  const done = events.find((event) => event.type === 'response.function_call_arguments.done');
  const deltas = events
    .filter((event) => event.type === 'response.function_call_arguments.delta')
    .map((event) => event.delta)
    .join('');
  const outputDone = events.find((event) => event.type === 'response.output_item.done' && event.item.type === 'function_call');
  assert.equal(deltas, '{"command":["cmd","/c","echo hello"]}');
  assert.equal(done.arguments, '{"command":["cmd","/c","echo hello"]}');
  assert.equal(outputDone.item.arguments, '{"command":["cmd","/c","echo hello"]}');
});

test('delays streaming tool output item until tool name is known', () => {
  const mapper = new ResponsesStreamMapper({
    responseId: 'resp_stream',
    model: 'deepseek-v4-flash',
    normalized: normalizeResponsesRequest({
      model: 'deepseek-v4-flash',
      input: 'find tools',
      tools: [
        {
          type: 'tool_search',
          execution: 'client',
          parameters: {
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query'],
          },
        },
      ],
    }),
  });
  const firstEvents = mapper.mapChatEvent({
    data: JSON.stringify({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call_search',
                function: { arguments: '{"query":"multi_tool_use' },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    }),
  });
  assert.equal(firstEvents.some((event) => event.type === 'response.output_item.added'), false);

  const events = [
    ...firstEvents,
    ...mapper.mapChatEvent({
      data: JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  function: { name: 'tool_search', arguments: '.parallel"}' },
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
    ...mapper.mapChatEvent({ done: true }),
  ];
  const added = events.find((event) => event.type === 'response.output_item.added');
  const done = events.find((event) => event.type === 'response.output_item.done');
  assert.equal(added.item.type, 'tool_search_call');
  assert.equal(done.item.type, 'tool_search_call');
  assert.deepEqual(done.item.arguments, { query: 'multi_tool_use.parallel' });
});

test('normalizes stringified tool argument values according to schema', () => {
  const mapper = new ResponsesStreamMapper({
    responseId: 'resp_stream',
    model: 'deepseek-v4-flash',
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
    ...mapper.mapChatEvent({ done: true }),
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
  const events = [
    ...mapper.mapChatEvent({
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
    }),
    ...mapper.mapChatEvent({ done: true }),
  ];
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

test('bridges custom tools to an input shim and restores custom_tool_call on stream output', () => {
  const normalized = normalizeResponsesRequest({
    model: 'deepseek-v4-flash',
    input: 'edit the file',
    tools: [
      {
        type: 'custom',
        name: 'apply_patch',
        description: 'Edit files with a patch envelope.',
        format: { type: 'grammar', syntax: 'lark', definition: 'start: begin_patch hunk+ end_patch' },
      },
    ],
  });
  const chat = toChatCompletionsRequest(normalized);
  assert.equal(chat.tools.length, 1);
  assert.equal(chat.tools[0].function.name, 'apply_patch');
  assert.match(chat.tools[0].function.description, /Input syntax: lark\./);
  assert.match(chat.tools[0].function.description, /begin_patch hunk\+ end_patch/);
  assert.deepEqual(chat.tools[0].function.parameters.required, ['input']);

  const provider = toProviderChatCompletionsRequest(chat, {
    upstreamProvider: 'deepseek',
    modelAliases: DEFAULT_MODEL_ALIASES,
  });
  assert.equal('gateway_custom_tool' in provider.tools[0], false);
  assert.match(provider.tools[0].function.description, /begin_patch hunk\+ end_patch/);

  const mapper = new ResponsesStreamMapper({
    responseId: 'resp_custom',
    model: 'deepseek-v4-flash',
    normalized,
  });
  const patchText = '*** Begin Patch\n*** Update File: a.txt\n@@\n-old\n+new\n*** End Patch';
  const events = [
    ...mapper.mapChatEvent({
      data: JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_patch',
                  type: 'function',
                  function: { name: 'apply_patch', arguments: JSON.stringify({ input: patchText }) },
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
    ...mapper.mapChatEvent({ done: true }),
  ];
  assert.equal(events.some((event) => event.type === 'response.function_call_arguments.delta'), false);
  assert.equal(events.some((event) => event.type === 'response.function_call_arguments.done'), false);
  const done = events.find((event) => event.type === 'response.output_item.done' && event.item.type === 'custom_tool_call');
  assert.equal(done.item.call_id, 'call_patch');
  assert.equal(done.item.name, 'apply_patch');
  assert.equal(done.item.input, patchText);
  assert.equal('arguments' in done.item, false);
  const assistant = mapper.assistantMessage();
  assert.equal(assistant.tool_calls[0].function.name, 'apply_patch');
  assert.deepEqual(JSON.parse(assistant.tool_calls[0].function.arguments), { input: patchText });
});

test('restores custom_tool_call items from non-streaming completions and raw text arguments', () => {
  const normalized = normalizeResponsesRequest({
    model: 'deepseek-v4-flash',
    input: 'edit',
    tools: [{ type: 'custom', name: 'apply_patch', description: 'Edit files.' }],
  });
  const response = convertChatCompletionToResponses({
    completion: {
      created: 1000,
      choices: [
        {
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              { id: 'call_1', type: 'function', function: { name: 'apply_patch', arguments: '*** Begin Patch raw text' } },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    },
    model: 'deepseek-v4-flash',
    previousResponseId: null,
    normalized,
    responseId: 'resp_custom2',
  });
  const item = response.output.find((entry) => entry.type === 'custom_tool_call');
  assert.equal(item.call_id, 'call_1');
  assert.equal(item.input, '*** Begin Patch raw text');
});

test('restores raw reasoning from encrypted_content and merges commentary with tool calls on replay', () => {
  const encrypted = `dsgw1:${Buffer.from('raw chain of thought', 'utf8').toString('base64')}`;
  const normalized = normalizeResponsesRequest({
    model: 'deepseek-v4-flash',
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'do it' }] },
      {
        type: 'reasoning',
        summary: [{ type: 'summary_text', text: 'cleaned summary' }],
        content: [],
        encrypted_content: encrypted,
      },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Let me check.' }], phase: 'commentary' },
      { type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{"q":"x"}' },
      { type: 'function_call_output', call_id: 'call_1', output: '{"ok":true}' },
    ],
  });
  const chat = toChatCompletionsRequest(normalized);
  assert.deepEqual(chat.messages.map((message) => message.role), ['user', 'assistant', 'tool']);
  const assistant = chat.messages[1];
  assert.equal(assistant.content, 'Let me check.');
  assert.equal(assistant.tool_calls[0].id, 'call_1');
  assert.equal(assistant.reasoning_content, 'raw chain of thought');
});

test('drops empty replayed assistant shells and keeps reasoning with the tool call turn', () => {
  const normalized = normalizeResponsesRequest({
    model: 'deepseek-v4-flash',
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'go' }] },
      { type: 'reasoning', summary: [{ type: 'summary_text', text: 's' }], reasoning_content: 'thinking hard' },
      { type: 'message', role: 'assistant', content: [] },
      { type: 'function_call', call_id: 'call_9', name: 'lookup', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_9', output: 'ok' },
    ],
  });
  const chat = toChatCompletionsRequest(normalized);
  assert.deepEqual(chat.messages.map((message) => message.role), ['user', 'assistant', 'tool']);
  const assistant = chat.messages[1];
  assert.equal(assistant.content, '');
  assert.equal(assistant.reasoning_content, 'thinking hard');
  assert.equal(assistant.tool_calls.length, 1);
});

test('captures DeepSeek usage from the trailing empty-choices chunk before completing', () => {
  const mapper = new ResponsesStreamMapper({ responseId: 'resp_usage', model: 'deepseek-v4-flash' });
  const textEvents = mapper.mapChatEvent({
    data: JSON.stringify({ choices: [{ delta: { content: 'hi' }, finish_reason: null }] }),
  });
  const finishEvents = mapper.mapChatEvent({
    data: JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: null }),
  });
  const usageEvents = mapper.mapChatEvent({
    data: JSON.stringify({
      choices: [],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
        prompt_cache_hit_tokens: 64,
        prompt_cache_miss_tokens: 36,
      },
    }),
  });
  const doneEvents = mapper.mapChatEvent({ done: true });
  assert.equal(finishEvents.some((event) => event.type === 'response.completed'), false);
  assert.deepEqual(usageEvents, []);
  const completed = [...textEvents, ...finishEvents, ...usageEvents, ...doneEvents].find(
    (event) => event.type === 'response.completed',
  );
  assert.equal(completed.response.usage.input_tokens, 100);
  assert.equal(completed.response.usage.output_tokens, 20);
  assert.equal(completed.response.usage.total_tokens, 120);
  assert.equal(completed.response.usage.input_tokens_details.cached_tokens, 64);
});

test('fails the stream on bare upstream EOF without finish_reason', () => {
  const mapper = new ResponsesStreamMapper({ responseId: 'resp_eof', model: 'deepseek-v4-flash' });
  mapper.mapChatEvent({
    data: JSON.stringify({ choices: [{ delta: { content: 'partial' }, finish_reason: null }] }),
  });
  const events = mapper.mapChatEvent({ done: true, eof: true });
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'response.failed');
  assert.equal(events[0].response.status, 'failed');
  assert.match(events[0].response.error.message, /ended before completion/);
});

test('completes on EOF when a finish_reason was already seen', () => {
  const mapper = new ResponsesStreamMapper({ responseId: 'resp_eof2', model: 'deepseek-v4-flash' });
  mapper.mapChatEvent({
    data: JSON.stringify({ choices: [{ delta: { content: 'hi' }, finish_reason: null }] }),
  });
  mapper.mapChatEvent({
    data: JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
  });
  const events = mapper.mapChatEvent({ done: true, eof: true });
  assert.equal(events.at(-1).type, 'response.completed');
  assert.equal(events.at(-1).response.output_text, 'hi');
});

test('skips malformed SSE frames without failing the stream', () => {
  const mapper = new ResponsesStreamMapper({ responseId: 'resp_bad', model: 'deepseek-v4-flash' });
  assert.deepEqual(mapper.mapChatEvent({ data: '{not json' }), []);
  const events = [
    ...mapper.mapChatEvent({
      data: JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }),
    }),
    ...mapper.mapChatEvent({ done: true }),
  ];
  assert.equal(events.at(-1).type, 'response.completed');
  assert.equal(events.at(-1).response.output_text, 'ok');
});

test('always sends explicit thinking and a max_tokens default for DeepSeek', () => {
  const defaulted = toProviderChatCompletionsRequest(
    { model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'hi' }] },
    { upstreamProvider: 'deepseek', modelAliases: DEFAULT_MODEL_ALIASES },
  );
  assert.deepEqual(defaulted.thinking, { type: 'enabled' });
  assert.equal(defaulted.max_tokens, 65536);

  const configured = toProviderChatCompletionsRequest(
    { model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'hi' }] },
    { upstreamProvider: 'deepseek', modelAliases: DEFAULT_MODEL_ALIASES, upstreamMaxTokens: 32000 },
  );
  assert.equal(configured.max_tokens, 32000);

  const explicit = toProviderChatCompletionsRequest(
    { model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'hi' }], max_tokens: 512 },
    { upstreamProvider: 'deepseek', modelAliases: DEFAULT_MODEL_ALIASES },
  );
  assert.equal(explicit.max_tokens, 512);
});

test('downgrades json_schema with schema instructions containing the word json', () => {
  const request = toProviderChatCompletionsRequest(
    {
      model: 'deepseek-v4-flash',
      messages: [
        { role: 'system', content: 'base rules' },
        { role: 'user', content: 'answer' },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'result',
          schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
        },
      },
    },
    { upstreamProvider: 'deepseek', modelAliases: DEFAULT_MODEL_ALIASES },
  );
  assert.deepEqual(request.response_format, { type: 'json_object' });
  const system = request.messages[0];
  assert.equal(system.role, 'system');
  assert.match(String(system.content), /json object/i);
  assert.match(String(system.content), /"ok"/);
});

test('downgrades multimodal input parts to text placeholders for DeepSeek', () => {
  const normalized = normalizeResponsesRequest({
    model: 'deepseek-v4-flash',
    input: [
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'look at this' },
          { type: 'input_image', image_url: 'https://example.com/screen.png' },
          { type: 'input_file', filename: 'notes.pdf' },
        ],
      },
    ],
  });
  const request = toProviderChatCompletionsRequest(toChatCompletionsRequest(normalized), {
    upstreamProvider: 'deepseek',
    modelAliases: DEFAULT_MODEL_ALIASES,
  });
  const user = request.messages.find((message) => message.role === 'user');
  assert.equal(typeof user.content, 'string');
  assert.match(user.content, /look at this/);
  assert.match(user.content, /image omitted/);
  assert.match(user.content, /example\.com\/screen\.png/);
  assert.match(user.content, /file omitted/);
  assert.match(user.content, /notes\.pdf/);
  assert.equal(request.messages.some((message) => Array.isArray(message.content)), false);
});

test('strips strict from DeepSeek tools unless the beta base url is used', () => {
  const chatRequest = {
    model: 'deepseek-v4-flash',
    messages: [{ role: 'user', content: 'go' }],
    tools: [
      { type: 'function', function: { name: 'lookup', strict: true, parameters: { type: 'object', properties: {} } } },
    ],
  };
  const standard = toProviderChatCompletionsRequest(chatRequest, {
    upstreamProvider: 'deepseek',
    modelAliases: DEFAULT_MODEL_ALIASES,
    upstreamBaseUrl: 'https://api.deepseek.com',
  });
  assert.equal('strict' in standard.tools[0].function, false);
  const beta = toProviderChatCompletionsRequest(chatRequest, {
    upstreamProvider: 'deepseek',
    modelAliases: DEFAULT_MODEL_ALIASES,
    upstreamBaseUrl: 'https://api.deepseek.com/beta',
  });
  assert.equal(beta.tools[0].function.strict, true);
});

test('expands multi_tool_use.parallel wrapper calls into individual streamed tool items', () => {
  const mapper = new ResponsesStreamMapper({
    responseId: 'resp_stream',
    model: 'deepseek-v4-flash',
    config: { upstreamProvider: 'deepseek' },
    normalized: normalizeResponsesRequest({
      model: 'deepseek-v4-flash',
      input: 'read files',
      tools: [
        {
          type: 'function',
          name: 'shell_command',
          parameters: {
            type: 'object',
            properties: { command: { type: 'string' } },
            required: ['command'],
          },
        },
      ],
    }),
  });
  const wrapperArguments = JSON.stringify({
    tool_uses: [
      { recipient_name: 'functions.shell_command', parameters: { command: 'rg --files src' } },
      { recipient_name: 'functions.shell_command', parameters: { command: 'Get-Content package.json' } },
    ],
  });
  const events = [
    ...mapper.mapChatEvent({
      data: JSON.stringify({
        choices: [{
          delta: {
            reasoning_content: 'Reading both files in parallel.\n',
          },
          finish_reason: null,
        }],
      }),
    }),
    ...mapper.mapChatEvent({
      data: JSON.stringify({
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call_wrapper',
              type: 'function',
              function: { name: 'multi_tool_use.parallel', arguments: wrapperArguments.slice(0, 40) },
            }],
          },
          finish_reason: null,
        }],
      }),
    }),
    ...mapper.mapChatEvent({
      data: JSON.stringify({
        choices: [{
          delta: { tool_calls: [{ index: 0, function: { arguments: wrapperArguments.slice(40) } }] },
          finish_reason: null,
        }],
      }),
    }),
    ...mapper.mapChatEvent({
      data: JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
    }),
    ...mapper.mapChatEvent({ done: true }),
  ];
  const addedNames = events
    .filter((event) => event.type === 'response.output_item.added' && event.item.type === 'function_call')
    .map((event) => event.item.name);
  const doneItems = events
    .filter((event) => event.type === 'response.output_item.done' && event.item.type === 'function_call')
    .map((event) => event.item);
  assert.deepEqual(addedNames, ['shell_command', 'shell_command']);
  assert.equal(doneItems.length, 2);
  assert.equal(doneItems[0].arguments, '{"command":"rg --files src"}');
  assert.equal(doneItems[1].arguments, '{"command":"Get-Content package.json"}');
  assert.notEqual(doneItems[0].call_id, doneItems[1].call_id);
  assert.equal(events.some((event) => JSON.stringify(event).includes('multi_tool_use')), false);
  const reasoningDoneIndex = events.findIndex((event) => event.type === 'response.output_item.done' && event.item.type === 'reasoning');
  const firstToolAddedIndex = events.findIndex((event) => event.type === 'response.output_item.added' && event.item.type === 'function_call');
  assert.ok(reasoningDoneIndex !== -1 && reasoningDoneIndex < firstToolAddedIndex);
  const assistantMessage = mapper.assistantMessage();
  assert.equal(assistantMessage.tool_calls.length, 2);
  assert.equal(assistantMessage.tool_calls[0].function.name, 'shell_command');
});

test('passes malformed multi_tool_use.parallel arguments through unchanged', () => {
  const mapper = new ResponsesStreamMapper({
    responseId: 'resp_stream',
    model: 'deepseek-v4-flash',
    config: { upstreamProvider: 'deepseek' },
  });
  const events = [
    ...mapper.mapChatEvent({
      data: JSON.stringify({
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call_wrapper',
              type: 'function',
              function: { name: 'multi_tool_use.parallel', arguments: '{"tool_uses": "broken"' },
            }],
          },
          finish_reason: null,
        }],
      }),
    }),
    ...mapper.mapChatEvent({
      data: JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
    }),
    ...mapper.mapChatEvent({ done: true }),
  ];
  const doneItems = events
    .filter((event) => event.type === 'response.output_item.done' && event.item.type === 'function_call')
    .map((event) => event.item);
  assert.equal(doneItems.length, 1);
  assert.equal(doneItems[0].name, 'multi_tool_use.parallel');
  assert.equal(doneItems[0].call_id, 'call_wrapper');
});

test('expands multi_tool_use.parallel wrapper calls in non-streaming completions', () => {
  const payload = convertChatCompletionToResponses({
    completion: {
      choices: [{
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: 'call_wrapper',
            type: 'function',
            function: {
              name: 'multi_tool_use.parallel',
              arguments: JSON.stringify({
                tool_uses: [
                  { recipient_name: 'functions.shell_command', parameters: { command: 'rg --files' } },
                  { recipient_name: 'view_image', parameters: '{"path":"a.png"}' },
                ],
              }),
            },
          }],
        },
        finish_reason: 'tool_calls',
      }],
    },
    model: 'deepseek-v4-flash',
    normalized: normalizeResponsesRequest({ model: 'deepseek-v4-flash', input: 'go' }),
  });
  const calls = payload.output.filter((item) => item.type === 'function_call');
  assert.deepEqual(calls.map((item) => item.name), ['shell_command', 'view_image']);
  assert.equal(calls[0].arguments, '{"command":"rg --files"}');
  assert.equal(calls[1].arguments, '{"path":"a.png"}');
  assert.notEqual(calls[0].call_id, calls[1].call_id);
});

test('bridges commentary tool calls into visible commentary messages on the streaming path', () => {
  const normalized = normalizeResponsesRequest({
    model: 'deepseek-v4-flash',
    input: 'go',
    tools: [{ type: 'function', name: 'shell_command', parameters: { type: 'object', properties: {} } }],
  });
  const mapper = new ResponsesStreamMapper({ responseId: 'resp_comm', model: 'deepseek-v4-flash', normalized });
  const events = [
    ...mapper.mapChatEvent({
      data: JSON.stringify({ choices: [{ delta: { reasoning_content: 'thinking. ' }, finish_reason: null }] }),
    }),
    ...mapper.mapChatEvent({
      data: JSON.stringify({
        choices: [{
          delta: {
            tool_calls: [
              { index: 0, id: 'call_note', type: 'function', function: { name: 'commentary', arguments: '{"text":"Scanning the repo layout first."}' } },
              { index: 1, id: 'call_shell', type: 'function', function: { name: 'shell_command', arguments: '{"command":"ls"}' } },
            ],
          },
          finish_reason: null,
        }],
      }),
    }),
    ...mapper.mapChatEvent({ data: JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }) }),
    ...mapper.mapChatEvent({ done: true }),
  ];
  const final = events.at(-1).response;
  const commentaryMessage = final.output.find((item) => item.type === 'message' && item.phase === 'commentary');
  assert.equal(commentaryMessage.content[0].text, 'Scanning the repo layout first.');
  assert.equal(final.output.some((item) => item.type === 'function_call' && item.name === 'commentary'), false);
  assert.equal(final.output.some((item) => item.type === 'function_call' && item.name === 'shell_command'), true);
  assert.equal(final.output_text, '');
  const messageAddedIndex = events.findIndex((event) => event.type === 'response.output_item.added' && event.item?.type === 'message');
  const messageDeltaIndex = events.findIndex((event) => event.type === 'response.output_text.delta');
  const messageDoneIndex = events.findIndex((event) => event.type === 'response.output_item.done' && event.item?.type === 'message');
  assert.ok(messageAddedIndex !== -1 && messageAddedIndex < messageDeltaIndex && messageDeltaIndex < messageDoneIndex);
  assert.equal(events[messageDoneIndex].item.phase, 'commentary');
  const assistant = mapper.assistantMessage();
  assert.equal(assistant.content, 'Scanning the repo layout first.');
  assert.deepEqual(assistant.tool_calls.map((toolCall) => toolCall.function.name), ['shell_command']);
});

test('passes commentary calls through as function calls when the request defines its own commentary tool', () => {
  const normalized = normalizeResponsesRequest({
    model: 'deepseek-v4-flash',
    input: 'go',
    tools: [{ type: 'function', name: 'commentary', parameters: { type: 'object', properties: {} } }],
  });
  const mapper = new ResponsesStreamMapper({ responseId: 'resp_own', model: 'deepseek-v4-flash', normalized });
  const events = [
    ...mapper.mapChatEvent({
      data: JSON.stringify({
        choices: [{
          delta: {
            tool_calls: [{ index: 0, id: 'call_own', type: 'function', function: { name: 'commentary', arguments: '{"text":"hi"}' } }],
          },
          finish_reason: null,
        }],
      }),
    }),
    ...mapper.mapChatEvent({ data: JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }) }),
    ...mapper.mapChatEvent({ done: true }),
  ];
  const final = events.at(-1).response;
  assert.equal(final.output.some((item) => item.type === 'function_call' && item.name === 'commentary'), true);
  assert.equal(final.output.some((item) => item.type === 'message'), false);
});

test('injects the commentary tool and contract line for DeepSeek tool requests', () => {
  const request = toProviderChatCompletionsRequest(
    {
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'shell_command', parameters: { type: 'object', properties: {} } } }],
    },
    { upstreamProvider: 'deepseek', upstreamModel: 'deepseek-v4-flash' },
  );
  assert.deepEqual(request.tools.map((tool) => tool.function.name), ['shell_command', 'commentary']);
  assert.match(String(request.messages[0].content), /The user cannot see your thinking; commentary is the only progress they see between tool batches\./);

  const withOwnCommentary = toProviderChatCompletionsRequest(
    {
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'commentary', parameters: { type: 'object', properties: {} } } }],
    },
    { upstreamProvider: 'deepseek', upstreamModel: 'deepseek-v4-flash' },
  );
  assert.deepEqual(withOwnCommentary.tools.map((tool) => tool.function.name), ['commentary']);

  const withoutTools = toProviderChatCompletionsRequest(
    {
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'hi' }],
    },
    { upstreamProvider: 'deepseek', upstreamModel: 'deepseek-v4-flash' },
  );
  assert.equal(withoutTools.tools, undefined);
});

test('bridges commentary tool calls in non-streaming completions and drops empty updates', () => {
  const normalized = normalizeResponsesRequest({
    model: 'deepseek-v4-flash',
    input: 'go',
    tools: [{ type: 'function', name: 'shell_command', parameters: { type: 'object', properties: {} } }],
  });
  const payload = convertChatCompletionToResponses({
    completion: {
      id: 'chatcmpl_comm',
      created: 1000,
      choices: [{
        message: {
          role: 'assistant',
          content: '',
          reasoning_content: 'planning',
          tool_calls: [
            { id: 'call_note', type: 'function', function: { name: 'commentary', arguments: '{"text":"Now updating the config."}' } },
            { id: 'call_empty', type: 'function', function: { name: 'commentary', arguments: '{"text":"  "}' } },
            { id: 'call_shell', type: 'function', function: { name: 'shell_command', arguments: '{"command":"ls"}' } },
          ],
        },
        finish_reason: 'tool_calls',
      }],
    },
    model: 'deepseek-v4-flash',
    previousResponseId: null,
    normalized,
  });
  const messages = payload.output.filter((item) => item.type === 'message');
  assert.equal(messages.length, 1);
  assert.equal(messages[0].phase, 'commentary');
  assert.equal(messages[0].content[0].text, 'Now updating the config.');
  const calls = payload.output.filter((item) => item.type === 'function_call');
  assert.deepEqual(calls.map((item) => item.name), ['shell_command']);
  const assistant = assistantMessageFromResponseOutput(payload.output);
  assert.equal(assistant.content, 'Now updating the config.');
  assert.deepEqual(assistant.tool_calls.map((toolCall) => toolCall.function.name), ['shell_command']);
});

test('resolves emitted tool-call name variants to known chat tool names', () => {
  const known = ['shell_command', 'mcp__context7__query_docs', 'commentary'];
  assert.equal(resolveEmittedToolName('shell_command', known), 'shell_command');
  assert.equal(resolveEmittedToolName('functions.shell_command', known), 'shell_command');
  assert.equal(resolveEmittedToolName('mcp__context7.query_docs', known), 'mcp__context7__query_docs');
  assert.equal(resolveEmittedToolName('Shell_Command', known), 'shell_command');
  assert.equal(resolveEmittedToolName('functions.Commentary', known), 'commentary');
  assert.equal(resolveEmittedToolName('mystery_tool', known), 'mystery_tool');
  assert.equal(resolveEmittedToolName('functions.mystery_tool', known), 'functions.mystery_tool');
});

test('maps emitted name variants back to Codex tool identities in non-streaming conversion', () => {
  const normalized = normalizeResponsesRequest({
    model: 'deepseek-v4-flash',
    input: 'go',
    tools: [
      { type: 'function', name: 'shell_command', parameters: { type: 'object', properties: {} } },
      {
        type: 'namespace',
        name: 'multi_agent_v1',
        tools: [{ type: 'function', function: { name: 'spawn_agent', parameters: { type: 'object', properties: {} } } }],
      },
    ],
  });
  const payload = convertChatCompletionToResponses({
    completion: {
      id: 'chatcmpl_resolve',
      created: 1000,
      choices: [{
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [
            { id: 'call_a', type: 'function', function: { name: 'functions.shell_command', arguments: '{"command":"ls"}' } },
            { id: 'call_b', type: 'function', function: { name: 'multi_agent_v1.spawn_agent', arguments: '{}' } },
          ],
        },
        finish_reason: 'tool_calls',
      }],
    },
    model: 'deepseek-v4-flash',
    previousResponseId: null,
    normalized,
  });
  const calls = payload.output.filter((item) => item.type === 'function_call');
  assert.deepEqual(calls.map((item) => item.name), ['shell_command', 'spawn_agent']);
  assert.equal(calls[1].namespace, 'multi_agent_v1');
});

test('resolves emitted name variants in streaming tool calls', () => {
  const normalized = normalizeResponsesRequest({
    model: 'deepseek-v4-flash',
    input: 'go',
    tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object', properties: {} } }],
  });
  const mapper = new ResponsesStreamMapper({ responseId: 'resp_resolve', model: 'deepseek-v4-flash', normalized });
  const events = [
    ...mapper.mapChatEvent({
      data: JSON.stringify({
        choices: [{
          delta: {
            tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'functions.lookup', arguments: '{"q":"x"}' } }],
          },
          finish_reason: null,
        }],
      }),
    }),
    ...mapper.mapChatEvent({ data: JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }) }),
    ...mapper.mapChatEvent({ done: true }),
  ];
  const added = events.find((event) => event.type === 'response.output_item.added' && event.item.type === 'function_call');
  assert.equal(added.item.name, 'lookup');
  const doneItem = events
    .filter((event) => event.type === 'response.output_item.done')
    .find((event) => event.item.type === 'function_call');
  assert.equal(doneItem.item.name, 'lookup');
  assert.equal(doneItem.item.arguments, '{"q":"x"}');
});

test('expands parallel wrapper emissions with prefix and case variants', () => {
  assert.equal(isParallelToolWrapperName('functions.multi_tool_use.parallel'), true);
  assert.equal(isParallelToolWrapperName('Multi_Tool_Use_Parallel'), true);
  assert.equal(isParallelToolWrapperName('multi_tool_use.parallel2'), false);
  const expanded = expandParallelToolCalls([
    {
      id: 'call_w',
      type: 'function',
      function: {
        name: 'functions.multi_tool_use.parallel',
        arguments: JSON.stringify({ tool_uses: [{ recipient_name: 'functions.shell_command', parameters: { command: 'ls' } }] }),
      },
    },
  ]);
  assert.equal(expanded.length, 1);
  assert.equal(expanded[0].function.name, 'shell_command');
});

test('shims web search tools as unavailable functions when no provider is configured', () => {
  const shims = unavailableWebSearchToolShims([
    { type: 'web_search' },
    { type: 'web_search_preview' },
    { type: 'web_search' },
  ]);
  assert.deepEqual(shims.map((tool) => tool.function.name), ['web_search', 'web_search_preview']);
  assert.match(shims[0].function.description, /no search provider configured/);
  assert.match(shims[0].function.description, /Do not call this tool/);
});
