import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CODEX_COMPACT_PROMPT, parseRenderedCheckpoint, renderCompactionCheckpoint } from '../src/compaction.js';
import { DEFAULT_MODEL_ALIASES } from '../src/model-map.js';
import { ReasoningCache } from '../src/reasoning-cache.js';
import { createProxyServer } from '../src/server.js';

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve('http://127.0.0.1:' + server.address().port));
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function parseResponsesSse(text) {
  const frames = [];
  for (const block of String(text).split(/\r?\n\r?\n/)) {
    if (!block.trim()) continue;
    let event = '';
    const data = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    if (!data.length) continue;
    const payload = data.join('\n');
    frames.push({ event, data: payload === '[DONE]' ? payload : JSON.parse(payload) });
  }
  return frames;
}

function atom(subject, detail, evidenceRefs = []) {
  return { subject, detail, evidence_refs: evidenceRefs };
}

function checkpoint({
  taskId = 'task_gateway_compaction',
  status = 'active',
  objective = 'Complete the gateway compaction path.',
  acceptance = ['Preserve the current task and verify the gateway behavior.'],
  next = 'Run the remaining verification.',
  blocker = '',
  working = {},
  memory = {},
} = {}) {
  const active = status === 'active' || status === 'blocked';
  return {
    execution: {
      task_id: active ? taskId : '',
      status: active ? status : 'idle',
      objective: active ? objective : '',
      acceptance: active ? acceptance : [],
      next: active ? next : '',
      blocker: status === 'blocked' ? blocker : '',
    },
    working: {
      artifacts: [],
      knowledge: [],
      verification: [],
      operations: [],
      risks: [],
      ...working,
    },
    memory: {
      session: [],
      durable: [],
      suspended: [],
      ...memory,
    },
  };
}

function compactCompletion({
  value = checkpoint(),
  content = '',
  finishReason = 'tool_calls',
  toolName = 'submit_compaction_checkpoint',
  argumentsText = JSON.stringify(value),
  toolCalls,
  usage = { prompt_tokens: 900, completion_tokens: 100, total_tokens: 1000 },
} = {}) {
  const message = { role: 'assistant', content };
  message.tool_calls = toolCalls ?? [{
    id: 'call_submit_checkpoint',
    type: 'function',
    function: { name: toolName, arguments: argumentsText },
  }];
  return {
    id: 'chatcmpl_compact',
    object: 'chat.completion',
    created: 123,
    model: 'deepseek-v4-pro',
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage,
  };
}

function compactMetadata(compaction = {}, metadata = {}) {
  return {
    request_kind: 'compaction',
    thread_id: 'thread_compact',
    turn_id: 'turn_compact',
    window_id: 'window_compact',
    compaction: {
      trigger: 'auto',
      reason: 'context_limit',
      implementation: 'responses',
      phase: 'mid_turn',
      strategy: 'memento',
      ...compaction,
    },
    ...metadata,
  };
}

function compactBody({
  stream = false,
  metadata = compactMetadata(),
  history = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Continue the current gateway task.' }] }],
  focus = CODEX_COMPACT_PROMPT,
} = {}) {
  return {
    model: 'deepseek-v4-pro',
    instructions: 'Follow the repository rules.',
    stream,
    client_metadata: {
      'x-codex-turn-metadata': JSON.stringify(metadata),
    },
    tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object', properties: {} } }],
    input: [
      ...history,
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: focus }] },
    ],
  };
}

function proxyConfig(upstreamBaseUrl, overrides = {}) {
  return {
    serverName: 'test',
    upstreamBaseUrl,
    upstreamApiKey: 'test-key',
    upstreamModel: 'deepseek-v4-flash',
    upstreamProvider: 'deepseek',
    upstreamTimeoutMs: 5000,
    modelAliases: DEFAULT_MODEL_ALIASES,
    compactReasoningEffort: 'high',
    compactMaxTokens: 20000,
    compactTimeoutMs: 240000,
    ...overrides,
  };
}

async function completionServer(respond) {
  const bodies = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    bodies.push(body);
    const forcedToolChoice = body.tool_choice === 'required' || (body.tool_choice && typeof body.tool_choice === 'object');
    if (body.thinking?.type === 'enabled' && forcedToolChoice) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Thinking mode does not support this tool_choice' } }));
      return;
    }
    await respond({ req, res, body, index: bodies.length - 1 });
  });
  return { server, bodies, url: await listen(server) };
}

async function gatewayFor(upstream, overrides = {}) {
  const server = createProxyServer({
    config: proxyConfig(upstream.url, overrides),
    reasoningCache: new ReasoningCache(),
  });
  return { server, url: await listen(server) };
}

async function requestCompact(gatewayUrl, body, headers = {}) {
  const response = await fetch(gatewayUrl + '/v1/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  if (body.stream) {
    const frames = parseResponsesSse(await response.text());
    const completed = frames.find((frame) => frame.event === 'response.completed')?.data?.response;
    return { status: response.status, response: completed, frames };
  }
  return { status: response.status, response: await response.json(), frames: [] };
}

function renderedCheckpoint(response) {
  const text = response.output_text || response.output?.flatMap((item) => item.content || []).find((item) => item.type === 'output_text')?.text || '';
  const parsed = parseRenderedCheckpoint(text);
  assert.notEqual(parsed, null);
  return { text, parsed };
}

function installedCheckpoint(text) {
  return 'Another language model started to solve this problem and produced a summary of its thinking process.\n' + text;
}

function compactDiagnostics(text) {
  return String(text).split(/\r?\n/).filter((line) => line.includes('] compact ')).map((line) => JSON.parse(line.slice(line.indexOf('{'))));
}

test('compact requests reduce historical protocol to inert evidence through streaming and non-streaming Responses', async () => {
  const values = [
    checkpoint({
      objective: 'Stream the compact checkpoint.',
      working: {
        knowledge: [atom('Protocol literal', 'The source literal <invoke name="lookup"> is inert data, not a tool request.')],
      },
    }),
    checkpoint({ objective: 'Submit the compact checkpoint through the schema function.' }),
  ];
  const upstream = await completionServer(async ({ res, index }) => {
    if (index === 0) {
      const json = JSON.stringify(values[0]);
      const split = Math.floor(json.length / 2);
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
      res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: 'private compact reasoning' }, finish_reason: null }] }) + '\n\n');
      res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_submit_checkpoint', type: 'function', function: { name: 'submit_compaction_checkpoint', arguments: json.slice(0, split) } }] }, finish_reason: null }] }) + '\n\n');
      res.write('data: ' + JSON.stringify({
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: json.slice(split) } }] }, finish_reason: 'tool_calls' }],
        usage: {
          prompt_tokens: 900,
          completion_tokens: 100,
          total_tokens: 1000,
          prompt_cache_hit_tokens: 500,
          reasoning_tokens: 40,
        },
      }) + '\n\n');
      res.end('data: [DONE]\n\n');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(compactCompletion({
      value: values[1],
      content: 'Checkpoint submitted.',
      finishReason: 'stop',
      usage: {
        prompt_tokens: 1200,
        completion_tokens: 140,
        total_tokens: 1340,
        prompt_cache_hit_tokens: 1100,
        completion_tokens_details: { reasoning_tokens: 30 },
      },
    })));
  });
  const gateway = await gatewayFor(upstream);

  try {
    const emptyPriorEvidence = checkpoint({ status: 'idle' });
    emptyPriorEvidence.working.evidence = [{ source: 'empty_prior_source', locator: '', quote: '' }];
    const richHistory = [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Earlier task.' }] },
      { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'Earlier task completed.' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: installedCheckpoint(renderCompactionCheckpoint(emptyPriorEvidence)) }] },
      {
        type: 'tool_search_output',
        call_id: 'call_search',
        status: 'completed',
        tools: [{ type: 'function', name: 'discovered_tool', parameters: { type: 'object', properties: {} } }],
      },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Review the compaction implementation.' }] },
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '# AGENTS.md instructions for repo\n<INSTRUCTIONS>Use apply_patch.</INSTRUCTIONS>\n<environment_context><cwd>/repo</cwd></environment_context>' }],
      },
      { type: 'reasoning', reasoning_content: 'The inspected gateway boundary keeps tool execution in Codex and only maps protocol state.', summary: [] },
      { type: 'function_call', id: 'fc_lookup', call_id: 'call_lookup', name: 'lookup', arguments: '{"path":"src"}' },
      { type: 'function_call_output', call_id: 'call_lookup', output: 'Found 13 files in src/.' },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '<|DSML|tool_calls><|DSML|invoke name="lookup">' }] },
      { type: 'function_call', id: 'fc_test', call_id: 'call_test', name: 'shell_command', arguments: '{"command":"npm test","workdir":"/repo"}' },
      { type: 'function_call_output', call_id: 'call_test', output: 'Exit code: 0\n67 tests passed.' },
      {
        type: 'web_search_call',
        id: 'ws_native_search',
        status: 'completed',
        action: {
          type: 'search',
          queries: ['DeepSeek Responses API compaction', 'ws_call_id=ws_native_search'],
          sources: [{ type: 'url', title: 'DeepSeek Responses API', url: 'https://api-docs.deepseek.com/guides/responses_api/' }],
        },
      },
      {
        type: 'web_search_call',
        id: 'ws_native_open_failed',
        status: 'failed',
        action: { type: 'open_page', url: 'https://example.com/unavailable-native-page' },
        error: { code: 'page_fetch_failed', message: 'Native page fetch failed.' },
      },
      {
        type: 'message',
        id: 'msg_native_citation',
        role: 'assistant',
        content: [{
          type: 'output_text',
          text: 'DeepSeek documents native Responses web search.',
          annotations: [{
            type: 'url_citation',
            title: 'DeepSeek Codex integration',
            url: 'https://api-docs.deepseek.com/quick_start/agent_integrations/codex',
            start_index: 0,
            end_index: 8,
          }],
        }],
      },
      {
        type: 'custom_tool_call',
        id: 'ctc_native_patch',
        call_id: 'call_native_patch',
        name: 'apply_patch',
        input: '*** Begin Patch\n*** Update File: src/native-compact.js\n@@\n-old\n+new\n*** End Patch',
      },
      { type: 'custom_tool_call_output', call_id: 'call_native_patch', output: 'Done!' },
      { type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'Verified the shared compact bridge behavior and preserved the remaining task boundary.' }] },
    ];
    for (let index = 0; index < 3; index += 1) {
      const callId = `call_read_${index}`;
      richHistory.push(
        { type: 'reasoning', reasoning_content: `Inspection conclusion ${index}: preserve the verified protocol boundary.`, summary: [] },
        { type: 'function_call', id: `fc_read_${index}`, call_id: callId, name: 'shell_command', arguments: JSON.stringify({ command: `Get-Content src/file-${index}.js`, workdir: '/repo' }) },
        { type: 'function_call_output', call_id: callId, output: `Representative source content for file ${index}.` },
      );
    }
    const streamed = await requestCompact(gateway.url, compactBody({ stream: true, history: richHistory }), {
      'x-codex-turn-metadata': JSON.stringify({ request_kind: 'turn' }),
    });
    assert.equal(streamed.status, 200);
    const streamedCheckpoint = renderedCheckpoint(streamed.response);
    assert.equal(streamedCheckpoint.parsed.execution.objective, 'Stream the compact checkpoint.');
    assert.match(streamedCheckpoint.parsed.working.knowledge[0].detail, /⟦invoke name="lookup"⟧/);
    assert.equal(streamedCheckpoint.parsed.working.knowledge[0].detail.includes('<invoke'), false);
    assert.equal(JSON.stringify(streamed.response).includes('private compact reasoning'), false);
    assert.equal(streamed.frames.some((frame) => frame.event?.startsWith('response.reasoning')), false);
    assert.deepEqual(streamed.response.usage, {
      input_tokens: 900,
      input_tokens_details: { cached_tokens: 500 },
      output_tokens: 100,
      output_tokens_details: { reasoning_tokens: 40 },
      total_tokens: 1000,
    });

    const nonStreaming = await requestCompact(gateway.url, compactBody({
      metadata: compactMetadata({ phase: 'standalone_turn', trigger: 'manual' }),
      history: richHistory,
      focus: 'Preserve file changes and unresolved test failures.',
    }));
    assert.equal(nonStreaming.status, 200);
    assert.equal(nonStreaming.response.status, 'completed');
    assert.equal(renderedCheckpoint(nonStreaming.response).parsed.execution.objective, 'Submit the compact checkpoint through the schema function.');
    assert.deepEqual(nonStreaming.response.usage, {
      input_tokens: 1200,
      input_tokens_details: { cached_tokens: 1100 },
      output_tokens: 140,
      output_tokens_details: { reasoning_tokens: 30 },
      total_tokens: 1340,
    });

    assert.equal(upstream.bodies.length, 2);
    for (const request of upstream.bodies) {
      assert.equal(request.stream, true);
      assert.equal(request.max_tokens, undefined);
      assert.equal(request.response_format, undefined);
      assert.deepEqual(request.thinking, { type: 'enabled' });
      assert.equal(request.reasoning_effort, 'high');
      assert.equal(request.tools.length, 1);
      assert.equal(request.tools[0].function.name, 'submit_compaction_checkpoint');
      assert.match(request.tools[0].function.description, /never submit an empty object/);
      assert.deepEqual(request.tools[0].function.parameters.required, ['execution', 'working', 'memory']);
      assert.match(request.tools[0].function.parameters.description, /one canonical home/);
      assert.match(request.tools[0].function.parameters.description, /both resolved and unresolved/);
      const checkpointSchema = request.tools[0].function.parameters.properties;
      assert.match(checkpointSchema.execution.properties.acceptance.description, /real user instructions/);
      assert.match(checkpointSchema.execution.properties.next.description, /Do not list later steps/);
      assert.match(checkpointSchema.working.properties.artifacts.description, /no files modified/);
      assert.match(checkpointSchema.working.properties.knowledge.description, /premise/);
      assert.match(checkpointSchema.working.properties.knowledge.description, /minimal dependency reference is allowed/);
      assert.match(checkpointSchema.working.properties.verification.description, /Source reading or search activity is not verification/);
      assert.match(checkpointSchema.working.properties.risks.description, /disconfirming condition/);
      assert.match(checkpointSchema.memory.properties.session.description, /Task-specific authorization/);
      assert.match(checkpointSchema.memory.properties.session.description, /current-task implication/);
      assert.equal(Object.hasOwn(request, 'tool_choice'), false);
      assert.equal(request.messages[0].role, 'system');
      assert.match(request.messages[0].content, /framework-owned context checkpoint reducer/);
      assert.match(request.messages[0].content, /not an agent turn/);
      assert.equal(request.messages.at(-1).content.includes(CODEX_COMPACT_PROMPT), false);
      assert.match(request.messages[0].content, /Call the provided function exactly once/);
      assert.match(request.messages.at(-1).content, /never the bare reading or compaction activity/);
      assert.match(request.messages.at(-1).content, /Deterministic coverage inventory/);
      assert.equal(request.messages.some((message) => message.role === 'tool'), false);
      assert.equal(request.messages.some((message) => Array.isArray(message.tool_calls)), false);
      assert.equal(request.messages.some((message) => Object.hasOwn(message, 'reasoning_content')), false);
    }
    const historyText = upstream.bodies[0].messages.slice(1, -1).map((message) => String(message.content || '')).join('\n');
    assert.match(historyText, /Review the compaction implementation/);
    assert.equal(historyText.includes('AGENTS.md instructions'), false);
    assert.equal(historyText.includes('Found 13 files'), false);
    assert.equal(historyText.includes('can be called directly'), false);
    assert.equal(historyText.includes('"operation":"lookup"'), false);
    assert.match(upstream.bodies[0].messages.at(-1).content, /lookup/);
    assert.match(upstream.bodies[0].messages.at(-1).content, /"recovery":"locator"/);
    assert.match(upstream.bodies[0].messages.at(-1).content, /DeepSeek Responses API compaction/);
    assert.match(upstream.bodies[0].messages.at(-1).content, /ws_call_id=ws_native_search/);
    assert.match(upstream.bodies[0].messages.at(-1).content, /unavailable-native-page/);
    assert.match(upstream.bodies[0].messages.at(-1).content, /page_fetch_failed/);
    assert.match(upstream.bodies[0].messages.at(-1).content, /DeepSeek Codex integration/);
    assert.match(upstream.bodies[0].messages.at(-1).content, /agent_integrations\/codex/);
    assert.match(upstream.bodies[0].messages.at(-1).content, /src\/native-compact\.js/);
    assert.equal(upstream.bodies[0].messages.at(-1).content.includes('empty_prior_source'), false);
    assert.match(historyText, /67 tests passed/);
    assert.match(historyText, /Verified the shared compact bridge behavior/);
    assert.match(historyText, /inspected gateway boundary keeps tool execution in Codex/);
    assert.match(historyText, /Inspection conclusion 2/);
    assert.equal(historyText.includes('Representative source content'), false);
    assert.equal(historyText.includes('anchor truncated'), false);
    assert.equal(historyText.includes('<|DSML|tool_calls>'), false);
    assert.match(historyText, /DeepSeek Responses API compaction/);
    assert.match(historyText, /Failed to open page/);
    assert.match(upstream.bodies[1].messages.at(-1).content, /retention priority/);
    assert.match(upstream.bodies[1].messages.at(-1).content, /DeepSeek Codex integration/);

    const invalid = await requestCompact(gateway.url, {
      ...compactBody(),
      input: [],
    });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.response.error.code, 'invalid_compaction_request');

    const missingInput = await requestCompact(gateway.url, {
      ...compactBody(),
      input: undefined,
    });
    assert.equal(missingInput.status, 400);
    assert.equal(missingInput.response.error.code, 'invalid_compaction_request');

    const malformedMetadata = compactBody();
    malformedMetadata.client_metadata['x-codex-turn-metadata'] = '{';
    const malformed = await requestCompact(gateway.url, malformedMetadata);
    assert.equal(malformed.status, 400);
    assert.equal(malformed.response.error.code, 'invalid_compaction_request');

    const missingPhase = await requestCompact(gateway.url, compactBody({
      metadata: { ...compactMetadata(), compaction: { trigger: 'auto', reason: 'context_limit', implementation: 'responses', strategy: 'memento' } },
    }));
    assert.equal(missingPhase.status, 400);
    assert.equal(missingPhase.response.error.code, 'invalid_compaction_request');
  } finally {
    await close(gateway.server);
    await close(upstream.server);
  }
});

test('successive compactions preserve conclusion continuity, age file state, and do not revive delivered work', async () => {
  const artifact = atom('src/compaction.js', 'Modified; execution remains the sole agenda.');
  const firstTask = checkpoint({
    taskId: 'task_model_first',
    objective: 'Review the compaction implementation.',
    next: 'Fix the lifecycle and run the focused tests.',
    working: {
      artifacts: [artifact],
      knowledge: [atom('Task lifecycle', 'Completed work must not retain executable objectives.', ['E3', 'E1'])],
      risks: [atom('npm test', 'The compact tests still fail.', ['E2'])],
    },
    memory: {
      session: [atom('compact boundary', 'Keep the compact boundary explicit.')],
      durable: [atom('PowerShell document rendering', 'Chinese design documents render as mojibake in this shell.', ['E3'])],
    },
  });
  const secondTask = checkpoint({
    taskId: 'task_model_drift',
    objective: 'Review the compaction implementation.',
    acceptance: ['Preserve the inspected findings.', 'Run the focused compact tests.'],
    next: 'Run the focused compact tests.',
    working: {
      artifacts: [artifact],
      knowledge: [atom('Task lifecycle', 'The lifecycle fix is implemented.')],
      verification: [atom('npm test', 'The full test suite now passes.', ['e2'])],
    },
  });
  const thirdTask = checkpoint({
    taskId: 'task_model_drift_again',
    objective: 'Review the compaction implementation.',
    acceptance: ['Verify the packaged gateway.'],
    next: 'Verify the packaged gateway.',
    working: { artifacts: [artifact] },
  });
  const delivered = checkpoint({
    status: 'idle',
    memory: {
      durable: Array.from({ length: 40 }, (_, index) => atom(`completed task ${index}`, `Memory ${index}: ${'high-value detail '.repeat(140)}`)),
    },
  });
  const attemptedRevival = checkpoint({ objective: 'Restart work that was already delivered.' });
  const prematureIdle = checkpoint({ status: 'idle' });
  const candidates = [firstTask, secondTask, thirdTask, delivered, attemptedRevival, prematureIdle];
  const upstream = await completionServer(async ({ res, index }) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(compactCompletion({ value: candidates[index] })));
  });
  const gateway = await gatewayFor(upstream);

  try {
    const taskRun = await requestCompact(gateway.url, compactBody({
      history: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Review the compaction implementation.' }] },
        {
          type: 'function_call',
          id: 'fc_patch',
          call_id: 'call_patch',
          name: 'apply_patch',
          arguments: JSON.stringify({ input: '*** Begin Patch\n*** Update File: src/compaction.js\n@@\n-old\n+new\n*** End Patch' }),
        },
        { type: 'function_call_output', call_id: 'call_patch', output: 'Done!' },
        { type: 'function_call', id: 'fc_test', call_id: 'call_test', name: 'shell_command', arguments: '{"command":"npm test"}' },
        { type: 'function_call_output', call_id: 'call_test', output: 'Exit code: 1\n2 compact tests failed.' },
        { type: 'function_call', id: 'fc_read', call_id: 'call_read', name: 'shell_command', arguments: '{"command":"Get-Content src/compaction.js"}' },
        { type: 'function_call_output', call_id: 'call_read', output: 'Current compact reducer source includes https://api.deepseek.com as a configuration value.' },
        {
          type: 'function_call',
          id: 'fc_failed_patch',
          call_id: 'call_failed_patch',
          name: 'apply_patch',
          arguments: JSON.stringify({ input: '*** Begin Patch\n*** Update File: src/not-changed.js\n@@\n-old\n+new\n*** End Patch' }),
        },
        {
          type: 'function_call_output',
          call_id: 'call_failed_patch',
          output: 'apply_patch verification failed: Failed to find expected lines in src/not-changed.js:\nold',
        },
      ],
    }));
    const first = renderedCheckpoint(taskRun.response);
    assert.equal(first.parsed.execution.objective, 'Review the compaction implementation.');
    assert.equal(first.parsed.working.artifacts.some((item) => item.subject === 'src/compaction.js'), true);
    assert.equal(first.parsed.working.artifacts.some((item) => item.subject === 'src/not-changed.js'), false);
    assert.equal(first.parsed.working.risks.some((item) => item.evidence_refs.includes('call_test')), true);
    assert.match(first.parsed.working.evidence.find((item) => item.source === 'call_test')?.locator || '', /npm test/);
    assert.match(first.parsed.working.evidence.find((item) => item.source === 'call_test')?.quote || '', /2 compact tests failed/);
    const firstKnowledge = first.parsed.working.knowledge.find((item) => item.subject === 'Task lifecycle');
    assert.deepEqual(firstKnowledge.evidence_refs, ['call_read']);
    assert.equal(firstKnowledge.detail, 'Completed work must not retain executable objectives.');
    const readLocator = first.parsed.working.evidence.find((item) => item.source === 'call_read')?.locator || '';
    assert.match(readLocator, /Get-Content src\/compaction\.js/);
    assert.equal(readLocator.includes('https://api.deepseek.com'), false);
    assert.deepEqual(first.parsed.working.evidence.map((item) => item.source).sort(), ['call_read', 'call_test']);
    assert.equal(first.parsed.memory.session.some((item) => item.detail === 'Keep the compact boundary explicit.'), true);
    assert.equal(first.parsed.memory.durable.some((item) => item.subject === 'PowerShell document rendering'), false);
    assert.match(upstream.bodies[0].messages.at(-1).content, /"ref":"e2"/);
    assert.equal(upstream.bodies[0].messages.at(-1).content.includes('call_test'), false);
    assert.match(upstream.bodies[0].messages.at(-1).content, /"artifacts":\["src\/compaction\.js"\]/);
    assert.match(upstream.bodies[0].messages.at(-1).content, /apply_patch verification failed/);

    const secondRun = await requestCompact(gateway.url, compactBody({
      history: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Review the compaction implementation.' }] },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: installedCheckpoint(first.text) }] },
        { type: 'function_call', id: 'fc_test_recheck', call_id: 'call_test', name: 'shell_command', arguments: '{"command":"npm test"}' },
        { type: 'function_call_output', call_id: 'call_test', output: 'Exit code: 0\n67 tests passed.' },
      ],
    }));
    const second = renderedCheckpoint(secondRun.response);
    assert.equal(second.parsed.execution.task_id, first.parsed.execution.task_id);
    assert.equal(second.parsed.working.knowledge.find((item) => item.subject === 'Task lifecycle')?.detail, 'The lifecycle fix is implemented.');
    assert.match(second.parsed.working.verification.find((item) => item.subject === 'npm test')?.detail || '', /passes/);
    assert.equal(second.parsed.working.evidence.filter((item) => item.source === 'call_test').length, 1);
    assert.match(second.parsed.working.evidence.find((item) => item.source === 'call_test')?.quote || '', /67 tests passed/);
    assert.equal(second.parsed.working.evidence.some((item) => item.quote.includes('2 compact tests failed')), false);
    assert.match(second.parsed.working.artifacts[0].detail, /execution remains the sole agenda/);
    assert.match(second.parsed.working.artifacts[0].detail, /Rehydrate from/);
    assert.equal(second.parsed.memory.session.some((item) => item.detail === 'Keep the compact boundary explicit.'), true);

    const thirdRun = await requestCompact(gateway.url, compactBody({
      history: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Review the compaction implementation.' }] },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: installedCheckpoint(second.text) }] },
      ],
    }));
    const third = renderedCheckpoint(thirdRun.response);
    assert.equal(third.parsed.execution.task_id, first.parsed.execution.task_id);
    assert.equal(third.parsed.working.knowledge.some((item) => item.subject === 'Task lifecycle'), false);
    assert.match(third.parsed.working.artifacts[0].detail, /^Rehydrate from/);
    assert.equal(third.parsed.working.artifacts[0].detail.includes('execution remains the sole agenda'), false);

    const deliveredRun = await requestCompact(gateway.url, compactBody({
      metadata: compactMetadata({ phase: 'standalone_turn' }),
      history: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Review the compaction implementation.' }] },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: installedCheckpoint(third.text) }] },
        { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'The requested compaction work is complete.' }] },
      ],
    }));
    const completed = renderedCheckpoint(deliveredRun.response).parsed;
    assert.equal(completed.execution.status, 'idle');
    assert.equal(completed.execution.objective, '');
    assert.equal(completed.memory.durable.length < 40, true);
    assert.equal(completed.memory.durable.some((item) => item.subject === 'completed task 39'), true);

    const revivalRun = await requestCompact(gateway.url, compactBody({
      metadata: compactMetadata({ phase: 'standalone_turn' }),
      history: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Review the compaction implementation.' }] },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: installedCheckpoint(renderedCheckpoint(deliveredRun.response).text) }] },
      ],
    }));
    const idle = renderedCheckpoint(revivalRun.response).parsed.execution;
    assert.equal(idle.status, 'idle');
    assert.equal(idle.task_id, '');
    assert.equal(idle.next, '');

    const newTaskRun = await requestCompact(gateway.url, compactBody({
      metadata: compactMetadata({ phase: 'standalone_turn' }),
      history: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Review the compaction implementation.' }] },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: installedCheckpoint(renderedCheckpoint(deliveredRun.response).text) }] },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Start a new task after the delivered checkpoint.' }] },
      ],
    }));
    const newTask = renderedCheckpoint(newTaskRun.response).parsed.execution;
    assert.equal(newTask.status, 'active');
    assert.equal(newTask.objective, 'Continue the latest retained real user request from the current workspace state.');

    assert.equal(upstream.bodies.length, candidates.length);
    assert.equal(upstream.bodies.slice(1).every((body) => body.messages.some((message) => message.role === 'user' && String(message.content || '').includes('Review the compaction implementation.'))), true);
    assert.equal(upstream.bodies.slice(1).every((body) => body.messages.every((message) => !String(message.content || '').includes('Prior canonical checkpoint baseline'))), true);
  } finally {
    await close(gateway.server);
    await close(upstream.server);
  }
});

test('compact failure handling preserves valid state across protocol, timeout, evidence, and provider failures', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gateway-compact-recovery-'));
  const debugPath = join(dir, 'gateway.debug.log');
  const attempts = new Map();
  const upstream = await completionServer(async ({ res, body }) => {
    const text = body.messages.map((message) => String(message.content || '')).join('\n');
    const key = text.includes('Reject a malformed checkpoint submission')
      ? 'malformed'
      : text.includes('Reject a wrong checkpoint function')
        ? 'wrong_function'
        : text.includes('Recover after compact timeout')
          ? 'timeout'
          : text.includes('Reject unknown evidence handle')
            ? 'badref'
        : text.includes('Preserve changed files after an incomplete summary')
          ? 'coverage'
          : text.includes('Start a separate task after compact failure')
            ? 'new_task'
          : 'overflow';
    const attempt = (attempts.get(key) || 0) + 1;
    attempts.set(key, attempt);

    if (key === 'malformed' && attempt === 1) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(compactCompletion({
        argumentsText: '{"execution":',
      })));
      return;
    }
    if (key === 'wrong_function' && attempt === 1) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(compactCompletion({ toolName: 'shell_command' })));
      return;
    }
    if (key === 'timeout' && attempt === 1) {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { reasoning_content: 'still compacting' }, finish_reason: null }] }) + '\n\n');
      await new Promise((resolve) => setTimeout(resolve, 180));
      if (!res.destroyed && !res.writableEnded) res.end();
      return;
    }
    if (key === 'badref') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(compactCompletion({
        value: checkpoint({
          objective: 'Reject unknown evidence handle.',
          working: { knowledge: [atom('Unknown source', 'This atom must not be installed.', ['e99'])] },
        }),
      })));
      return;
    }
    if (key === 'coverage') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(compactCompletion({
        value: checkpoint({
          objective: 'Preserve changed files after an incomplete summary.',
          working: { knowledge: [atom('Patch result', 'The workspace contains the current patch result.', ['e1'])] },
        }),
      })));
      return;
    }
    if (key === 'new_task') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(compactCompletion({ argumentsText: '{}' })));
      return;
    }
    if (key === 'overflow') {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'context_length_exceeded', message: 'maximum context length exceeded' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(compactCompletion({
      value: checkpoint({
        objective: key === 'timeout'
            ? 'Continue after the compact timeout.'
            : 'Continue after an invalid checkpoint submission.',
      }),
    })));
  });
  const gateway = await gatewayFor(upstream, { debugPayload: true, debugPayloadLogPath: debugPath, compactTimeoutMs: 60 });

  try {
    const malformedRun = await requestCompact(gateway.url, compactBody({
      history: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Reject a malformed checkpoint submission.' }] }],
    }));
    assert.equal(renderedCheckpoint(malformedRun.response).parsed.execution.objective, 'Continue the latest retained real user request from the current workspace state.');

    const wrongFunctionRun = await requestCompact(gateway.url, compactBody({
      history: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Reject a wrong checkpoint function.' }] }],
    }));
    assert.equal(renderedCheckpoint(wrongFunctionRun.response).parsed.execution.objective, 'Continue the latest retained real user request from the current workspace state.');

    const timeoutRun = await requestCompact(gateway.url, compactBody({
      history: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Recover after compact timeout.' }] },
        { type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'Continue by inspecting compact stream progress.' }] },
      ],
    }));
    assert.equal(renderedCheckpoint(timeoutRun.response).parsed.execution.objective, 'Continue the latest retained real user request from the current workspace state.');
    assert.equal(renderedCheckpoint(timeoutRun.response).parsed.execution.next, 'Continue by inspecting compact stream progress.');

    const badRefRun = await requestCompact(gateway.url, compactBody({
      history: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Reject unknown evidence handle.' }] }],
    }));
    assert.equal(renderedCheckpoint(badRefRun.response).parsed.working.knowledge.some((item) => item.subject === 'Unknown source'), false);

    const prior = checkpoint({
      taskId: 'task_prior_review',
      objective: 'Finish the prior review.',
      working: { knowledge: [atom('Prior task state', 'This state must not become the new task agenda.')] },
      memory: {
        durable: [atom('Provider contract', 'The verified provider contract remains reusable across tasks.', ['call_provider_contract'])],
      },
    });
    prior.working.evidence = [{
      source: 'call_provider_contract',
      locator: 'https://api-docs.deepseek.com/api/create-chat-completion',
      quote: 'Verified provider contract.',
    }];
    const newTaskRun = await requestCompact(gateway.url, compactBody({
      history: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Finish the prior review.' }] },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: installedCheckpoint(renderCompactionCheckpoint(prior)) }] },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Start a separate task after compact failure.' }] },
      ],
    }));
    const newTask = renderedCheckpoint(newTaskRun.response).parsed;
    assert.notEqual(newTask.execution.task_id, prior.execution.task_id);
    assert.equal(newTask.working.knowledge.length, 0);
    assert.equal(newTask.memory.durable[0].subject, 'Provider contract');
    assert.equal(newTask.working.evidence[0].source, 'call_provider_contract');

    const changedHistory = [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Preserve changed files after an incomplete summary.' }] },
      {
        type: 'function_call',
        id: 'fc_patch',
        call_id: 'call_patch',
        name: 'apply_patch',
        arguments: JSON.stringify({ input: '*** Begin Patch\n*** Update File: src/compaction.js\n@@\n-old\n+new\n*** End Patch' }),
      },
      { type: 'function_call_output', call_id: 'call_patch', output: 'Done!' },
      { type: 'function_call', id: 'fc_fail', call_id: 'call_fail', name: 'shell_command', arguments: '{"command":"npm test"}' },
      { type: 'function_call_output', call_id: 'call_fail', output: 'Exit code: 1\nAssertion failed.' },
    ];
    const coverageRun = await requestCompact(gateway.url, compactBody({ history: changedHistory }));
    const normalized = renderedCheckpoint(coverageRun.response).parsed;
    assert.equal(normalized.execution.objective, 'Preserve changed files after an incomplete summary.');
    assert.equal(normalized.working.artifacts.some((item) => item.subject === 'src/compaction.js'), true);
    assert.equal(normalized.working.risks.length, 0);
    assert.equal(normalized.working.evidence.every((item) => item.quote === ''), true);

    const overflowRun = await requestCompact(gateway.url, compactBody({
      history: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Continue safely after provider context overflow.' }] },
        { type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'Continue by checking the compact metadata contract.' }] },
      ],
    }));
    const overflow = renderedCheckpoint(overflowRun.response).parsed;
    assert.equal(overflow.execution.status, 'active');
    assert.equal(overflow.execution.next, 'Continue by checking the compact metadata contract.');
    assert.equal(overflow.working.risks.length, 0);

    assert.equal(attempts.get('malformed'), 1);
    assert.equal(attempts.get('wrong_function'), 1);
    assert.equal(attempts.get('timeout'), 1);
    const malformedRequests = upstream.bodies.filter((body) => body.messages.some((message) => String(message.content || '').includes('Reject a malformed checkpoint submission')));
    assert.equal(malformedRequests.length, 1);
    const wrongFunctionRequests = upstream.bodies.filter((body) => body.messages.some((message) => String(message.content || '').includes('Reject a wrong checkpoint function')));
    assert.equal(wrongFunctionRequests.length, 1);
    const timeoutRequests = upstream.bodies.filter((body) => body.messages.some((message) => String(message.content || '').includes('Recover after compact timeout')));
    assert.equal(timeoutRequests.length, 1);

    const diagnostics = compactDiagnostics(await readFile(debugPath, 'utf8'));
    assert.equal(diagnostics.some((entry) => entry.status === 'completed' && entry.inventory_artifacts === 1 && entry.inventory_error_candidates === 1), true);
    assert.equal(diagnostics.some((entry) => entry.status === 'completed' && entry.evidence_handles_resolved > 0), true);
    assert.equal(diagnostics.some((entry) => entry.status === 'invalid' && entry.validation.includes('invalid_checkpoint_arguments')), true);
    assert.equal(diagnostics.some((entry) => entry.status === 'invalid' && entry.validation.includes('checkpoint_submission_missing')), true);
    assert.equal(diagnostics.some((entry) => entry.status === 'fallback' && entry.fallback_reason === 'referenced_evidence_dropped'), true);
    assert.equal(diagnostics.some((entry) => entry.status === 'fallback' && entry.fallback_reason === 'context_length_exceeded'), true);
    const timeoutFailure = diagnostics.find((entry) => entry.status === 'failed' && entry.error_code === 'upstream_timeout');
    assert.equal(timeoutFailure.compact_timeout_ms, 60);
    assert.equal(timeoutFailure.upstream_stage, 'reading_stream');
    assert.equal(timeoutFailure.stream_chunks > 0, true);
    assert.equal(timeoutFailure.saw_reasoning_delta, true);
    assert.equal(diagnostics.some((entry) => entry.status === 'fallback' && entry.fallback_reason === 'upstream_timeout'), true);
  } finally {
    gateway.server.closeAllConnections();
    upstream.server.closeAllConnections();
    await close(gateway.server);
    await close(upstream.server);
    await rm(dir, { recursive: true, force: true });
  }
});

test('compact diagnostics report cache effectiveness and client cancellation aborts the upstream stream', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gateway-compact-diagnostics-'));
  const debugPath = join(dir, 'gateway.debug.log');
  let resolveStreamStarted;
  let resolveStreamClosed;
  const streamStarted = new Promise((resolve) => {
    resolveStreamStarted = resolve;
  });
  const streamClosed = new Promise((resolve) => {
    resolveStreamClosed = resolve;
  });
  const upstream = await completionServer(async ({ res, body }) => {
    const text = body.messages.map((message) => String(message.content || '')).join('\n');
    if (text.includes('Disconnect while compacting')) {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { reasoning_content: 'still compacting' }, finish_reason: null }] }) + '\n\n');
      resolveStreamStarted();
      res.on('close', resolveStreamClosed);
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(compactCompletion({
      usage: {
        prompt_tokens: 16000,
        completion_tokens: 120,
        total_tokens: 16120,
        prompt_cache_hit_tokens: 12000,
        prompt_cache_miss_tokens: 4000,
      },
    })));
  });
  const gateway = await gatewayFor(upstream, { debugPayload: true, debugPayloadLogPath: debugPath });
  let clientRequest;
  let clientResponse;

  try {
    const completedRun = await requestCompact(gateway.url, compactBody({
      metadata: compactMetadata({}, { turn_id: 'turn_cache' }),
      history: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Measure compact cache usage.' }] },
        { type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'Historical analysis already consumed. '.repeat(500) }] },
        {
          type: 'web_search_call',
          id: 'ws_diagnostic',
          status: 'completed',
          action: { type: 'search', queries: ['compact diagnostics'] },
        },
        {
          type: 'message',
          id: 'msg_diagnostic_citation',
          role: 'assistant',
          content: [{
            type: 'output_text',
            text: 'Cited diagnostic source.',
            annotations: [{ type: 'url_citation', title: 'Diagnostic source', url: 'https://example.com/diagnostic' }],
          }],
        },
      ],
    }));
    assert.equal(completedRun.status, 200);
    assert.equal(renderedCheckpoint(completedRun.response).parsed.execution.status, 'active');

    clientResponse = await new Promise((resolve, reject) => {
      const body = JSON.stringify(compactBody({
        stream: true,
        metadata: compactMetadata({}, { turn_id: 'turn_disconnect' }),
        history: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Disconnect while compacting.' }] }],
      }));
      const target = new URL(gateway.url + '/v1/responses');
      clientRequest = http.request({
        host: target.hostname,
        port: target.port,
        path: target.pathname,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
      }, resolve);
      clientRequest.on('error', reject);
      clientRequest.end(body);
    });
    await streamStarted;
    await new Promise((resolve) => clientResponse.once('data', resolve));
    clientResponse.destroy();
    await Promise.race([
      streamClosed,
      new Promise((_, reject) => setTimeout(() => reject(new Error('upstream compact stream stayed open')), 2000)),
    ]);

    let diagnostics = [];
    for (let attempt = 0; attempt < 20; attempt += 1) {
      diagnostics = compactDiagnostics(await readFile(debugPath, 'utf8'));
      if (diagnostics.some((entry) => entry.turn_id === 'turn_disconnect' && entry.status === 'aborted')) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const completed = diagnostics.find((entry) => entry.turn_id === 'turn_cache' && entry.status === 'completed');
    assert.equal(completed.cache_hit_tokens, 12000);
    assert.equal(completed.cache_miss_tokens, 4000);
    assert.equal(completed.cache_hit_ratio, 0.75);
    assert.equal(completed.fixed_prefix_tokens > completed.estimated_installed_tokens, true);
    assert.equal(completed.window_reduction > 10, true);
    assert.equal(completed.prior_checkpoint, 'none');
    assert.equal(completed.responses_item_evidence, 2);
    assert.equal(completed.responses_web_search_calls, 1);
    assert.equal(completed.responses_url_citations, 1);
    assert.equal(diagnostics.some((entry) => entry.turn_id === 'turn_disconnect' && entry.status === 'aborted'), true);
  } finally {
    clientRequest?.destroy();
    clientResponse?.destroy();
    gateway.server.closeAllConnections();
    upstream.server.closeAllConnections();
    await close(gateway.server);
    await close(upstream.server);
    await rm(dir, { recursive: true, force: true });
  }
});
