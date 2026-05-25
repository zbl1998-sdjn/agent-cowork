import assert from 'node:assert/strict';
import test from 'node:test';
import { RunEventBus } from '../src/runtime/run-events.js';
import {
  buildDecisionTraceFromMessages,
  createRunTrace,
  replayRunTraceEvents,
} from '../src/runtime/run-trace.js';
import { runAgentChat } from '../src/kimi/agent/tool-loop.js';

test('RunTrace appends sanitized entries and publishes replayable run events', () => {
  const bus = new RunEventBus();
  const times = [
    '2026-05-25T00:00:00.000Z',
    '2026-05-25T00:00:01.000Z',
    '2026-05-25T00:00:02.000Z',
  ];
  const trace = createRunTrace({
    runId: 'run_trace_1',
    runEvents: bus,
    maxTextChars: 80,
    now: () => times.shift() || '2026-05-25T00:00:03.000Z',
  });

  trace.append({
    kind: 'model_context',
    step: 1,
    modelSaw: {
      messages: [
        { role: 'system', content: 'system api_key=sk-SYSTEMSECRET12345' },
        { role: 'user', content: 'please read note.md' },
      ],
      tools: [
        { type: 'function', function: { name: 'Read', description: 'Read files', parameters: { type: 'object' } } },
      ],
    },
  });
  trace.append({
    kind: 'tool_decision',
    step: 1,
    modelMessage: {
      reasoning_content: 'Need inspect the file before editing.',
      content: 'I will call Read.',
      tool_calls: [
        { id: 'call_1', function: { name: 'Read', arguments: JSON.stringify({ path: 'note.md', apiKey: 'sk-ARGSSECRET12345' }) } },
      ],
    },
  });
  trace.append({
    kind: 'tool_result',
    step: 1,
    callId: 'call_1',
    tool: 'Read',
    status: 'succeeded',
    result: { ok: true, text: `content ${'x'.repeat(160)} sk-RESULTSECRET12345` },
  });

  const entries = trace.replay();
  assert.equal(entries.length, 3);
  assert.equal(entries[0].traceSeq, 1);
  assert.equal(entries[0].kind, 'model_context');
  assert.equal(entries[0].modelSaw.messages[0].content, 'system api_key=[REDACTED]');
  assert.equal(entries[1].kind, 'tool_decision');
  assert.equal(entries[1].decisions[0].tool, 'Read');
  assert.equal(entries[1].decisions[0].args.apiKey, '[REDACTED]');
  assert.match(entries[1].why, /Need inspect/);
  assert.equal(entries[2].result.truncated, true);
  assert.ok(!JSON.stringify(entries).includes('SECRET'), 'trace leaked a secret');

  const runTraceEvents = bus.replay('run_trace_1', 0);
  assert.equal(runTraceEvents.length, 3);
  assert.deepEqual(replayRunTraceEvents(runTraceEvents), entries);
});

test('buildDecisionTraceFromMessages links model context, tool decisions, why text, and results', () => {
  const trace = buildDecisionTraceFromMessages({
    runId: 'run_messages_1',
    messages: [
      { role: 'system', content: 'You are an agent.' },
      { role: 'user', content: 'Inspect package.json before editing.' },
      {
        role: 'assistant',
        reasoning_content: 'Need read the manifest first.',
        content: 'Reading package.json.',
        tool_calls: [
          { id: 'call_read', function: { name: 'Read', arguments: JSON.stringify({ path: 'package.json' }) } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_read', content: '{"ok":true,"text":"package content"}' },
      { role: 'assistant', content: 'Done.' },
    ],
  });

  assert.equal(trace.length, 1);
  const step = trace[0];
  assert.equal(step.kind, 'decision_step');
  assert.equal(step.runId, 'run_messages_1');
  assert.equal(step.step, 1);
  assert.deepEqual(step.modelSaw.messages.map((message) => message.role), ['system', 'user']);
  assert.equal(step.decisions[0].callId, 'call_read');
  assert.equal(step.decisions[0].tool, 'Read');
  assert.deepEqual(step.decisions[0].args, { path: 'package.json' });
  assert.match(step.decisions[0].why, /Need read the manifest/);
  assert.equal(step.results[0].callId, 'call_read');
  assert.equal(step.results[0].status, 'succeeded');
  assert.equal(step.results[0].result.ok, true);
});

test('runAgentChat publishes model context, tool decisions, and tool results to RunTrace', async () => {
  const bus = new RunEventBus();
  const runId = 'run_trace_live';
  const runTrace = createRunTrace({ runId, runEvents: bus, maxTextChars: 160 });
  let callCount = 0;

  const result = await runAgentChat({
    prompt: 'Read note.md before answering.',
    trustedRoot: process.cwd(),
    kimiConfig: { model: 'test-model' },
    runId,
    runEvents: bus,
    runTrace,
    tools: [{
      name: 'ReadNote',
      description: 'Read a note file.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, apiKey: { type: 'string' } },
        required: ['path'],
      },
      handler: async (args) => ({ ok: true, text: `read ${args.path} with sk-RESULTSECRET12345` }),
    }],
    modelCall: async () => {
      callCount += 1;
      if (callCount === 1) {
        return {
          content: 'I will read the note.',
          reasoning_content: 'Need inspect note.md first.',
          tool_calls: [{
            id: 'call_read_note',
            function: {
              name: 'ReadNote',
              arguments: JSON.stringify({ path: 'note.md', apiKey: 'sk-ARGSECRET12345' }),
            },
          }],
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
        };
      }
      return {
        content: 'Done.',
        usage: { prompt_tokens: 8, completion_tokens: 1, total_tokens: 9 },
      };
    },
  });

  assert.equal(result.text, 'Done.');
  const entries = replayRunTraceEvents(bus.replay(runId, 0));
  assert.deepEqual(entries.slice(0, 3).map((entry) => entry.kind), ['model_context', 'tool_decision', 'tool_result']);
  assert.equal(entries.filter((entry) => entry.kind === 'model_context').length, 2);
  assert.equal(entries[0].modelSaw.tools[0].name, 'ReadNote');
  assert.equal(entries[1].decisions[0].tool, 'ReadNote');
  assert.equal(entries[1].decisions[0].args.apiKey, '[REDACTED]');
  assert.equal(entries[2].tool, 'ReadNote');
  assert.equal(entries[2].status, 'succeeded');
  assert.ok(!JSON.stringify(entries).includes('SECRET'), 'live trace leaked a secret');
});
