import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import {
  CODEX_COMPACT_PROMPT,
  createCompactionPlan,
  parseRenderedCheckpoint,
  readCodexCompactionMetadata,
  renderCompactionCheckpoint,
  runCompactionPlan,
  validateCompactionCompletion,
} from '../src/compaction.js';
import { DEFAULT_MODEL_ALIASES } from '../src/model-map.js';
import { normalizeResponsesRequest, toChatCompletionsRequest } from '../src/protocol.js';
import { ReasoningCache } from '../src/reasoning-cache.js';
import { createProxyServer } from '../src/server.js';

async function scenario(name, run) {
  try {
    await run();
  } catch (error) {
    error.message = name + ': ' + error.message;
    throw error;
  }
}

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

function checkpoint(overrides = {}) {
  return {
    objective: 'Complete the gateway compaction path.',
    observations: [],
    state: 'The implementation is present and still needs release verification.',
    completed: [{ task: 'Review the design.', result: 'Confirmed Codex owns history replacement.' }],
    in_progress: [{ task: 'Verify compaction.', done: 'Reviewed the request mapping.', remaining: 'Run the gateway tests.' }],
    lessons: [],
    constraints: 'Keep the gateway stateless and preserve raw reasoning only in the bounded cache.',
    next: 'Run the focused tests and inspect the packaged path.',
    ...overrides,
  };
}

function compactJsonCompletion({
  value = checkpoint(),
  content = JSON.stringify(value),
  finishReason = 'stop',
  toolCalls,
  refusal,
  choices,
  usage = { prompt_tokens: 900, completion_tokens: 100, total_tokens: 1000 },
} = {}) {
  const message = { role: 'assistant', content };
  if (toolCalls !== undefined) message.tool_calls = toolCalls;
  if (refusal !== undefined) message.refusal = refusal;
  return {
    id: 'chatcmpl_compact',
    object: 'chat.completion',
    created: 123,
    model: 'deepseek-v4-pro',
    choices: choices ?? [{ index: 0, message, finish_reason: finishReason }],
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
  stream = true,
  metadata = compactMetadata(),
  history = [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Inspect the gateway and preserve the current progress.' }] },
    { type: 'function_call_output', call_id: 'call_lookup', output: '{"status":"working"}' },
  ],
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
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: CODEX_COMPACT_PROMPT }] },
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
    compactReasoningEffort: 'max',
    compactMaxTokens: 20000,
    ...overrides,
  };
}

function planFor(rawRequest, metadata = compactMetadata(), config = {}) {
  const normalized = normalizeResponsesRequest(rawRequest);
  const chatRequest = toChatCompletionsRequest(normalized);
  return createCompactionPlan({
    rawRequest,
    normalized,
    chatRequest,
    metadata,
    config: proxyConfig(config.upstreamBaseUrl, config),
  });
}

async function completionServer(respond) {
  const bodies = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    bodies.push(body);
    await respond({ req, res, body, index: bodies.length - 1 });
  });
  return { server, bodies, url: await listen(server) };
}

test('compaction planning and checkpoint contract', async () => {
  await scenario('recognizes only explicit Codex metadata', () => {
    const canonical = readCodexCompactionMetadata({
      client_metadata: {
        'x-codex-turn-metadata': JSON.stringify({ request_kind: 'turn' }),
      },
    }, {
      'x-codex-turn-metadata': JSON.stringify(compactMetadata()),
    });
    assert.deepEqual(
      { source: canonical.source, isCompaction: canonical.isCompaction, malformed: canonical.malformed },
      { source: 'client_metadata', isCompaction: false, malformed: false },
    );

    const malformed = readCodexCompactionMetadata({
      client_metadata: { 'x-codex-turn-metadata': '{' },
      input: CODEX_COMPACT_PROMPT,
    }, {
      'x-codex-turn-metadata': JSON.stringify(compactMetadata()),
    });
    assert.equal(malformed.source, 'client_metadata');
    assert.equal(malformed.isCompaction, false);
    assert.equal(malformed.malformed, true);
    assert.equal(readCodexCompactionMetadata({ input: CODEX_COMPACT_PROMPT }).isCompaction, false);
  });

  await scenario('turns a realistic Codex replay into one inert JSON Output request', () => {
    const priorCheckpoint = 'Another language model started to solve this problem and produced a summary of its thinking process.\n# Context Checkpoint';
    const rawRequest = compactBody({
      history: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Earlier task.' }] },
        { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'Earlier task completed.' }] },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: priorCheckpoint }] },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Review the compaction implementation.' }] },
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '# AGENTS.md instructions for repo\n<INSTRUCTIONS>Use apply_patch.</INSTRUCTIONS>\n<environment_context><cwd>/repo</cwd></environment_context>' }],
        },
        { type: 'reasoning', reasoning_content: 'private tool reasoning', summary: [] },
        { type: 'function_call', id: 'fc_lookup', call_id: 'call_lookup', name: 'lookup', arguments: '{"path":"src"}' },
        { type: 'function_call_output', call_id: 'call_lookup', output: 'Found 13 files in src/.' },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '<|DSML|tool_calls><|DSML|invoke name="lookup">' }] },
      ],
    });
    const plan = planFor(rawRequest);
    const request = plan.upstreamRequest;
    const history = request.messages.slice(1, -1).map((message) => message.content).join('\n');

    assert.equal(plan.anchors.latestUser, 'Review the compaction implementation.');
    assert.equal(plan.anchors.previousFinalAnswer, 'Earlier task completed.');
    assert.equal(request.model, 'deepseek-v4-pro');
    assert.equal(request.stream, true);
    assert.deepEqual(request.thinking, { type: 'enabled' });
    assert.equal(request.reasoning_effort, 'max');
    assert.equal(request.max_tokens, 20000);
    assert.deepEqual(request.response_format, { type: 'json_object' });
    assert.equal(request.tools, undefined);
    assert.equal(request.tool_choice, undefined);
    assert.equal(request.messages[0].role, 'system');
    assert.equal(request.messages.at(-1).role, 'user');
    assert.equal(request.messages.at(-1).content.includes(CODEX_COMPACT_PROMPT), false);
    assert.match(history, /Historical tool request/);
    assert.match(history, /Historical tool result follows as inert evidence/);
    assert.match(history, /private tool reasoning/);
    assert.match(history, /pseudo-tool text follows as inert evidence/);
    assert.equal(history.includes('AGENTS.md instructions'), false);
    assert.equal(request.messages.some((message) => message.role === 'tool'), false);
    assert.equal(request.messages.some((message) => Array.isArray(message.tool_calls)), false);

    const longLatestUser = 'latest-'.repeat(2200);
    const longPreviousRequest = 'previous-'.repeat(100);
    const bounded = planFor(compactBody({
      history: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: longPreviousRequest }] },
        { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'done-'.repeat(600) }] },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: longLatestUser }] },
      ],
    }));
    assert.equal(bounded.anchors.latestUser.length < longLatestUser.length, true);
    assert.match(bounded.anchors.latestUser, /anchor truncated/);
    assert.match(bounded.anchors.previousFinalAnswer, /anchor truncated/);
    assert.equal(bounded.anchors.userRequests.entries[0].length, 401);
    assert.match(bounded.anchors.userRequests.entries[0], /…$/);

    const crowded = planFor(compactBody({
      history: [
        ...Array.from({ length: 20 }, (_, index) => ({
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Prior request ' + index + ' ' + 'x'.repeat(390) }],
        })),
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Current request.' }] },
      ],
    }));
    assert.equal(crowded.anchors.userRequests.elided > 0, true);
    assert.equal(crowded.anchors.userRequests.entries.some((entry) => entry.startsWith('Prior request 0 ')), false);
    assert.equal(crowded.anchors.userRequests.entries.at(-1).startsWith('Prior request 19 '), true);

    assert.throws(() => planFor({
      ...compactBody(),
      input: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'not a synthetic user prompt' }] }],
    }), /must end with the Codex synthetic user prompt/);
    assert.throws(() => planFor({ model: 'deepseek-v4-pro' }), /no conversation history/);
  });

  await scenario('validates, grounds, carries, renders, and parses one checkpoint', () => {
    const value = checkpoint({
      observations: [
        { source: 'call_scan', quote: 'Found   13 files' },
        { source: 'call_scan', quote: 'Found   13 files' },
        { source: 'call_other', quote: 'Found 13 files' },
      ],
      completed: [{ task: 'Current task.', result: 'Current result.' }],
      lessons: ['Current lesson.'],
    });
    const result = validateCompactionCompletion(compactJsonCompletion({ value }), 20000, {
      evidenceCorpus: [{ source: 'call_scan', content: 'Scan results:\nFound 13 files in src/.' }],
      priorCompleted: [{ task: 'Earlier task.', result: 'Earlier result.' }],
      priorLessons: ['Earlier lesson.'],
      latestUser: 'Review the gateway.',
      userRequests: { entries: ['Earlier request.'], elided: 2 },
    });

    assert.equal(result.ok, true);
    assert.equal(result.observationsDropped, 1);
    assert.equal(result.observationsDeduplicated, 1);
    assert.equal(result.completedCarried, 1);
    assert.equal(result.lessonsCarried, 1);
    assert.deepEqual(result.checkpoint.observations, [{ source: 'call_scan', quote: 'Found   13 files' }]);
    const parsed = parseRenderedCheckpoint('Another language model started to solve this problem and produced a summary of its thinking process.\n' + result.content);
    assert.notEqual(parsed, null);
    assert.equal(parsed.latestUser, 'Review the gateway.');
    assert.deepEqual(parsed.completed, [
      { task: 'Earlier task.', result: 'Earlier result.' },
      { task: 'Current task.', result: 'Current result.' },
    ]);
    assert.deepEqual(parsed.lessons, ['Earlier lesson.', 'Current lesson.']);
    assert.deepEqual(parsed.userRequests, { entries: ['Earlier request.'], elided: 2 });
    assert.match(result.content, /## Current Task/);
    assert.match(result.content, /## Observed Evidence/);
    assert.match(result.content, /## Background Memory/);
    assert.match(result.content, /Resume rule:/);
    assert.equal(parseRenderedCheckpoint(result.content.replace('- Source: call_scan', 'call_scan')), null);
    assert.equal(parseRenderedCheckpoint(result.content.replace('  Quote: Found   13 files', ' malformed quote')), null);
    assert.equal(parseRenderedCheckpoint(result.content.replace('## Next Action', '## Obsolete Next')), null);
  });

  await scenario('rejects distinct unsafe completion classes without multiplying fixtures', () => {
    const invalidCases = [
      ['empty content', compactJsonCompletion({ content: '' }), 'empty_content'],
      ['tool protocol', compactJsonCompletion({
        content: '',
        finishReason: 'tool_calls',
        toolCalls: [{ id: 'call_x', type: 'function', function: { name: 'lookup', arguments: '{}' } }],
      }), 'tool_calls'],
      ['invalid JSON', compactJsonCompletion({ content: '{' }), 'invalid_json'],
      ['pseudo tool markup', compactJsonCompletion({ content: '<|DSML|tool_calls><|DSML|invoke name="lookup">' }), 'pseudo_tool_call_content'],
      ['non-object checkpoint', compactJsonCompletion({ content: 'null' }), 'checkpoint_not_object'],
      ['missing required state', compactJsonCompletion({ content: JSON.stringify({ ...checkpoint(), next: undefined }) }), 'checkpoint_missing_next'],
      ['invalid observations collection', compactJsonCompletion({ value: { ...checkpoint(), observations: {} } }), 'observations_not_array'],
      ['invalid completed collection', compactJsonCompletion({ value: { ...checkpoint(), completed: {} } }), 'completed_not_array'],
      ['invalid progress collection', compactJsonCompletion({ value: { ...checkpoint(), in_progress: {} } }), 'in_progress_not_array'],
      ['invalid evidence shape', compactJsonCompletion({ value: { ...checkpoint(), observations: [{ source: 'call_x' }] } }), 'observations_0_missing_quote'],
      ['truncated output', compactJsonCompletion({ finishReason: 'length' }), 'finish_reason_length'],
      ['provider refusal', compactJsonCompletion({ refusal: 'unable' }), 'refusal'],
      ['multiple choices', compactJsonCompletion({
        choices: [
          compactJsonCompletion().choices[0],
          { index: 1, message: { role: 'assistant', content: '{}' }, finish_reason: 'stop' },
        ],
      }), 'expected_one_choice'],
    ];

    for (const [name, completion, reason] of invalidCases) {
      const result = validateCompactionCompletion(completion);
      assert.equal(result.ok, false, name);
      assert.equal(result.content, '', name);
      assert.equal(result.reasons.includes(reason), true, name);
    }

    const fenced = validateCompactionCompletion(compactJsonCompletion({
      content: '~~~json'.replaceAll('~', String.fromCharCode(96)) + '\n' + JSON.stringify(checkpoint()) + '\n' + '~~~'.replaceAll('~', String.fromCharCode(96)),
    }));
    assert.equal(fenced.ok, true);

    const oversized = validateCompactionCompletion(compactJsonCompletion({
      value: checkpoint({ objective: 'x'.repeat(100) }),
    }), 1);
    assert.equal(oversized.ok, false);
    assert.equal(oversized.reasons.includes('hard_limit'), true);
  });
});

test('compaction preserves durable state across consecutive checkpoints', async () => {
  const firstValue = checkpoint({
    objective: 'Review the compaction implementation.',
    observations: [{ source: 'call_scan', quote: 'Found 13 files' }],
    completed: [{ task: 'Review the design.', result: 'Confirmed the protocol boundary.' }],
    lessons: ['Do not replay checkpoint prose as evidence.'],
  });
  const secondValue = checkpoint({
    objective: 'Finish the compaction verification.',
    observations: [{ source: 'call_scan', quote: 'Found 13 files' }],
    completed: [{ task: 'Run the focused tests.', result: 'The focused path passed.' }],
    lessons: ['Keep retries bounded.'],
  });
  const upstream = await completionServer(async ({ res, index }) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(compactJsonCompletion({ value: index === 0 ? firstValue : secondValue })));
  });

  try {
    const firstRaw = compactBody({
      stream: false,
      history: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Review the compaction implementation.' }] },
        { type: 'function_call_output', call_id: 'call_scan', output: 'Found 13 files in the test directory.' },
      ],
    });
    const firstPlan = planFor(firstRaw, compactMetadata(), { upstreamBaseUrl: upstream.url });
    const first = await runCompactionPlan(firstPlan);
    const firstRendered = first.completion.choices[0].message.content;
    const installed = 'Another language model started to solve this problem and produced a summary of its thinking process.\n' + firstRendered;

    const secondRaw = compactBody({
      stream: false,
      history: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: installed }] },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Run the focused tests.' }] },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Finish the compaction verification.' }] },
      ],
    });
    const secondPlan = planFor(secondRaw, compactMetadata(), { upstreamBaseUrl: upstream.url });
    const diagnostics = [];
    const second = await runCompactionPlan(secondPlan, { onDiagnostic: (entry) => diagnostics.push(entry) });
    const parsed = parseRenderedCheckpoint(second.completion.choices[0].message.content);

    assert.equal(upstream.bodies.length, 2);
    assert.equal(second.attempt, 1);
    assert.notEqual(parsed, null);
    assert.deepEqual(parsed.observations, [{ source: 'call_scan', quote: 'Found 13 files' }]);
    assert.deepEqual(parsed.completed, [
      { task: 'Review the design.', result: 'Confirmed the protocol boundary.' },
      { task: 'Run the focused tests.', result: 'The focused path passed.' },
    ]);
    assert.deepEqual(parsed.lessons, ['Do not replay checkpoint prose as evidence.', 'Keep retries bounded.']);
    assert.equal(parsed.userRequests.entries.includes('Run the focused tests.'), true);
    assert.equal(secondPlan.upstreamRequest.messages.some((message) => message.content.includes('Prior checkpoint baseline')), true);
    assert.equal(secondPlan.evidenceCorpus.some((item) => item.content.includes('# Context Checkpoint')), false);
    assert.equal(diagnostics.at(-1).prior_checkpoint, 'parsed');
    assert.equal(diagnostics.at(-1).completed_carried, 1);
    assert.equal(diagnostics.at(-1).lessons_carried, 1);

    const corruptedRaw = compactBody({
      stream: false,
      history: [
        {
          type: 'message',
          role: 'user',
          content: [{
            type: 'input_text',
            text: 'Another language model started to solve this problem and produced a summary of its thinking process.\n# Context Checkpoint\ntruncated',
          }],
        },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Continue safely despite the damaged checkpoint.' }] },
      ],
    });
    const corruptedPlan = planFor(corruptedRaw, compactMetadata(), { upstreamBaseUrl: upstream.url });
    const corruptedDiagnostics = [];
    const recovered = await runCompactionPlan(corruptedPlan, {
      onDiagnostic: (entry) => corruptedDiagnostics.push(entry),
    });
    assert.equal(recovered.attempt, 1);
    assert.equal(corruptedPlan.anchors.priorCheckpoint.parsed, null);
    assert.equal(corruptedPlan.upstreamRequest.messages.some((message) => message.content.includes('Prior checkpoint baseline')), false);
    assert.equal(corruptedDiagnostics.at(-1).prior_checkpoint, 'unparsed');
  } finally {
    await close(upstream.server);
  }
});

test('compaction completes through real streaming and non-streaming gateway paths', async () => {
  const values = [
    checkpoint({ objective: 'Stream the compact checkpoint.' }),
    checkpoint({ objective: 'Return the compact checkpoint as JSON.', in_progress: [] }),
  ];
  const upstream = await completionServer(async ({ res, index }) => {
    if (index === 0) {
      const json = JSON.stringify(values[0]);
      const split = Math.floor(json.length / 2);
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
      res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: 'private compact reasoning' }, finish_reason: null }] }) + '\n\n');
      res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: json.slice(0, split) }, finish_reason: null }] }) + '\n\n');
      res.write('data: ' + JSON.stringify({
        choices: [{ index: 0, delta: { content: json.slice(split) }, finish_reason: 'stop' }],
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
    res.end(JSON.stringify(compactJsonCompletion({
      value: values[1],
      usage: {
        prompt_tokens: 1200,
        completion_tokens: 140,
        total_tokens: 1340,
        prompt_cache_hit_tokens: 1100,
        completion_tokens_details: { reasoning_tokens: 30 },
      },
    })));
  });
  const proxy = createProxyServer({
    config: proxyConfig(upstream.url),
    reasoningCache: new ReasoningCache(),
  });
  const proxyUrl = await listen(proxy);

  try {
    const streamed = await fetch(proxyUrl + '/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(compactBody({ stream: true })),
    });
    assert.equal(streamed.status, 200);
    const frames = parseResponsesSse(await streamed.text());
    const completed = frames.find((frame) => frame.event === 'response.completed').data.response;
    assert.equal(completed.output_text, renderCompactionCheckpoint(values[0], {
      latestUser: 'Inspect the gateway and preserve the current progress.',
    }));
    assert.equal(JSON.stringify(completed).includes('"objective"'), false);
    assert.equal(JSON.stringify(completed).includes('private compact reasoning'), false);
    assert.equal(frames.some((frame) => frame.event?.startsWith('response.reasoning')), false);
    assert.deepEqual(completed.usage, {
      input_tokens: 900,
      input_tokens_details: { cached_tokens: 500 },
      output_tokens: 100,
      output_tokens_details: { reasoning_tokens: 40 },
      total_tokens: 1000,
    });

    const nonStreaming = await fetch(proxyUrl + '/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(compactBody({
        stream: false,
        metadata: compactMetadata({ phase: 'standalone_turn', trigger: 'manual' }),
      })),
    });
    const body = await nonStreaming.json();
    assert.equal(nonStreaming.status, 200);
    assert.equal(body.status, 'completed');
    assert.equal(body.output_text, renderCompactionCheckpoint(values[1], {
      latestUser: 'Inspect the gateway and preserve the current progress.',
    }));
    assert.deepEqual(body.usage, {
      input_tokens: 1200,
      input_tokens_details: { cached_tokens: 1100 },
      output_tokens: 140,
      output_tokens_details: { reasoning_tokens: 30 },
      total_tokens: 1340,
    });

    assert.equal(upstream.bodies.length, 2);
    for (const request of upstream.bodies) {
      assert.equal(request.stream, true);
      assert.deepEqual(request.response_format, { type: 'json_object' });
      assert.equal(request.tools, undefined);
      assert.equal(request.tool_choice, undefined);
      assert.equal(request.messages.some((message) => message.role === 'tool'), false);
    }
  } finally {
    await close(proxy);
    await close(upstream.server);
  }
});

test('compaction recovery is bounded and fails closed', async () => {
  async function runSequence(completions, rawRequest = compactBody({ stream: false }), metadata = compactMetadata()) {
    const upstream = await completionServer(async ({ res, index }) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(completions[Math.min(index, completions.length - 1)]));
    });
    const plan = planFor(rawRequest, metadata, { upstreamBaseUrl: upstream.url });
    try {
      return {
        result: await runCompactionPlan(plan),
        bodies: upstream.bodies,
        plan,
      };
    } finally {
      await close(upstream.server);
    }
  }

  await scenario('quarantines protocol leakage and retries with a stable inert prefix', async () => {
    const leaked = compactJsonCompletion({
      content: '',
      finishReason: 'tool_calls',
      toolCalls: [{ id: 'call_leak', type: 'function', function: { name: 'lookup', arguments: '{}' } }],
    });
    const run = await runSequence([leaked, compactJsonCompletion()]);
    assert.equal(run.result.attempt, 2);
    assert.equal(run.bodies.length, 2);
    assert.deepEqual(run.bodies[1].messages.slice(0, -1), run.bodies[0].messages.slice(0, -1));
    assert.match(run.bodies[1].messages.at(-1).content, /emitted tool protocol/);
    assert.deepEqual(run.bodies[1].thinking, { type: 'enabled' });
  });

  await scenario('reassembles streamed native tool leakage before the bounded retry', async () => {
    const upstream = await completionServer(async ({ res, index }) => {
      if (index === 0) {
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
        res.write('data: ' + JSON.stringify({
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: 0,
                id: 'call_stream_leak',
                type: 'function',
                function: { name: 'look', arguments: '{"path":' },
              }],
            },
            finish_reason: null,
          }],
        }) + '\n\n');
        res.write('data: ' + JSON.stringify({
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{ index: 0, function: { name: 'up', arguments: '"src"}' } }],
            },
            finish_reason: 'tool_calls',
          }],
        }) + '\n\n');
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(compactJsonCompletion()));
    });
    try {
      const plan = planFor(compactBody({ stream: false }), compactMetadata(), { upstreamBaseUrl: upstream.url });
      const diagnostics = [];
      const result = await runCompactionPlan(plan, { onDiagnostic: (entry) => diagnostics.push(entry) });
      assert.equal(result.attempt, 2);
      assert.equal(upstream.bodies.length, 2);
      assert.match(upstream.bodies[1].messages.at(-1).content, /emitted tool protocol/);
      assert.equal(diagnostics[1].stream_chunks, 2);
      assert.equal(diagnostics[1].saw_tool_call_delta, true);
      assert.equal(diagnostics[1].raw_finish_reason, 'tool_calls');
    } finally {
      await close(upstream.server);
    }
  });

  await scenario('recovers once from empty content by disabling thinking', async () => {
    const run = await runSequence([
      compactJsonCompletion({ content: '' }),
      compactJsonCompletion(),
    ]);
    assert.equal(run.result.attempt, 2);
    assert.equal(run.bodies.length, 2);
    assert.deepEqual(run.bodies[1].thinking, { type: 'disabled' });
    assert.equal(run.bodies[1].reasoning_effort, undefined);
    assert.match(run.bodies[1].messages.at(-1).content, /returned empty content/);
  });

  await scenario('does not retry ordinary validation failures and stops after the bounded recovery attempt', async () => {
    let invalidCalls = 0;
    const invalidUpstream = await completionServer(async ({ res }) => {
      invalidCalls += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(compactJsonCompletion({ content: '{' })));
    });
    try {
      const invalidPlan = planFor(compactBody({ stream: false }), compactMetadata(), { upstreamBaseUrl: invalidUpstream.url });
      await assert.rejects(
        runCompactionPlan(invalidPlan),
        (error) => error.code === 'compact_validation_failed' && error.statusCode === 502,
      );
      assert.equal(invalidCalls, 1);
    } finally {
      await close(invalidUpstream.server);
    }

    let emptyCalls = 0;
    const emptyUpstream = await completionServer(async ({ res }) => {
      emptyCalls += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(compactJsonCompletion({ content: '' })));
    });
    try {
      const emptyPlan = planFor(compactBody({ stream: false }), compactMetadata(), { upstreamBaseUrl: emptyUpstream.url });
      await assert.rejects(
        runCompactionPlan(emptyPlan),
        (error) => error.code === 'compact_validation_failed',
      );
      assert.equal(emptyCalls, 2);
    } finally {
      await close(emptyUpstream.server);
    }
  });

  await scenario('enforces the mid-turn boundary without breaking standalone compaction', () => {
    const emptyProgress = compactJsonCompletion({
      value: checkpoint({ in_progress: [] }),
    });
    const midTurn = validateCompactionCompletion(emptyProgress, 20000, {
      phase: 'mid_turn',
      hasLatestUser: true,
      finalAnswerDelivered: false,
    });
    assert.equal(midTurn.ok, false);
    assert.equal(midTurn.reasons.includes('in_progress_empty_mid_turn'), true);

    const standalone = validateCompactionCompletion(emptyProgress, 20000, {
      phase: 'standalone_turn',
      hasLatestUser: true,
      finalAnswerDelivered: false,
    });
    assert.equal(standalone.ok, true);

    const delivered = validateCompactionCompletion(emptyProgress, 20000, {
      phase: 'mid_turn',
      hasLatestUser: true,
      finalAnswerDelivered: true,
    });
    assert.equal(delivered.ok, true);
  });

  await scenario('maps upstream context overflow separately from ordinary provider failure', async () => {
    const upstream = await completionServer(async ({ res }) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'context_length_exceeded', message: 'maximum context length exceeded' } }));
    });
    try {
      const plan = planFor(compactBody({ stream: false }), compactMetadata(), { upstreamBaseUrl: upstream.url });
      await assert.rejects(
        runCompactionPlan(plan),
        (error) => error.code === 'context_length_exceeded' && error.statusCode === 400 && error.upstreamStatus === 400,
      );
    } finally {
      await close(upstream.server);
    }
  });

  await scenario('surfaces streamed provider errors and compact timeouts without retrying', async () => {
    const streamError = await completionServer(async ({ res }) => {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
      res.end('data: ' + JSON.stringify({ error: { message: 'stream provider failure' } }) + '\n\n');
    });
    try {
      const plan = planFor(compactBody({ stream: false }), compactMetadata(), { upstreamBaseUrl: streamError.url });
      await assert.rejects(
        runCompactionPlan(plan),
        (error) => error.code === 'upstream_error' && error.upstreamStatus === 502,
      );
      assert.equal(streamError.bodies.length, 1);
    } finally {
      await close(streamError.server);
    }

    const timeout = await completionServer(async () => {});
    try {
      const plan = planFor(compactBody({ stream: false }), compactMetadata(), {
        upstreamBaseUrl: timeout.url,
        upstreamTimeoutMs: 30,
      });
      await assert.rejects(
        runCompactionPlan(plan),
        (error) => error.code === 'upstream_timeout' && error.statusCode === 504,
      );
      assert.equal(timeout.bodies.length, 1);
    } finally {
      timeout.server.closeAllConnections();
      await close(timeout.server);
    }
  });
});

test('compaction diagnostics stay actionable and client disconnects cancel upstream', async () => {
  await scenario('reports one correlated successful attempt and one bounded provider failure', async () => {
    const successUpstream = await completionServer(async ({ res }) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(compactJsonCompletion({
        usage: {
          prompt_tokens: 1600,
          completion_tokens: 120,
          total_tokens: 1720,
          prompt_cache_hit_tokens: 1200,
          prompt_cache_miss_tokens: 400,
        },
      })));
    });
    const successDiagnostics = [];
    try {
      const plan = planFor(compactBody({ stream: false }), compactMetadata(), { upstreamBaseUrl: successUpstream.url });
      await runCompactionPlan(plan, { onDiagnostic: (entry) => successDiagnostics.push(entry) });
      assert.equal(successDiagnostics.length, 2);
      assert.equal(successDiagnostics[0].status, 'started');
      assert.equal(successDiagnostics[1].status, 'completed');
      assert.equal(successDiagnostics[1].thread_id, 'thread_compact');
      assert.equal(successDiagnostics[1].turn_id, 'turn_compact');
      assert.equal(successDiagnostics[1].window_id, 'window_compact');
      assert.equal(successDiagnostics[1].attempt, 1);
      assert.equal(successDiagnostics[1].input_tokens, 1600);
      assert.equal(successDiagnostics[1].cache_hit_tokens, 1200);
      assert.equal(successDiagnostics[1].estimated_installed_tokens > 0, true);
      assert.equal(successDiagnostics[1].window_reduction > 0, true);
      assert.match(successDiagnostics[1].time, /^\d{4}-\d{2}-\d{2}T/);
    } finally {
      await close(successUpstream.server);
    }

    const longMessage = 'provider failure ' + 'x'.repeat(1000);
    const failureUpstream = await completionServer(async ({ res }) => {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: longMessage } }));
    });
    const failureDiagnostics = [];
    try {
      const plan = planFor(compactBody({ stream: false }), compactMetadata(), { upstreamBaseUrl: failureUpstream.url });
      await assert.rejects(
        runCompactionPlan(plan, { onDiagnostic: (entry) => failureDiagnostics.push(entry) }),
        (error) => error.code === 'upstream_error' && error.upstreamStatus === 502,
      );
      assert.equal(failureDiagnostics.length, 2);
      assert.equal(failureDiagnostics[1].status, 'failed');
      assert.equal(failureDiagnostics[1].upstream_status, 502);
      assert.equal(failureDiagnostics[1].error_message.length, 500);
      assert.match(failureDiagnostics[1].error_message, /^provider failure/);
    } finally {
      await close(failureUpstream.server);
    }
  });

  await scenario('aborts the compact upstream stream when the Responses client disconnects', async () => {
    let upstreamCalls = 0;
    let resolveStarted;
    let resolveClosed;
    const started = new Promise((resolve) => {
      resolveStarted = resolve;
    });
    const closed = new Promise((resolve) => {
      resolveClosed = resolve;
    });
    const upstreamServer = http.createServer(async (req, res) => {
      upstreamCalls += 1;
      for await (const chunk of req) void chunk;
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { reasoning_content: 'still compacting' }, finish_reason: null }] }) + '\n\n');
      resolveStarted();
      res.on('close', resolveClosed);
    });
    const upstreamUrl = await listen(upstreamServer);
    const proxy = createProxyServer({
      config: proxyConfig(upstreamUrl),
      reasoningCache: new ReasoningCache(),
    });
    const proxyUrl = await listen(proxy);
    let clientRequest;
    let clientResponse;

    try {
      clientResponse = await new Promise((resolve, reject) => {
        const body = JSON.stringify(compactBody({ stream: true }));
        const target = new URL(proxyUrl + '/v1/responses');
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
      await started;
      await new Promise((resolve) => clientResponse.once('data', resolve));
      clientResponse.destroy();
      await Promise.race([
        closed,
        new Promise((_, reject) => setTimeout(() => reject(new Error('upstream compact stream stayed open')), 2000)),
      ]);
      assert.equal(upstreamCalls, 1);
    } finally {
      clientRequest?.destroy();
      clientResponse?.destroy();
      proxy.closeAllConnections();
      upstreamServer.closeAllConnections();
      await close(proxy);
      await close(upstreamServer);
    }
  });
});
