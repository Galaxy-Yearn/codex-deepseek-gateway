import assert from 'node:assert/strict';
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
  assistantMessageFromResponseOutput,
  convertChatCompletionToResponses,
  normalizeResponsesRequest,
  ResponsesStreamMapper,
  serializeResponsesSseEvent,
  toChatCompletionsRequest,
  toProviderChatCompletionsRequest,
  unavailableWebSearchToolShims,
} from '../src/protocol.js';
import {
  chatToolsIncludeApplyPatch,
  invalidApplyPatchToolCalls,
} from '../src/apply-patch-bridge.js';
import { SseParser } from '../src/common.js';
import { DEFAULT_MODEL_ALIASES } from '../src/model-map.js';
import { clearWebSearchEvidenceForTests, rememberWebSearchEvidence } from '../src/web-search-evidence.js';

test('Responses input and history normalization', async () => {
  await scenario('normalizes Responses input to chat completions messages', async () => {
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
  await scenario('keeps developer role in generic chat requests and downgrades it only for DeepSeek', async () => {
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
  await scenario('preserves Codex replay order while downgrading developer blocks in place for DeepSeek', async () => {
  const checkpoint = [
    'Another language model started to solve this problem and produced a summary of its thinking process.',
    '# Context Checkpoint',
  ].join('\n');
  const contextual = [
    '# AGENTS.md instructions for repo',
    '<INSTRUCTIONS>Use apply_patch for edits.</INSTRUCTIONS>',
    '<environment_context><cwd>/workspace</cwd></environment_context>',
  ].join('\n');
  const request = toProviderChatCompletionsRequest(toChatCompletionsRequest(normalizeResponsesRequest({
    model: 'deepseek-v4-flash',
    instructions: 'base rules',
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Earlier task.' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: checkpoint }] },
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'current permission rules' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: contextual }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Apply the requested change.' }] },
    ],
    tools: [{ type: 'function', name: 'shell_command', parameters: { type: 'object', properties: {} } }],
  })), {
    upstreamProvider: 'deepseek',
    upstreamModel: 'deepseek-v4-flash',
  });
  assert.deepEqual(request.messages.map((message) => message.role), ['system', 'user', 'user', 'system', 'user', 'user']);
  assert.equal(request.messages[1].content, 'Earlier task.');
  assert.equal(request.messages[2].content, checkpoint);
  assert.match(request.messages[3].content, /current permission rules/);
  assert.equal(request.messages[4].content, contextual);
  assert.equal(request.messages[5].content, 'Apply the requested change.');
  assert.match(request.messages[0].content, /real callable functions available now/);
  assert.match(request.messages[0].content, /A Codex context checkpoint is present in this request/);
  });
  await scenario('preserves Responses multimodal and file content for chat completions', async () => {
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
  await scenario('groups top-level Responses input content parts as a user message', async () => {
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
  await scenario('maps Responses tool call history to chat completions messages', async () => {
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
  await scenario('does not replay Responses web_search_call history as chat tool calls', async () => {
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
  await scenario('replays gateway-owned web evidence by web_search_call item id when sources are absent', async () => {
  clearWebSearchEvidenceForTests();
  try {
    rememberWebSearchEvidence('ws_cached', {
      action: 'search',
      query: 'gold futures price',
      results: [{
        title: 'Gold source',
        url: 'https://example.com/gold',
        snippet: 'Gold settled at a confirmed value today.',
      }],
    });
    const normalized = normalizeResponsesRequest({
      model: 'deepseek-v4-flash',
      input: [
        {
          type: 'web_search_call',
          id: 'ws_cached',
          status: 'completed',
          action: {
            type: 'search',
            query: 'gold futures price',
          },
        },
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'continue' }],
        },
      ],
    });
    const chat = toChatCompletionsRequest(normalized);
    const note = String(chat.messages[0].content);
    assert.match(note, /Earlier web activity/);
    assert.match(note, /Gold source/);
    assert.match(note, /https:\/\/example\.com\/gold/);
    assert.match(note, /confirmed value/);
  } finally {
    clearWebSearchEvidenceForTests();
  }
  });
  await scenario('replays native find-in-page patterns as descriptive history only', async () => {
  const normalized = normalizeResponsesRequest({
    input: [{
      type: 'web_search_call',
      id: 'ws_find',
      status: 'completed',
      action: {
        type: 'find_in_page',
        url: 'https://example.com/page',
        pattern: 'release date',
      },
    }],
  });
  const chat = toChatCompletionsRequest(normalized);
  assert.equal(chat.messages.length, 1);
  assert.equal(chat.messages[0].role, 'assistant');
  assert.match(String(chat.messages[0].content), /release date/);
  assert.equal(Array.isArray(chat.messages[0].tool_calls), false);
  });
});

test('tool schemas, namespaces, choices, and limits', async () => {
  await scenario('converts Responses function tools to chat completions tools', async () => {
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
  await scenario('preserves namespaced multi-agent tools through the Chat bridge', async () => {
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
  await scenario('preserves Codex local and namespaced tools through the DeepSeek provider request', async () => {
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
  await scenario('expands Codex namespace tool groups before sending Chat tools', async () => {
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
  await scenario('preserves schema-valid arguments for namespaced tools without tool-specific rewrites', async () => {
  const normalized = normalizeResponsesRequest({
    model: 'deepseek-v4-pro',
    input: 'delegate work',
    tools: [
      {
        type: 'namespace',
        name: 'workflow',
        tools: [
          {
            type: 'function',
            name: 'delegate_task',
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
    responseId: 'resp_namespaced_arguments',
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
                  name: 'workflow__delegate_task',
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
  assert.equal(toolCall.namespace, 'workflow');
  assert.equal(toolCall.name, 'delegate_task');
  assert.equal(toolCall.arguments, '{"message":"say hi","model":"gpt-5.4-mini","reasoning_effort":"low"}');
  });
  await scenario('does not split ordinary double-underscore tool names as namespaces', async () => {
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
  await scenario('restores encoded ordinary tool names on Responses output', async () => {
  const normalized = normalizeResponsesRequest({
    model: 'deepseek-v4-flash',
    input: 'generate report',
    tools: [
      {
        type: 'function',
        name: 'report.generate',
        parameters: { type: 'object', properties: { format: { type: 'string' } } },
      },
    ],
  });
  const chat = toChatCompletionsRequest(normalized);
  const encodedName = chat.tools[0].function.name;
  assert.match(encodedName, /^report_generate__[a-f0-9]{8}$/);
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
                id: 'call_report',
                type: 'function',
                function: { name: encodedName, arguments: '{"format":"markdown"}' },
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
  assert.equal(toolCall.name, 'report.generate');
  });
  await scenario('keeps colliding sanitized tool names distinct and reversible', async () => {
  const normalized = normalizeResponsesRequest({
    model: 'deepseek-v4-flash',
    input: 'call one',
    tools: [
      {
        type: 'function',
        name: 'data.lookup',
        parameters: { type: 'object', properties: { query: { type: 'string' } } },
      },
      {
        type: 'function',
        name: 'data_lookup',
        parameters: { type: 'object', properties: { query: { type: 'string' } } },
      },
    ],
  });
  const chat = toChatCompletionsRequest(normalized);
  const names = chat.tools.map((tool) => tool.function.name);
  assert.equal(names.length, 2);
  assert.equal(new Set(names).size, 2);
  assert.match(names[0], /^data_lookup__[a-f0-9]{8}$/);
  assert.equal(names[1], 'data_lookup');

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
                id: 'call_lookup_dotted',
                type: 'function',
                function: { name: names[0], arguments: '{"query":"a"}' },
              },
              {
                id: 'call_lookup_plain',
                type: 'function',
                function: { name: names[1], arguments: '{"query":"b"}' },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    },
  });
  const calls = response.output.filter((item) => item.type === 'function_call');
  assert.deepEqual(calls.map((item) => item.name), ['data.lookup', 'data_lookup']);
  });
  await scenario('preserves ordinary bare tools without namespace rewrites', async () => {
  const normalized = normalizeResponsesRequest({
    model: 'deepseek-v4-flash',
    input: 'delegate business job',
    tools: [
      {
        type: 'function',
        name: 'delegate_task',
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
  assert.equal(request.tools[0].function.name, 'delegate_task');
  assert.match(request.tools[0].function.description, /business workflow agent/);
  assert.deepEqual(request.tools[0].function.parameters.properties.model.enum, ['business-model']);
  });
  await scenario('converts Responses custom tools and shims unsupported hosted tools as unavailable functions', async () => {
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
  assert.match(chat.tools[0].function.description, /^Codex custom tool callable as a function/);
  assert.match(chat.tools[0].function.description, /Tool description: Apply a patch/);
  assert.deepEqual(chat.tools[0].function.parameters.required, ['input']);
  assert.equal(chat.tools[0].function.parameters.properties.input.type, 'string');
  assert.match(chat.tools[0].function.parameters.properties.input.description, /Complete raw input for the Codex custom tool/);
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
  await scenario('normalizes invalid tool parameter schemas for DeepSeek compatibility', async () => {
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
  await scenario('preserves long structured tool contracts and schemas without name-specific rewrites', async () => {
  const middleContract = 'MIDDLE_CONTRACT '.repeat(40);
  const tailContract = 'TAIL_CONTRACT must remain visible after provider adaptation.';
  const propertyTail = 'PROPERTY_TAIL must remain visible.';
  const normalized = normalizeResponsesRequest({
    model: 'deepseek-v4-flash',
    input: 'delegate',
    tools: [
      {
        type: 'namespace',
        name: 'workflow',
        tools: [
          {
            type: 'function',
            name: 'delegate_task',
            description: [
              'Delegate a task using the runtime contract below.',
              '',
              middleContract,
              '',
              tailContract,
            ].join('\n'),
            parameters: {
              type: 'object',
              properties: {
                message: {
                  type: 'string',
                  description: `${'Detailed input contract. '.repeat(30)}${propertyTail}`,
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
  assert.deepEqual(chat.tools[0].function.parameters.properties.model.enum, ['gpt-5.5']);
  assert.deepEqual(chat.tools[0].function.parameters.properties.reasoning_effort.enum, ['minimal', 'low', 'medium', 'high']);

  const request = toProviderChatCompletionsRequest(chat, { upstreamProvider: 'deepseek' });
  assert.match(request.messages[0].content, /real callable functions available now/);
  assert.match(request.messages[0].content, /tool_calls/);
  assert.match(request.messages[0].content, /including as XML, DSML, or JSON/);
  assert.equal(request.tools[0].function.name, 'workflow__delegate_task');
  assert.match(request.tools[0].function.description, /MIDDLE_CONTRACT/);
  assert.match(request.tools[0].function.description, /TAIL_CONTRACT/);
  assert.match(request.tools[0].function.description, /Required: message/);
  assert.match(request.tools[0].function.parameters.properties.message.description, /PROPERTY_TAIL/);
  assert.deepEqual(request.tools[0].function.parameters.properties.model.enum, ['gpt-5.5']);
  assert.deepEqual(request.tools[0].function.parameters.properties.reasoning_effort.enum, ['minimal', 'low', 'medium', 'high']);
  });
  await scenario('filters tools for Codex allowed_tools without forcing a call', async () => {
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
  await scenario('omits tools and DeepSeek tool instructions when tool_choice disables tool calls', async () => {
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
  await scenario('normalizes Responses tool choice and DeepSeek stream options', async () => {
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
  await scenario('preserves complete custom tool grammars without name-based augmentation', async () => {
  const grammar = `start: item+\n${'item: /[a-z]+/\n'.repeat(160)}end_marker: "GRAMMAR_TAIL"`;
  const chat = toChatCompletionsRequest(normalizeResponsesRequest({
    model: 'deepseek-v4-flash',
    input: 'patch something',
    tools: [
      {
        type: 'custom',
        name: 'grammar_tool',
        description: 'Accept grammar input',
        format: { type: 'grammar', syntax: 'lark', definition: grammar },
      },
      {
        type: 'custom',
        name: 'other_freeform',
        description: 'Another freeform tool',
        format: { type: 'grammar', syntax: 'lark', definition: grammar },
      },
    ],
  }));
  const grammarTool = chat.tools.find((tool) => tool.function.name === 'grammar_tool');
  const other = chat.tools.find((tool) => tool.function.name === 'other_freeform');
  assert.match(grammarTool.function.parameters.properties.input.description, /GRAMMAR_TAIL/);
  assert.match(other.function.parameters.properties.input.description, /GRAMMAR_TAIL/);
  assert.match(grammarTool.function.parameters.properties.input.description, /Input format: grammar\./);
  assert.match(grammarTool.function.parameters.properties.input.description, /Input syntax: lark\./);
  assert.match(grammarTool.function.parameters.properties.input.description, /Follow the declared format exactly/);
  assert.doesNotMatch(JSON.stringify(chat.tools), /line-oriented edit|anchor line|current source|unchanged source line/);
  assert.doesNotMatch(grammarTool.function.description, /Example input:/);
  assert.doesNotMatch(other.function.description, /Example input:/);
  });
  await scenario('enforces the DeepSeek 128-function limit after gateway tool injection', async () => {
  const tools = Array.from({ length: 127 }, (_, index) => ({
    type: 'function',
    name: `tool_${index}`,
    parameters: { type: 'object', properties: {} },
  }));
  const accepted = toProviderChatCompletionsRequest(toChatCompletionsRequest(normalizeResponsesRequest({
    model: 'deepseek-v4-flash',
    input: 'use tools',
    tools,
  })), { upstreamProvider: 'deepseek' });
  assert.equal(accepted.tools.length, 128);
  assert.equal(accepted.tools.at(-1).function.name, 'commentary');

  assert.throws(
    () => toProviderChatCompletionsRequest(toChatCompletionsRequest(normalizeResponsesRequest({
      model: 'deepseek-v4-flash',
      input: 'use tools',
      tools: [...tools, { type: 'function', name: 'tool_127', parameters: { type: 'object', properties: {} } }],
    })), { upstreamProvider: 'deepseek' }),
    (error) => error?.code === 'too_many_tools' && error?.statusCode === 400 && /received 129/.test(error.message),
  );
  });
});

test('deferred tool discovery and replay', async () => {
  await scenario('maps Codex tool_search calls back to native Responses items', async () => {
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
  await scenario('keeps native tool_search calls in assistant history messages', async () => {
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
  await scenario('loads tools returned by Codex tool_search_output on the next request', async () => {
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
  await scenario('deduplicates repeated tool_search_output discoveries across turns', async () => {
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
  await scenario('keeps defer_loading out of Chat function tools', async () => {
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
});

test('DeepSeek request, reasoning, and provider compatibility', async () => {
  await scenario('maps provider request for DeepSeek', async () => {
  const request = toProviderChatCompletionsRequest(
    {
      model: 'codex',
      messages: [{ role: 'developer', content: 'rules' }],
      stream: true,
      parallel_tool_calls: true,
      response_format: { type: 'json_schema', json_schema: { name: 'answer' } },
      user: 'codex-user',
      reasoning: { effort: 'max' },
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
  await scenario('preserves DeepSeek reasoning content in assistant history', async () => {
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
  await scenario('adds empty DeepSeek reasoning_content only on assistant tool-call history when thinking is enabled', async () => {
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
  await scenario('does not add DeepSeek reasoning_content when thinking is disabled', async () => {
  const request = toProviderChatCompletionsRequest(
    {
      model: 'deepseek-v4-pro',
      messages: [
        { role: 'assistant', content: 'hi' },
      ],
      reasoning: { effort: 'none' },
    },
    { upstreamProvider: 'deepseek', modelAliases: DEFAULT_MODEL_ALIASES },
  );
  assert.equal(request.thinking.type, 'disabled');
  assert.equal('reasoning_content' in request.messages[0], false);
  });
  await scenario('preserves Responses reasoning items next to tool calls for DeepSeek history', async () => {
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
  await scenario('does not feed reasoning summary display text back into DeepSeek history when raw reasoning exists', async () => {
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
  await scenario('does not use reasoning summary as DeepSeek history when raw reasoning text is absent', async () => {
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
  await scenario('uses native DeepSeek v4 reasoning levels and alias overrides', async () => {
  for (const model of ['deepseek-v4-flash', 'deepseek-v4-pro']) {
    const noThinking = toProviderChatCompletionsRequest(
      {
        model,
        messages: [{ role: 'user', content: 'ping' }],
        reasoning: { effort: 'none' },
      },
      { upstreamProvider: 'deepseek', modelAliases: DEFAULT_MODEL_ALIASES },
    );
    assert.equal(noThinking.model, model);
    assert.deepEqual(noThinking.thinking, { type: 'disabled' });
    assert.equal('reasoning_effort' in noThinking, false);
  }

  const fallbackEffort = toProviderChatCompletionsRequest(
    {
      model: 'deepseek-v4-pro',
      messages: [{ role: 'user', content: 'ping' }],
    },
    { upstreamProvider: 'deepseek', modelAliases: DEFAULT_MODEL_ALIASES, codexReasoningEffort: 'max' },
  );
  assert.equal(fallbackEffort.model, 'deepseek-v4-pro');
  assert.deepEqual(fallbackEffort.thinking, { type: 'enabled' });
  assert.equal(fallbackEffort.reasoning_effort, 'max');

  for (const model of ['deepseek-v4-flash', 'deepseek-v4-pro']) {
    for (const effort of ['low', 'high', 'max']) {
      const thinking = toProviderChatCompletionsRequest(
        {
          model,
          messages: [{ role: 'user', content: 'ping' }],
          reasoning: { effort },
        },
        { upstreamProvider: 'deepseek', modelAliases: DEFAULT_MODEL_ALIASES },
      );
      assert.equal(thinking.model, model);
      assert.deepEqual(thinking.thinking, { type: 'enabled' });
      assert.equal(thinking.reasoning_effort, effort);
    }
  }

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
  await scenario('rejects every non-native DeepSeek reasoning effort', async () => {
  for (const effort of ['medium', 'xhigh', 'disabled', 'off', 'false', 'HIGH', '', 'minimal', 'foo']) {
    assert.throws(
      () => toProviderChatCompletionsRequest(
        {
          model: 'deepseek-v4-pro',
          messages: [{ role: 'user', content: 'ping' }],
          reasoning: { effort },
        },
        { upstreamProvider: 'deepseek', modelAliases: DEFAULT_MODEL_ALIASES },
      ),
      (error) => error.code === 'invalid_reasoning_effort' && error.statusCode === 400,
    );
  }
  assert.throws(
    () => toProviderChatCompletionsRequest(
      { model: 'deepseek-v4-pro', messages: [{ role: 'user', content: 'ping' }] },
      { upstreamProvider: 'deepseek', modelAliases: DEFAULT_MODEL_ALIASES, codexReasoningEffort: 'xhigh' },
    ),
    (error) => error.code === 'invalid_reasoning_effort' && error.statusCode === 400,
  );
  });
  await scenario('keeps the DeepSeek max_tokens default independent from the catalog compaction threshold', async () => {
  const defaulted = toProviderChatCompletionsRequest(
    { model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'hi' }] },
    { upstreamProvider: 'deepseek', modelAliases: DEFAULT_MODEL_ALIASES },
  );
  assert.deepEqual(defaulted.thinking, { type: 'enabled' });
  assert.equal(defaulted.max_tokens, 100000);

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
  await scenario('downgrades json_schema with schema instructions containing the word json', async () => {
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
  await scenario('downgrades multimodal input parts to text placeholders for DeepSeek', async () => {
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
  await scenario('strips strict from DeepSeek tools unless the beta base url is used', async () => {
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
  await scenario('injects the commentary tool and contract line for DeepSeek tool requests', async () => {
  const request = toProviderChatCompletionsRequest(
    {
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'shell_command', parameters: { type: 'object', properties: {} } } }],
    },
    { upstreamProvider: 'deepseek', upstreamModel: 'deepseek-v4-flash' },
  );
  assert.deepEqual(request.tools.map((tool) => tool.function.name), ['shell_command', 'commentary']);
  assert.match(String(request.messages[0].content), /The user cannot see your thinking/);
  assert.match(String(request.messages[0].content), /first in the tool_calls array/);
  assert.match(String(request.messages[0].content), /Never call it alone or use it for the final answer/);
  assert.match(request.tools[1].function.description, /first in every tool_calls array with other tool calls/);
  assert.match(request.tools[1].function.description, /never call it alone or use it for the final answer/);

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
  await scenario('shims web search tools as unavailable functions when no provider is configured', async () => {
  const shims = unavailableWebSearchToolShims([
    { type: 'web_search' },
    { type: 'web_search_preview' },
    { type: 'web_search' },
  ]);
  assert.deepEqual(shims.map((tool) => tool.function.name), ['web_search', 'web_search_preview']);
  assert.match(shims[0].function.description, /no search provider is configured/);
  assert.match(shims[0].function.description, /Do not call this tool/);
  });
  await scenario('keeps DeepSeek provider request prefixes byte-stable across rounds and turns', async () => {
  const providerOptions = { upstreamProvider: 'deepseek', upstreamModel: 'deepseek-v4-flash' };
  const shellTool = {
    type: 'function',
    name: 'shell_command',
    description: 'Run a shell command',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
      additionalProperties: false,
    },
  };
  const baseInput = [
    { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'AGENTS.md: keep sources comment-free.' }] },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'fix the failing test' }] },
  ];
  const buildProvider = (input, effort) => {
    const normalized = normalizeResponsesRequest({
      model: 'deepseek-v4-flash',
      instructions: 'You are Codex.',
      input,
      tools: [shellTool],
      reasoning: { effort, summary: 'auto' },
      store: false,
      stream: true,
    });
    return {
      normalized,
      provider: toProviderChatCompletionsRequest(toChatCompletionsRequest(normalized), providerOptions),
    };
  };
  const replyItems = (normalized, message) => convertChatCompletionToResponses({
    responseId: 'resp_prefix',
    model: 'deepseek-v4-flash',
    previousResponseId: null,
    normalized,
    completion: {
      id: 'chatcmpl_prefix',
      created: 1000,
      choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }],
    },
  }).output;
  const messageBytes = (built) => built.provider.messages.map((message) => JSON.stringify(message));
  const assertAppendOnly = (prev, next) => {
    assert.deepEqual(messageBytes(next).slice(0, prev.provider.messages.length), messageBytes(prev));
    assert.equal(JSON.stringify(next.provider.tools), JSON.stringify(prev.provider.tools));
  };

  const round1 = buildProvider(baseInput, 'high');
  const round2Input = [
    ...baseInput,
    ...replyItems(round1.normalized, {
      role: 'assistant',
      content: '',
      reasoning_content: 'Check the test file first.',
      tool_calls: [
        { id: 'call_shell_1', type: 'function', function: { name: 'shell_command', arguments: '{"command":"npm test"}' } },
      ],
    }),
    { type: 'function_call_output', call_id: 'call_shell_1', output: '1 failing: expects 42' },
  ];
  const round2 = buildProvider(round2Input, 'high');
  assertAppendOnly(round1, round2);

  const turn2Input = [
    ...round2Input,
    ...replyItems(round2.normalized, {
      role: 'assistant',
      content: 'Fixed the constant; test passes now.',
      reasoning_content: 'The fix is a constant.',
    }),
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'now run lint' }] },
  ];
  const turn2 = buildProvider(turn2Input, 'high');
  assertAppendOnly(round2, turn2);

  const commentaryItems = replyItems(turn2.normalized, {
    role: 'assistant',
    content: '',
    reasoning_content: 'Lint next.',
    tool_calls: [
      { id: 'call_comment_1', type: 'function', function: { name: 'commentary', arguments: '{"text":"Running lint now."}' } },
      { id: 'call_shell_2', type: 'function', function: { name: 'shell_command', arguments: '{"command":"npm run lint"}' } },
    ],
  });
  assert.deepEqual(
    commentaryItems.map((item) => item.type),
    ['reasoning', 'message', 'function_call'],
  );
  const commentaryRoundInput = [
    ...turn2Input,
    ...commentaryItems,
    { type: 'function_call_output', call_id: 'call_shell_2', output: 'lint clean' },
  ];
  const commentaryRound = buildProvider(commentaryRoundInput, 'high');
  assertAppendOnly(turn2, commentaryRound);

  const finalInput = [
    ...commentaryRoundInput,
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'summarize' }] },
  ];
  assert.deepEqual(messageBytes(buildProvider(finalInput, 'low')), messageBytes(buildProvider(finalInput, 'high')));
  });
  await scenario('maps Codex max effort to DeepSeek thinking with reasoning_effort max', async () => {
  const request = toProviderChatCompletionsRequest(toChatCompletionsRequest(normalizeResponsesRequest({
    model: 'deepseek-v4-flash',
    input: 'hello',
    reasoning: { effort: 'max' },
  })), { upstreamProvider: 'deepseek', upstreamModel: 'deepseek-v4-flash' });
  assert.deepEqual(request.thinking, { type: 'enabled' });
  assert.equal(request.reasoning_effort, 'max');
  });
  await scenario('drops deprecated penalty fields from DeepSeek provider requests only', async () => {
  const chat = toChatCompletionsRequest(normalizeResponsesRequest({
    model: 'deepseek-v4-flash',
    input: 'hello',
    frequency_penalty: 0.5,
    presence_penalty: 0.25,
  }));
  assert.equal(chat.frequency_penalty, 0.5);
  assert.equal(chat.presence_penalty, 0.25);
  const generic = toProviderChatCompletionsRequest(chat, { upstreamProvider: 'generic', upstreamModel: 'other-model' });
  assert.equal(generic.frequency_penalty, 0.5);
  assert.equal(generic.presence_penalty, 0.25);
  const request = toProviderChatCompletionsRequest(chat, { upstreamProvider: 'deepseek', upstreamModel: 'deepseek-v4-flash' });
  assert.equal('frequency_penalty' in request, false);
  assert.equal('presence_penalty' in request, false);
  });
});

test('non-streaming Responses output and replay conversion', async () => {
  await scenario('converts chat completion to Responses object', async () => {
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
  await scenario('maps DeepSeek reasoning content to Responses reasoning summary', async () => {
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
  await scenario('prefixes the summary display with the Reasoning header and cleans model markdown', async () => {
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
  await scenario('cleans the summary display while keeping raw reasoning history markdown intact', async () => {
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
  await scenario('flattens numbered and bulleted reasoning into plain summary lines', async () => {
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
  await scenario('uses summary only for visible reasoning to avoid duplicate display', async () => {
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
  await scenario('does not create empty assistant messages for tool-only chat completions', async () => {
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
  await scenario('marks assistant content that accompanies tool calls as commentary', async () => {
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
  await scenario('normalizes stringified command arrays in non-streaming chat completions', async () => {
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
  await scenario('bridges custom tools to an input shim and restores custom_tool_call on stream output', async () => {
  const normalized = normalizeResponsesRequest({
    model: 'deepseek-v4-flash',
    input: 'edit the file',
    tools: [
      {
        type: 'custom',
        name: 'apply_patch',
        description: 'Use the `apply_patch` tool to edit files. This is a FREEFORM tool, so do not wrap the patch in JSON.',
        format: { type: 'grammar', syntax: 'lark', definition: 'start: begin_patch hunk+ end_patch' },
        input_schema: {
          type: 'object',
          properties: { input: { type: 'string', description: 'Raw patch payload.' } },
        },
      },
    ],
  });
  const chat = toChatCompletionsRequest(normalized);
  assert.equal(chat.tools.length, 1);
  assert.equal(chat.tools[0].function.name, 'apply_patch');
  assert.equal(chat.tools[0].function.description, 'Edit files by sending structured edits; the runtime applies them through native apply_patch.');
  assert.doesNotMatch(chat.tools[0].function.description, /FREEFORM|do not wrap|Tool description/i);
  assert.equal(chat.tools[0].gateway_custom_tool_input, 'apply_patch');
  assert.deepEqual(chat.tools[0].function.parameters.required, ['edits']);
  assert.equal('anyOf' in chat.tools[0].function.parameters, false);
  assert.equal(chat.tools[0].function.parameters.properties.edits.type, 'array');
  assert.equal(chat.tools[0].function.parameters.properties.edits.minItems, 1);
  assert.equal(chat.tools[0].function.parameters.properties.edits.items.properties.old.minLength, 1);
  assert.equal('minLength' in chat.tools[0].function.parameters.properties.edits.items.properties.new, false);
  assert.equal('minLength' in chat.tools[0].function.parameters.properties.edits.items.properties.content, false);
  assert.deepEqual(chat.tools[0].function.parameters.properties.edits.items.properties.type.enum, [
    'add_file',
    'delete_file',
    'replace_text',
    'delete_text',
    'append_text',
    'insert_text_before',
    'insert_text_after',
    'update_hunk',
  ]);
  assert.equal('input' in chat.tools[0].function.parameters.properties, false);
  assert.equal(JSON.stringify(chat.tools[0]).includes('start: begin_patch hunk+ end_patch'), false);
  assert.equal(JSON.stringify(chat.tools[0]).includes('FREEFORM tool'), false);

  const provider = toProviderChatCompletionsRequest(chat, {
    upstreamProvider: 'deepseek',
    modelAliases: DEFAULT_MODEL_ALIASES,
  });
  assert.equal('gateway_custom_tool' in provider.tools[0], false);
  assert.equal('gateway_custom_tool_input' in provider.tools[0], false);
  assert.equal(provider.tools[0].function.parameters.properties.edits.type, 'array');
  assert.equal('input' in provider.tools[0].function.parameters.properties, false);
  assert.match(provider.messages[0].content, /Codex custom tools are callable functions here/);
  assert.match(provider.messages[0].content, /Choose the most direct tool whose declared scope matches the target/);
  assert.match(provider.messages[0].content, /Never invent handles, IDs, URIs, resource names, or prior tool results/);

  const mapper = new ResponsesStreamMapper({
    responseId: 'resp_custom',
    model: 'deepseek-v4-flash',
    normalized,
  });
  const patchText = '*** Begin Patch\n*** Update File: a.txt\n@@\n-old\n+new\n*** End Patch';
  const structuredPatch = {
    edits: [
      { type: 'replace_text', file: 'a.txt', old: 'old', new: 'new' },
    ],
  };
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
                  function: { name: 'apply_patch', arguments: JSON.stringify(structuredPatch) },
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
  const completed = events.find((event) => event.type === 'response.completed');
  const completedItem = completed.response.output.find((item) => item.type === 'custom_tool_call');
  assert.equal('arguments' in completedItem, false);
  assert.equal('namespace' in completedItem, false);
  assert.deepEqual(Object.keys(completedItem).sort(), ['call_id', 'id', 'input', 'name', 'status', 'type']);
  assert.equal(completedItem.input, patchText);
  const assistant = mapper.assistantMessage();
  assert.equal(assistant.tool_calls[0].function.name, 'apply_patch');
  assert.deepEqual(JSON.parse(assistant.tool_calls[0].function.arguments), structuredPatch);
  });
  await scenario('lowers structured apply_patch edits on non-streaming completions', async () => {
  const normalized = normalizeResponsesRequest({
    model: 'deepseek-v4-flash',
    input: 'edit',
    tools: [
      {
        type: 'custom',
        name: 'apply_patch',
        description: 'Edit files.',
        format: { type: 'grammar', syntax: 'lark', definition: 'start: begin_patch hunk+ end_patch' },
      },
    ],
  });
  const structuredPatch = {
    edits: [
      { type: 'add_file', file: 'new.md', content: '# Title\n\nBody' },
      { type: 'replace_text', file: 'old.md', anchor: '# Old', old: 'before', new: 'after' },
      { type: 'insert_text_after', file: 'renamed.md', anchor: 'after', content: 'tail' },
      { type: 'insert_text_before', file: 'renamed.md', anchor: 'after', content: 'head' },
      { type: 'delete_text', file: 'renamed.md', old: 'remove me' },
      { type: 'append_text', file: 'renamed.md', content: 'end' },
      { type: 'delete_file', file: 'remove.md' },
    ],
  };
  const response = convertChatCompletionToResponses({
    completion: {
      created: 1000,
      choices: [
        {
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: {
                  name: 'apply_patch',
                  arguments: JSON.stringify(structuredPatch),
                },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    },
    model: 'deepseek-v4-flash',
    previousResponseId: null,
    normalized,
    responseId: 'resp_structured_patch',
  });
  const item = response.output.find((entry) => entry.type === 'custom_tool_call');
  assert.equal(item.input, [
    '*** Begin Patch',
    '*** Add File: new.md',
    '+# Title',
    '+',
    '+Body',
    '*** Update File: old.md',
    '@@',
    '-before',
    '+after',
    '*** Update File: renamed.md',
    '@@',
    ' after',
    '+tail',
    '@@',
    '+head',
    ' after',
    '@@',
    '-remove me',
    '@@',
    '+end',
    '*** End of File',
    '*** Delete File: remove.md',
    '*** End Patch',
  ].join('\n'));
  assert.equal(item.input.match(/\*\*\* Update File: renamed\.md/g).length, 1);
  assert.equal(Object.keys(item).includes('arguments'), false);
  assert.deepEqual(JSON.parse(assistantMessageFromResponseOutput(response.output).tool_calls[0].function.arguments), structuredPatch);
  });
  await scenario('merges same-file structured edits into one ordered update section', async () => {
  const normalized = normalizeResponsesRequest({
    model: 'deepseek-v4-flash',
    input: 'move source line',
    tools: [
      {
        type: 'custom',
        name: 'apply_patch',
        description: 'Edit files.',
        format: { type: 'grammar', syntax: 'lark', definition: 'start: begin_patch hunk+ end_patch' },
      },
    ],
  });
  const structuredPatch = {
    edits: [
      { type: 'delete_text', file: 'doc.md', old: '> Source line' },
      { type: 'insert_text_before', file: 'doc.md', anchor: '# Title', content: '> Source line\n\n' },
    ],
  };
  const response = convertChatCompletionToResponses({
    completion: {
      created: 1000,
      choices: [
        {
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'call_move_source',
                type: 'function',
                function: {
                  name: 'apply_patch',
                  arguments: JSON.stringify(structuredPatch),
                },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    },
    model: 'deepseek-v4-flash',
    previousResponseId: null,
    normalized,
    responseId: 'resp_patch_non_monotonic',
  });
  const item = response.output.find((entry) => entry.type === 'custom_tool_call');
  assert.equal(item.input, [
    '*** Begin Patch',
    '*** Update File: doc.md',
    '@@',
    '-> Source line',
    '@@',
    '+> Source line',
    '+',
    ' # Title',
    '*** End Patch',
  ].join('\n'));
  assert.equal(item.input.match(/\*\*\* Update File: doc\.md/g).length, 1);
  assert.deepEqual(JSON.parse(assistantMessageFromResponseOutput(response.output).tool_calls[0].function.arguments), structuredPatch);
  });
  await scenario('lowers structured native apply_patch hunks', async () => {
  const normalized = normalizeResponsesRequest({
    model: 'deepseek-v4-flash',
    input: 'edit with native hunk',
    tools: [
      {
        type: 'custom',
        name: 'apply_patch',
        description: 'Edit files.',
        format: { type: 'grammar', syntax: 'lark', definition: 'start: begin_patch hunk+ end_patch' },
      },
    ],
  });
  const structuredPatch = {
    edits: [
      {
        type: 'update_hunk',
        file: 'old.md',
        move_to: 'renamed.md',
        chunks: [
          {
            anchor: 'function main()',
            lines: [
              { op: 'context', text: 'const before = 1;' },
              { op: 'delete', text: 'old();' },
              { op: 'add', text: 'new();' },
            ],
          },
          {
            anchor: 'function cleanup()',
            lines: [
              { op: 'delete', text: 'oldCleanup();' },
              { op: 'add', text: 'newCleanup();' },
            ],
          },
        ],
      },
      {
        type: 'update_hunk',
        file: 'tail.md',
        chunks: [
          {
            lines: [{ op: 'add', text: 'tail' }],
            eof: true,
          },
        ],
      },
    ],
  };
  const response = convertChatCompletionToResponses({
    completion: {
      created: 1000,
      choices: [
        {
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'call_native_hunk',
                type: 'function',
                function: {
                  name: 'apply_patch',
                  arguments: JSON.stringify(structuredPatch),
                },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    },
    model: 'deepseek-v4-flash',
    previousResponseId: null,
    normalized,
    responseId: 'resp_patch_native_hunk',
  });
  const item = response.output.find((entry) => entry.type === 'custom_tool_call');
  assert.equal(item.input, [
    '*** Begin Patch',
    '*** Update File: old.md',
    '*** Move to: renamed.md',
    '@@ function main()',
    ' const before = 1;',
    '-old();',
    '+new();',
    '@@ function cleanup()',
    '-oldCleanup();',
    '+newCleanup();',
    '*** Update File: tail.md',
    '@@',
    '+tail',
    '*** End of File',
    '*** End Patch',
  ].join('\n'));
  assert.deepEqual(JSON.parse(assistantMessageFromResponseOutput(response.output).tool_calls[0].function.arguments), structuredPatch);
  });
  await scenario('rejects direct native apply_patch input on the DeepSeek-facing apply_patch tool', async () => {
  const normalized = normalizeResponsesRequest({
    model: 'deepseek-v4-flash',
    input: 'edit',
    tools: [
      {
        type: 'custom',
        name: 'apply_patch',
        description: 'Edit files.',
        format: { type: 'grammar', syntax: 'lark', definition: 'start: begin_patch hunk+ end_patch' },
      },
    ],
  });
  const patchText = [
    '*** Begin Patch',
    '*** Update File: old.md',
    '*** Move to: renamed.md',
    '@@',
    ' # Old',
    '-before',
    '+after',
    '*** End Patch',
  ].join('\n');
  const response = convertChatCompletionToResponses({
    completion: {
      created: 1000,
      choices: [
        {
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: {
                  name: 'apply_patch',
                  arguments: JSON.stringify({ input: patchText }),
                },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    },
    model: 'deepseek-v4-flash',
    previousResponseId: null,
    normalized,
    responseId: 'resp_raw_patch',
  });
  const item = response.output.find((entry) => entry.type === 'custom_tool_call');
  assert.equal(item.input, '');
  assert.deepEqual(JSON.parse(assistantMessageFromResponseOutput(response.output).tool_calls[0].function.arguments), { input: '' });
  });
  await scenario('uses structured apply_patch edits and drops raw input when both are supplied', async () => {
  const normalized = normalizeResponsesRequest({
    model: 'deepseek-v4-flash',
    input: 'edit',
    tools: [
      {
        type: 'custom',
        name: 'apply_patch',
        description: 'Edit files.',
        format: { type: 'grammar', syntax: 'lark', definition: 'start: begin_patch hunk+ end_patch' },
      },
    ],
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
              {
                id: 'call_1',
                type: 'function',
                function: {
                  name: 'apply_patch',
                  arguments: JSON.stringify({
                    input: '*** Begin Patch\n*** Delete File: a.txt\n*** End Patch',
                    edits: [{ type: 'replace_text', file: 'a.txt', old: 'old', new: 'new' }],
                  }),
                },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    },
    model: 'deepseek-v4-flash',
    previousResponseId: null,
    normalized,
    responseId: 'resp_structured_patch_over_raw',
  });
  const item = response.output.find((entry) => entry.type === 'custom_tool_call');
  assert.equal(item.input, '*** Begin Patch\n*** Update File: a.txt\n@@\n-old\n+new\n*** End Patch');
  assert.deepEqual(JSON.parse(assistantMessageFromResponseOutput(response.output).tool_calls[0].function.arguments), {
    edits: [{ type: 'replace_text', file: 'a.txt', old: 'old', new: 'new' }],
  });
  });
  await scenario('lowers structured apply_patch edits with a Codex environment id when supported', async () => {
  const normalized = normalizeResponsesRequest({
    model: 'deepseek-v4-flash',
    input: 'edit',
    tools: [
      {
        type: 'custom',
        name: 'apply_patch',
        description: 'Edit files.',
        format: {
          type: 'grammar',
          syntax: 'lark',
          definition: [
            'start: begin_patch environment_id? hunk+ end_patch',
            'environment_id: "*** Environment ID: " filename LF',
            'begin_patch: "*** Begin Patch" LF',
            'end_patch: "*** End Patch" LF?',
          ].join('\n'),
        },
      },
    ],
  });
  const chat = toChatCompletionsRequest(normalized);
  assert.equal(chat.tools[0].gateway_custom_tool_input, 'apply_patch_environment');
  assert.equal(chat.tools[0].function.parameters.properties.environment_id.type, 'string');
  const response = convertChatCompletionToResponses({
    completion: {
      created: 1000,
      choices: [
        {
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'call_env',
                type: 'function',
                function: {
                  name: 'apply_patch',
                  arguments: JSON.stringify({
                    environment_id: 'workspace',
                    edits: [{ type: 'add_file', file: 'env.md', content: 'ok' }],
                  }),
                },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    },
    model: 'deepseek-v4-flash',
    previousResponseId: null,
    normalized,
    responseId: 'resp_patch_env',
  });
  const item = response.output.find((entry) => entry.type === 'custom_tool_call');
  assert.equal(item.input, [
    '*** Begin Patch',
    '*** Environment ID: workspace',
    '*** Add File: env.md',
    '+ok',
    '*** End Patch',
  ].join('\n'));
  });
  await scenario('rejects apply_patch input strings that are not native patch text', async () => {
  const normalized = normalizeResponsesRequest({
    model: 'deepseek-v4-flash',
    input: 'edit',
    tools: [
      {
        type: 'custom',
        name: 'apply_patch',
        description: 'Edit files.',
        format: { type: 'grammar', syntax: 'lark', definition: 'start: begin_patch hunk+ end_patch' },
      },
    ],
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
              {
                id: 'call_string',
                type: 'function',
                function: {
                  name: 'apply_patch',
                  arguments: JSON.stringify('replace old with new'),
                },
              },
              {
                id: 'call_input',
                type: 'function',
                function: {
                  name: 'apply_patch',
                  arguments: JSON.stringify({ input: 'replace old with new' }),
                },
              },
              {
                id: 'call_empty_input',
                type: 'function',
                function: {
                  name: 'apply_patch',
                  arguments: JSON.stringify({ input: '' }),
                },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    },
    model: 'deepseek-v4-flash',
    previousResponseId: null,
    normalized,
    responseId: 'resp_bad_patch_input',
  });
  const items = response.output.filter((entry) => entry.type === 'custom_tool_call');
  assert.deepEqual(items.map((item) => item.input), ['', '', '']);
  });
  await scenario('rejects ambiguous or invalid structured apply_patch edits', async () => {
  const normalized = normalizeResponsesRequest({
    model: 'deepseek-v4-flash',
    input: 'edit',
    tools: [
      {
        type: 'custom',
        name: 'apply_patch',
        description: 'Edit files.',
        format: { type: 'grammar', syntax: 'lark', definition: 'start: begin_patch hunk+ end_patch' },
      },
    ],
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
              {
                id: 'call_replace',
                type: 'function',
                function: {
                  name: 'apply_patch',
                  arguments: JSON.stringify({ edits: [{ type: 'replace_text', file: 'a.txt', new: 'new' }] }),
                },
              },
              {
                id: 'call_delete_text',
                type: 'function',
                function: {
                  name: 'apply_patch',
                  arguments: JSON.stringify({ edits: [{ type: 'delete_text', file: 'a.txt' }] }),
                },
              },
              {
                id: 'call_delete_file_with_text',
                type: 'function',
                function: {
                  name: 'apply_patch',
                  arguments: JSON.stringify({ edits: [{ type: 'delete_file', file: 'a.txt', old: 'line to delete' }] }),
                },
              },
              {
                id: 'call_legacy_delete',
                type: 'function',
                function: {
                  name: 'apply_patch',
                  arguments: JSON.stringify({ edits: [{ type: 'delete', file: 'a.txt' }] }),
                },
              },
              {
                id: 'call_move_only',
                type: 'function',
                function: {
                  name: 'apply_patch',
                  arguments: JSON.stringify({ edits: [{ type: 'move_file', file: 'a.txt', move_to: 'b.txt' }] }),
                },
              },
              {
                id: 'call_bad_hunk',
                type: 'function',
                function: {
                  name: 'apply_patch',
                  arguments: JSON.stringify({ edits: [{ type: 'update_hunk', file: 'a.txt', chunks: [{ lines: [{ op: 'copy', text: 'x' }] }] }] }),
                },
              },
              {
                id: 'call_old_hunk_shape',
                type: 'function',
                function: {
                  name: 'apply_patch',
                  arguments: JSON.stringify({ edits: [{ type: 'update_hunk', file: 'a.txt', lines: [{ op: 'add', text: 'x' }] }] }),
                },
              },
              {
                id: 'call_unknown_field',
                type: 'function',
                function: {
                  name: 'apply_patch',
                  arguments: JSON.stringify({ edits: [{ type: 'replace_text', file: 'a.txt', old: 'old', new: 'new', note: 'extra' }] }),
                },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    },
    model: 'deepseek-v4-flash',
    previousResponseId: null,
    normalized,
    responseId: 'resp_bad_structured_patch',
  });
  const items = response.output.filter((entry) => entry.type === 'custom_tool_call');
  assert.deepEqual(items.map((item) => item.input), ['', '', '', '', '', '', '', '']);
  });
  await scenario('merges repeated and interleaved same-file edits into one section per file', async () => {
  const normalized = normalizeResponsesRequest({
    model: 'deepseek-v4-flash',
    input: 'edit',
    tools: [
      {
        type: 'custom',
        name: 'apply_patch',
        description: 'Edit files.',
        format: { type: 'grammar', syntax: 'lark', definition: 'start: begin_patch hunk+ end_patch' },
      },
    ],
  });
  const convert = (callId, edits) => convertChatCompletionToResponses({
    completion: {
      created: 1000,
      choices: [
        {
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              { id: callId, type: 'function', function: { name: 'apply_patch', arguments: JSON.stringify({ edits }) } },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    },
    model: 'deepseek-v4-flash',
    previousResponseId: null,
    normalized,
    responseId: `resp_${callId}`,
  }).output.find((entry) => entry.type === 'custom_tool_call');

  const twoHunks = convert('call_two_hunks', [
    { type: 'replace_text', file: 'a.txt', old: 'one', new: 'ONE' },
    { type: 'replace_text', file: 'b.txt', old: 'bee', new: 'BEE' },
    { type: 'replace_text', file: 'a.txt', old: 'two', new: 'TWO' },
  ]);
  assert.equal(twoHunks.input, [
    '*** Begin Patch',
    '*** Update File: a.txt',
    '@@',
    '-one',
    '+ONE',
    '@@',
    '-two',
    '+TWO',
    '*** Update File: b.txt',
    '@@',
    '-bee',
    '+BEE',
    '*** End Patch',
  ].join('\n'));
  assert.equal(twoHunks.input.match(/\*\*\* Update File: a\.txt/g).length, 1);
  assert.equal(twoHunks.input.match(/\*\*\* Update File:/g).length, 2);

  const movedAndEdited = convert('call_move_merge', [
    {
      type: 'update_hunk',
      file: 'src.md',
      move_to: 'dst.md',
      chunks: [{ lines: [{ op: 'delete', text: 'x' }, { op: 'add', text: 'y' }] }],
    },
    { type: 'replace_text', file: 'src.md', old: 'p', new: 'q' },
  ]);
  assert.equal(movedAndEdited.input, [
    '*** Begin Patch',
    '*** Update File: src.md',
    '*** Move to: dst.md',
    '@@',
    '-x',
    '+y',
    '@@',
    '-p',
    '+q',
    '*** End Patch',
  ].join('\n'));
  assert.equal(movedAndEdited.input.match(/\*\*\* Move to:/g).length, 1);

  const blankLines = convert('call_blank_lines', [
    { type: 'insert_text_after', file: 'c.txt', anchor: 'line', content: '' },
    { type: 'replace_text', file: 'd.txt', old: 'old', new: '' },
    { type: 'add_file', file: 'e.txt', content: '' },
  ]);
  assert.equal(blankLines.input, [
    '*** Begin Patch',
    '*** Update File: c.txt',
    '@@',
    ' line',
    '+',
    '*** Update File: d.txt',
    '@@',
    '-old',
    '+',
    '*** Add File: e.txt',
    '+',
    '*** End Patch',
  ].join('\n'));
  });
  await scenario('reports pinpointed diagnostics for invalid apply_patch tool calls', async () => {
  const normalized = normalizeResponsesRequest({
    model: 'deepseek-v4-flash',
    input: 'edit',
    tools: [
      {
        type: 'custom',
        name: 'apply_patch',
        description: 'Edit files.',
        format: { type: 'grammar', syntax: 'lark', definition: 'start: begin_patch hunk+ end_patch' },
      },
    ],
  });
  const chatTools = toChatCompletionsRequest(normalized).tools;
  assert.equal(chatToolsIncludeApplyPatch(chatTools), true);
  assert.equal(chatToolsIncludeApplyPatch([{ type: 'function', function: { name: 'shell' } }]), false);
  const diagnose = (args) => invalidApplyPatchToolCalls({
    choices: [
      {
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [
            { id: 'call_check', type: 'function', function: { name: 'apply_patch', arguments: args } },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
  }, chatTools);

  assert.deepEqual(diagnose(JSON.stringify({
    edits: [{ type: 'replace_text', file: 'a.txt', old: 'one', new: 'ONE' }],
  })), []);

  const combined = diagnose(JSON.stringify({
    edits: [
      { type: 'add_file', file: 'a.txt', content: 'x' },
      { type: 'replace_text', file: 'a.txt', old: 'old', new: 'new' },
    ],
  }));
  assert.equal(combined.length, 1);
  assert.equal(combined[0].id, 'call_check');
  assert.match(combined[0].error, /edits\[1\]: add_file or delete_file for "a\.txt" cannot be combined/);

  const duplicateDelete = diagnose(JSON.stringify({
    edits: [
      { type: 'delete_file', file: 'a.txt' },
      { type: 'delete_file', file: 'a.txt' },
    ],
  }));
  assert.match(duplicateDelete[0].error, /edits\[1\]: add_file or delete_file for "a\.txt"/);

  const afterEof = diagnose(JSON.stringify({
    edits: [
      { type: 'append_text', file: 'a.txt', content: 'tail' },
      { type: 'insert_text_after', file: 'a.txt', anchor: 'line', content: 'x' },
    ],
  }));
  assert.match(afterEof[0].error, /edits\[1\]: "a\.txt" already has an end-of-file edit/);

  const conflictingMove = diagnose(JSON.stringify({
    edits: [
      { type: 'update_hunk', file: 'a.txt', move_to: 'b.txt', chunks: [{ lines: [{ op: 'add', text: 'x' }] }] },
      { type: 'update_hunk', file: 'a.txt', move_to: 'c.txt', chunks: [{ lines: [{ op: 'add', text: 'y' }] }] },
    ],
  }));
  assert.match(conflictingMove[0].error, /edits\[1\]: conflicting move_to targets for "a\.txt"/);

  const emptyOldReplace = diagnose(JSON.stringify({
    edits: [{ type: 'replace_text', file: 'a.txt', old: '', new: 'x' }],
  }));
  assert.match(emptyOldReplace[0].error, /edits\[0\] replace_text: "old" must be non-empty exact current file text; to remove lines use delete_text with the exact lines/);

  const emptyOldDelete = diagnose(JSON.stringify({
    edits: [{ type: 'delete_text', file: 'a.txt', old: '' }],
  }));
  assert.match(emptyOldDelete[0].error, /edits\[0\] delete_text: "old" must be non-empty exact current file text; delete_text removes exactly those lines/);

  const unknownField = diagnose(JSON.stringify({
    edits: [{ type: 'append_text', file: 'a.txt', content: 'x', anchor: 'line' }],
  }));
  assert.match(unknownField[0].error, /edits\[0\] append_text: unknown field "anchor"/);

  const unknownType = diagnose(JSON.stringify({
    edits: [{ type: 'modify', file: 'a.txt' }],
  }));
  assert.match(unknownType[0].error, /edits\[0\]: unknown type "modify"/);

  const arrayContent = diagnose(JSON.stringify({
    edits: [
      { type: 'delete_file', file: 'z.txt' },
      { type: 'add_file', file: 'a.txt', content: ['line1', 'line2'] },
    ],
  }));
  assert.equal(arrayContent.length, 1);
  assert.match(arrayContent[0].error, /edits\[1\] add_file: "content" must be a string/);
  assert.doesNotMatch(arrayContent[0].error, /line1,line2/);

  const numericContent = diagnose(JSON.stringify({
    edits: [{ type: 'insert_text_after', file: 'a.txt', anchor: 'line', content: 123 }],
  }));
  assert.match(numericContent[0].error, /edits\[0\] insert_text_after: "content" must be a string/);

  const numericOldReplace = diagnose(JSON.stringify({
    edits: [{ type: 'replace_text', file: 'a.txt', old: 123, new: 'x' }],
  }));
  assert.match(numericOldReplace[0].error, /edits\[0\] replace_text: "old" must be a string/);

  const numericOldDelete = diagnose(JSON.stringify({
    edits: [{ type: 'delete_text', file: 'a.txt', old: 123 }],
  }));
  assert.match(numericOldDelete[0].error, /edits\[0\] delete_text: "old" must be a string/);

  const objectNew = diagnose(JSON.stringify({
    edits: [{ type: 'replace_text', file: 'a.txt', old: 'x', new: {} }],
  }));
  assert.match(objectNew[0].error, /edits\[0\] replace_text: "new" must be a string/);

  const nullContent = diagnose(JSON.stringify({
    edits: [{ type: 'append_text', file: 'a.txt', content: null }],
  }));
  assert.match(nullContent[0].error, /edits\[0\] append_text: "content" must be a string/);

  const editsOnlyError = /apply_patch arguments must be \{"edits": \[\.\.\.\]\}; raw patch text is not accepted\./;
  assert.match(diagnose(JSON.stringify('*** Begin Patch raw'))[0].error, editsOnlyError);
  assert.match(diagnose(JSON.stringify({ input: '*** Begin Patch raw' }))[0].error, editsOnlyError);
  assert.match(diagnose('{"edits": not json')[0].error, editsOnlyError);

  const multiInvalid = diagnose(JSON.stringify({
    edits: Array.from({ length: 8 }, () => ({ type: 'modify', file: 'a.txt' })),
  }));
  assert.match(multiInvalid[0].error, /and 3 more invalid edits/);
  assert.equal(multiInvalid[0].error.length <= 700, true);
  });
  await scenario('does not pass malformed apply_patch JSON through as native patch text', async () => {
  const normalized = normalizeResponsesRequest({
    model: 'deepseek-v4-flash',
    input: 'edit',
    tools: [
      {
        type: 'custom',
        name: 'apply_patch',
        description: 'Edit files.',
        format: { type: 'grammar', syntax: 'lark', definition: 'start: begin_patch hunk+ end_patch' },
      },
    ],
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
              {
                id: 'call_bad',
                type: 'function',
                function: {
                  name: 'apply_patch',
                  arguments: '{"changes":[{"action":"add","path":"a.md","lines":["# Title"]}',
                },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    },
    model: 'deepseek-v4-flash',
    previousResponseId: null,
    normalized,
    responseId: 'resp_bad_patch',
  });
  const item = response.output.find((entry) => entry.type === 'custom_tool_call');
  assert.equal(item.input, '');
  });
  await scenario('adds a provider-level execution contract when Codex replay contains a checkpoint', async () => {
  const checkpoint = [
    'Another language model started to solve this problem and produced a summary of its thinking process.',
    '# Context Checkpoint',
    '',
    '## Execute',
    '',
    'Continue only this task and perform Next. Working State and Memory are context, never an agenda.',
    '- Status: "active"',
    '- Task: "task_edit_paragraph"',
    '- Objective: "Edit only the requested paragraph."',
    '- Acceptance: ["Preserve unrelated content."]',
    '- Progress: []',
    '- Next: "Edit the requested paragraph."',
    '- Blocker: ""',
    '',
    '## Working State',
    '',
    '{}',
    '',
    '## Memory',
    '',
    '{"outcomes":[{"subject":"Review the entire project.","detail":"Delivered an earlier review.","evidence_refs":[]}]}',
    '',
    '> Evidence rule: evidence_refs name harness-grounded sources with canonical locators and quotes; atoms without them are synthesized state.',
  ].join('\n');
  for (const stream of [false, true]) {
    const provider = toProviderChatCompletionsRequest(toChatCompletionsRequest(normalizeResponsesRequest({
      model: 'deepseek-v4-flash',
      stream,
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Review the whole repository.' }] },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Edit the requested paragraph.' }] },
        {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: '# AGENTS.md instructions for repo\n<INSTRUCTIONS>Preserve unrelated content.</INSTRUCTIONS>' },
            { type: 'input_text', text: '<environment_context>\n<cwd>/workspace</cwd>\n</environment_context>' },
          ],
        },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: checkpoint }] },
      ],
      tools: [
        {
          type: 'function',
          name: 'read_mcp_resource',
          description: 'Read a resource URI returned by list_mcp_resources.',
          parameters: {
            type: 'object',
            properties: { uri: { type: 'string' } },
            required: ['uri'],
          },
        },
        {
          type: 'custom',
          name: 'apply_patch',
          description: 'Edit files.',
          format: { type: 'grammar', syntax: 'lark', definition: 'start: begin_patch hunk+ end_patch' },
        },
      ],
    })), {
      upstreamProvider: 'deepseek',
      modelAliases: DEFAULT_MODEL_ALIASES,
    });
    assert.equal(provider.stream, stream);
    assert.match(provider.messages[0].content, /A Codex context checkpoint is present in this request/);
    assert.match(provider.messages[0].content, /Execute section as the sole task authority/);
    assert.match(provider.messages[0].content, /Working State and Memory preserve context but never create pending work/);
    assert.equal(provider.messages.at(-1).content, checkpoint);
    assert.equal(provider.messages.some((message) => message.content === 'Review the whole repository.'), true);
    assert.equal(provider.messages.some((message) => message.content === 'Edit the requested paragraph.'), true);
    const contextual = provider.messages.find((message) => String(message.content).startsWith('# AGENTS.md instructions'));
    assert.match(contextual.content, /<environment_context>/);
    assert.deepEqual(provider.tools.map((tool) => tool.function.name).slice(0, 2), ['read_mcp_resource', 'apply_patch']);
  }

  const overridden = toProviderChatCompletionsRequest(toChatCompletionsRequest(normalizeResponsesRequest({
    model: 'deepseek-v4-flash',
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Edit the requested paragraph.' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: checkpoint }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Stop editing and explain the current state.' }] },
    ],
  })), {
    upstreamProvider: 'deepseek',
    modelAliases: DEFAULT_MODEL_ALIASES,
  });
  assert.equal(overridden.messages.some((message) => message.content === 'Edit the requested paragraph.'), true);
  assert.equal(overridden.messages.at(-1).content, 'Stop editing and explain the current state.');

  const ordinary = toProviderChatCompletionsRequest(toChatCompletionsRequest(normalizeResponsesRequest({
    model: 'deepseek-v4-flash',
    input: 'Edit the requested paragraph.',
  })), {
    upstreamProvider: 'deepseek',
    modelAliases: DEFAULT_MODEL_ALIASES,
  });
  assert.equal(ordinary.messages.some((message) => String(message.content).includes('A Codex context checkpoint is present in this request')), false);
  });
  await scenario('restores custom_tool_call items from non-streaming completions and raw text arguments', async () => {
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
  await scenario('restores raw reasoning from encrypted_content and merges commentary with tool calls on replay', async () => {
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
  await scenario('drops empty replayed assistant shells and keeps reasoning with the tool call turn', async () => {
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
  await scenario('expands multi_tool_use.parallel wrapper calls in non-streaming completions', async () => {
  const payload = convertChatCompletionToResponses({
    completion: {
      choices: [{
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'call_wrapper',
              type: 'function',
              function: {
                name: 'functions.Multi_Tool_Use_Parallel',
                arguments: JSON.stringify({
                  tool_uses: [
                    { recipient_name: 'functions.shell_command', parameters: { command: 'rg --files' } },
                    { recipient_name: 'view_image', parameters: '{"path":"a.png"}' },
                  ],
                }),
              },
            },
            {
              id: 'call_near_match',
              type: 'function',
              function: {
                name: 'multi_tool_use.parallel2',
                arguments: JSON.stringify({
                  tool_uses: [{ recipient_name: 'shell_command', parameters: { command: 'should not expand' } }],
                }),
              },
            },
          ],
        },
        finish_reason: 'tool_calls',
      }],
    },
    model: 'deepseek-v4-flash',
    normalized: normalizeResponsesRequest({ model: 'deepseek-v4-flash', input: 'go' }),
  });
  const calls = payload.output.filter((item) => item.type === 'function_call');
  assert.deepEqual(calls.map((item) => item.name), ['shell_command', 'view_image', 'multi_tool_use.parallel2']);
  assert.equal(calls[0].arguments, '{"command":"rg --files"}');
  assert.equal(calls[1].arguments, '{"path":"a.png"}');
  assert.match(calls[2].arguments, /should not expand/);
  assert.notEqual(calls[0].call_id, calls[1].call_id);
  });
  await scenario('bridges commentary tool calls in non-streaming completions and drops empty updates', async () => {
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
  await scenario('maps emitted name variants back to Codex tool identities in non-streaming conversion', async () => {
  const normalized = normalizeResponsesRequest({
    model: 'deepseek-v4-flash',
    input: 'go',
    tools: [
      { type: 'function', name: 'shell_command', parameters: { type: 'object', properties: {} } },
      { type: 'function', name: 'lookup', parameters: { type: 'object', properties: {} } },
      {
        type: 'namespace',
        name: 'workflow',
        tools: [{ type: 'function', function: { name: 'delegate_task', parameters: { type: 'object', properties: {} } } }],
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
            { id: 'call_b', type: 'function', function: { name: 'workflow.delegate_task', arguments: '{}' } },
            { id: 'call_c', type: 'function', function: { name: 'LOOKUP', arguments: '{}' } },
            { id: 'call_d', type: 'function', function: { name: 'mystery_tool', arguments: '{}' } },
            { id: 'call_e', type: 'function', function: { name: 'functions.mystery_tool', arguments: '{}' } },
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
  assert.deepEqual(
    calls.map((item) => item.name),
    ['shell_command', 'delegate_task', 'lookup', 'mystery_tool', 'functions.mystery_tool'],
  );
  assert.equal(calls[1].namespace, 'workflow');
  });
  await scenario('maps abnormal DeepSeek finish reasons to explicit Responses terminal states', async () => {
  const normalized = normalizeResponsesRequest({ model: 'deepseek-v4-flash', input: 'hello' });
  const convert = (finishReason) => convertChatCompletionToResponses({
    completion: {
      created: 1000,
      choices: [{ message: { role: 'assistant', content: 'partial' }, finish_reason: finishReason }],
    },
    model: 'deepseek-v4-flash',
    normalized,
    responseId: `resp_${finishReason}`,
  });

  const filtered = convert('content_filter');
  assert.equal(filtered.status, 'incomplete');
  assert.deepEqual(filtered.incomplete_details, { reason: 'content_filter' });
  assert.equal(filtered.output[0].status, 'incomplete');

  const length = convert('length');
  assert.equal(length.status, 'incomplete');
  assert.deepEqual(length.incomplete_details, { reason: 'max_output_tokens' });

  const overloaded = convert('insufficient_system_resource');
  assert.equal(overloaded.status, 'failed');
  assert.equal(overloaded.error.code, 'server_is_overloaded');
  assert.equal(overloaded.output[0].status, 'failed');

  const unknown = convert('future_reason');
  assert.equal(unknown.status, 'failed');
  assert.equal(unknown.error.code, 'upstream_error');
  assert.match(unknown.error.message, /future_reason/);
  });
});

test('reasoning stream ordering and display contract', async () => {
  await scenario('default reasoning stream exposes summary only while retaining raw history text', async () => {
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
  await scenario('maps chat completion stream chunks to Responses events', async () => {
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
  await scenario('can stream raw reasoning text deltas when summary mode is disabled', async () => {
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
  await scenario('flushes late reasoning as a trailing summary after visible output completes', async () => {
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
  await scenario('streams reasoning ahead of the final answer in thinking mode', async () => {
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
  await scenario('streams summary reasoning in one part with ordered deltas before final answer', async () => {
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
  await scenario('flushes markdown-heavy reasoning summary completely before numbered list content', async () => {
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
  await scenario('closes the reasoning summary at first visible output and keeps late reasoning in raw history', async () => {
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
  await scenario('streams visible output live and flushes reasoning that arrives after it as a trailing summary', async () => {
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
  await scenario('closes the reasoning summary and streams visible output live at the first content delta', async () => {
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
  await scenario('streams normalized reasoning summary while keeping raw reasoning content', async () => {
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
  await scenario('flushes raw reasoning completely before final answer', async () => {
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
});

test('streamed tool calls, commentary, and name recovery', async () => {
  await scenario('emits native tool_search calls without function argument events', async () => {
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
  await scenario('marks streamed assistant content before tool calls as commentary', async () => {
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
  await scenario('starts DeepSeek streamed text as commentary while tools are still possible', async () => {
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
  await scenario('promotes DeepSeek streamed text to final answer when no tool call arrives', async () => {
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
  await scenario('streams namespace tool group calls back with namespace restored', async () => {
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
  await scenario('delays streaming tool output item until tool name is known', async () => {
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
  await scenario('normalizes stringified streaming tool arguments from parameters and input_schema', async () => {
  const cases = [
    {
      tool: {
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
      arguments: {
        options: '{"mode":"fast"}',
        ids: '["a","b"]',
        dry_run: 'true',
        count: '2',
        note: '["keep as string"]',
      },
      expected: {
        options: { mode: 'fast' },
        ids: ['a', 'b'],
        dry_run: true,
        count: 2,
        note: '["keep as string"]',
      },
    },
    {
      tool: {
        type: 'function',
        name: 'shell',
        input_schema: {
          type: 'object',
          properties: {
            command: { type: 'array', items: { type: 'string' } },
          },
        },
      },
      arguments: { command: '["cmd","/c","echo hello"]' },
      expected: { command: ['cmd', '/c', 'echo hello'] },
    },
  ];

  for (const entry of cases) {
    const name = entry.tool.function?.name || entry.tool.name;
    const mapper = new ResponsesStreamMapper({
      responseId: `resp_stream_${name}`,
      model: 'deepseek-v4-flash',
      normalized: { tools: [entry.tool] },
    });
    const events = [
      ...mapper.mapChatEvent({
        data: JSON.stringify({
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: `call_${name}`,
                function: { name, arguments: JSON.stringify(entry.arguments) },
              }],
            },
            finish_reason: null,
          }],
        }),
      }),
      ...mapper.mapChatEvent({ data: JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }) }),
      ...mapper.mapChatEvent({ done: true }),
    ];
    const deltas = events
      .filter((event) => event.type === 'response.function_call_arguments.delta')
      .map((event) => event.delta)
      .join('');
    const done = events.find((event) => event.type === 'response.function_call_arguments.done');
    const outputDone = events.find((event) => event.type === 'response.output_item.done' && event.item.type === 'function_call');
    assert.deepEqual(JSON.parse(deltas), entry.expected);
    assert.deepEqual(JSON.parse(done.arguments), entry.expected);
    assert.deepEqual(JSON.parse(outputDone.item.arguments), entry.expected);
  }
  });
  await scenario('expands multi_tool_use.parallel wrapper calls into individual streamed tool items', async () => {
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
  await scenario('passes malformed multi_tool_use.parallel arguments through unchanged', async () => {
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
  await scenario('bridges commentary tool calls into visible commentary messages on the streaming path', async () => {
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
  await scenario('passes commentary calls through as function calls when the request defines its own commentary tool', async () => {
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
  await scenario('resolves emitted name variants in streaming tool calls', async () => {
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
            tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'functions.LOOKUP', arguments: '{"q":"x"}' } }],
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
});

test('SSE lifecycle, usage, EOF, and terminal states', async () => {
  await scenario('finalizes Responses stream when upstream sends DONE without finish reason', async () => {
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
  await scenario('maps a full chat completion object through the streaming mapper fallback', async () => {
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
  await scenario('serializes and parses SSE frames with CRLF', async () => {
  const parser = new SseParser();
  const frame = serializeResponsesSseEvent({ type: 'response.created', sequence_number: 1, response: { id: 'resp_1' } });
  const parsed = parser.push(Buffer.from(frame.replaceAll('\n', '\r\n')));
  assert.equal(parsed.length, 1);
  assert.equal(JSON.parse(parsed[0].data).type, 'response.created');
  });
  await scenario('captures DeepSeek usage from the trailing empty-choices chunk before completing', async () => {
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
  await scenario('fails the stream on bare upstream EOF without finish_reason', async () => {
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
  await scenario('completes on EOF when a finish_reason was already seen', async () => {
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
  await scenario('skips malformed SSE frames without failing the stream', async () => {
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
  await scenario('emits explicit streaming terminal events for abnormal DeepSeek finish reasons', async () => {
  const map = (finishReason) => {
    const mapper = new ResponsesStreamMapper({
      responseId: `resp_stream_${finishReason}`,
      model: 'deepseek-v4-flash',
      normalized: normalizeResponsesRequest({ model: 'deepseek-v4-flash', input: 'hello', stream: true }),
    });
    mapper.mapChatEvent({ data: JSON.stringify({ choices: [{ delta: { content: 'partial' }, finish_reason: finishReason }] }) });
    return mapper.mapChatEvent({ done: true }).at(-1);
  };

  const filtered = map('content_filter');
  assert.equal(filtered.type, 'response.incomplete');
  assert.deepEqual(filtered.response.incomplete_details, { reason: 'content_filter' });

  const length = map('length');
  assert.equal(length.type, 'response.incomplete');
  assert.deepEqual(length.response.incomplete_details, { reason: 'max_output_tokens' });

  const overloaded = map('insufficient_system_resource');
  assert.equal(overloaded.type, 'response.failed');
  assert.equal(overloaded.response.error.code, 'server_is_overloaded');

  const unknown = map('future_reason');
  assert.equal(unknown.type, 'response.failed');
  assert.equal(unknown.response.error.code, 'upstream_error');
  });
});
