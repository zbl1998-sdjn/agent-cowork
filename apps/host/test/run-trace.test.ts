import assert from 'node:assert/strict';
import test from 'node:test';
import { RunEventBus } from '../src/runtime/run-events.js';
import {
  buildDecisionTraceFromMessages,
  createRunTrace,
  replayRunTraceEvents,
} from '../src/runtime/run-trace.js';
import { runAgentChat } from '../src/kimi/agent/tool-loop.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
  assert.ok(isRecord(value), `${label} should be an object`);
  return value;
}

function recordAt(values: readonly Record<string, unknown>[], index: number, label: string): Record<string, unknown> {
  const value = values[index];
  assert.ok(value, `${label} should exist`);
  return value;
}

function expectRecordArray(value: unknown, label: string): Record<string, unknown>[] {
  assert.ok(Array.isArray(value), `${label} should be an array`);
  return value.map((item, index) => expectRecord(item, `${label}[${index}]`));
}

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
        { role: 'system', content: 'system api_key=sk-test-system-secret-12345' },
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
        { id: 'call_1', function: { name: 'Read', arguments: JSON.stringify({ path: 'note.md', apiKey: 'sk-test-args-secret-12345' }) } },
      ],
    },
  });
  trace.append({
    kind: 'tool_result',
    step: 1,
    callId: 'call_1',
    tool: 'Read',
    status: 'succeeded',
    result: { ok: true, text: `content ${'x'.repeat(160)} sk-test-result-secret-12345` },
  });

  const entries = trace.replay();
  assert.equal(entries.length, 3);
  const firstEntry = recordAt(entries, 0, 'first trace entry');
  const secondEntry = recordAt(entries, 1, 'second trace entry');
  const thirdEntry = recordAt(entries, 2, 'third trace entry');
  assert.equal(firstEntry.traceSeq, 1);
  assert.equal(firstEntry.kind, 'model_context');
  const firstModelSaw = expectRecord(firstEntry.modelSaw, 'first trace modelSaw');
  const firstMessages = expectRecordArray(firstModelSaw.messages, 'first trace messages');
  const firstMessage = recordAt(firstMessages, 0, 'first trace message');
  assert.equal(firstMessage.content, 'system api_key=[REDACTED]');
  assert.equal(secondEntry.kind, 'tool_decision');
  const secondDecisions = expectRecordArray(secondEntry.decisions, 'second trace decisions');
  const firstDecision = recordAt(secondDecisions, 0, 'first trace decision');
  const firstDecisionArgs = expectRecord(firstDecision.args, 'first trace decision args');
  assert.equal(firstDecision.tool, 'Read');
  assert.equal(firstDecisionArgs.apiKey, '[REDACTED]');
  assert.match(String(secondEntry.why), /Need inspect/);
  const thirdResult = expectRecord(thirdEntry.result, 'third trace result');
  assert.equal(thirdResult.truncated, true);
  assert.ok(!JSON.stringify(entries).includes('sk-test-'), 'trace leaked a secret');

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
  const step = recordAt(trace, 0, 'decision trace step');
  assert.equal(step.kind, 'decision_step');
  assert.equal(step.runId, 'run_messages_1');
  assert.equal(step.step, 1);
  const stepModelSaw = expectRecord(step.modelSaw, 'decision trace modelSaw');
  const stepMessages = expectRecordArray(stepModelSaw.messages, 'decision trace messages');
  const stepDecisions = expectRecordArray(step.decisions, 'decision trace decisions');
  const stepResults = expectRecordArray(step.results, 'decision trace results');
  const stepDecision = recordAt(stepDecisions, 0, 'decision trace first decision');
  const stepResult = recordAt(stepResults, 0, 'decision trace first result');
  const stepResultPayload = expectRecord(stepResult.result, 'decision trace first result payload');
  assert.deepEqual(stepMessages.map((message) => message.role), ['system', 'user']);
  assert.equal(stepDecision.callId, 'call_read');
  assert.equal(stepDecision.tool, 'Read');
  assert.deepEqual(stepDecision.args, { path: 'package.json' });
  assert.match(String(stepDecision.why), /Need read the manifest/);
  assert.equal(stepResult.callId, 'call_read');
  assert.equal(stepResult.status, 'succeeded');
  assert.equal(stepResultPayload.ok, true);
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
      handler: async (args = {}) => ({ ok: true, text: `read ${String(args.path || '')} with sk-test-result-secret-12345` }),
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
              arguments: JSON.stringify({ path: 'note.md', apiKey: 'sk-test-arg-secret-12345' }),
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
  const liveContext = recordAt(entries, 0, 'live trace context');
  const liveDecision = recordAt(entries, 1, 'live trace decision');
  const liveResult = recordAt(entries, 2, 'live trace result');
  const liveModelSaw = expectRecord(liveContext.modelSaw, 'live trace modelSaw');
  const liveTools = expectRecordArray(liveModelSaw.tools, 'live trace tools');
  const liveDecisions = expectRecordArray(liveDecision.decisions, 'live trace decisions');
  const firstLiveTool = recordAt(liveTools, 0, 'live trace first tool');
  const firstLiveDecision = recordAt(liveDecisions, 0, 'live trace first decision');
  const liveDecisionArgs = expectRecord(firstLiveDecision.args, 'live trace decision args');
  assert.equal(firstLiveTool.name, 'ReadNote');
  assert.equal(firstLiveDecision.tool, 'ReadNote');
  assert.equal(liveDecisionArgs.apiKey, '[REDACTED]');
  assert.equal(liveResult.tool, 'ReadNote');
  assert.equal(liveResult.status, 'succeeded');
  assert.ok(!JSON.stringify(entries).includes('sk-test-'), 'live trace leaked a secret');
});
