import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildAgentToolset, runAgentChat } from '../src/engine/agent-runner.js';
import { createApprovalRegistry } from '../src/runtime/approvals.js';
import { createServer } from '../src/server.js';
import type { ApprovalRegistry as AgentApprovalRegistry } from '../src/engine/agent/approval-gate.js';
import type { ModelCall, ModelCallArgs } from '../src/engine/agent/model-resilience.js';
import type { ModelTextResult } from '../src/engine/api-runner.js';
import type { HostServer } from '../src/server.js';
import { TEST_LOCAL_HOST_MODEL_CONFIG, TEST_LOCAL_MODEL_CONFIG } from './helpers/kimi-config.js';

type ChatMessage = Record<string, unknown> & { role?: unknown; content?: unknown };
type QuestionPayload = { id: string; question: string; options: Array<{ label: string }> };
type UiEvent = { t: string; d: Record<string, unknown> };

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-auq-')); }
async function bind(s: HostServer): Promise<string> {
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', () => resolve()));
  const address = s.address();
  assert.ok(address && typeof address === 'object', 'server should expose an address after listen');
  return `http://127.0.0.1:${address.port}`;
}

function asAgentApprovals(approvals: ReturnType<typeof createApprovalRegistry>): AgentApprovalRegistry {
  return approvals as unknown as AgentApprovalRegistry;
}

function messagesOf(args: ModelCallArgs): ChatMessage[] {
  return Array.isArray(args.messages) ? args.messages as ChatMessage[] : [];
}

function questionPayload(value: unknown): QuestionPayload {
  assert.ok(value && typeof value === 'object', 'question payload should be an object');
  const payload = value as Record<string, unknown>;
  assert.equal(typeof payload.id, 'string');
  assert.equal(typeof payload.question, 'string');
  assert.ok(Array.isArray(payload.options));
  return payload as unknown as QuestionPayload;
}

function recordPayload(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === 'object', 'event payload should be an object');
  return value as Record<string, unknown>;
}

function fakeKimiTextResult(text = ''): ModelTextResult {
  return { ok: true, provider: 'test', model: 'test', mode: 'chat', text, durationMs: 0 };
}

test('AskUserQuestion: agent emits a question frame and the answer flows back to the model', async () => {
  const root = tmp();
  const approvals = createApprovalRegistry();
  const events: UiEvent[] = [];
  // Simulate the user picking the 2nd option as soon as the question is asked.
  const emit = (t: string, d: unknown) => {
    const payload = recordPayload(d);
    events.push({ t, d: payload });
    if (t === 'question' && typeof payload.id === 'string') approvals.respond(payload.id, '方案B');
  };
  const tools = buildAgentToolset({ ctx: { trustedRoot: root, context: {} }, agentDeps: { modelConfig: TEST_LOCAL_MODEL_CONFIG, modelCall: async () => ({}), approvals, emit } });
  assert.ok(tools.some((t) => t.name === 'AskUserQuestion'), 'AskUserQuestion tool present');

  const captured: { message: ChatMessage | undefined } = { message: undefined };
  let n = 0;
  const modelCall: ModelCall = async (args) => {
    const messages = messagesOf(args);
    n += 1;
    if (n === 1) return { content: '', tool_calls: [{ id: 'c1', function: { name: 'AskUserQuestion', arguments: JSON.stringify({ question: '用哪个方案?', options: ['方案A', '方案B'] }) } }] };
    captured.message = messages[messages.length - 1]; // the tool result message
    return { content: '好的，按方案B执行。' };
  };
  const out = await runAgentChat({
    prompt: '请在 README.md 里的方案A和方案B之间帮我选择一个导出方案',
    modelConfig: TEST_LOCAL_MODEL_CONFIG,
    trustedRoot: root,
    tools,
    modelCall,
    approvals: asAgentApprovals(approvals),
    emit,
    clarifyBeforeModel: true,
    runStoreRoot: path.join(root, 'runs'),
  });

  const q = events.find((e) => e.t === 'question');
  assert.ok(q, 'question frame emitted');
  const payload = questionPayload(q.d);
  assert.equal(payload.question, '用哪个方案?');
  assert.deepEqual(payload.options.map((o) => o.label), ['方案A', '方案B']);
  assert.ok(captured.message);
  assert.match(String(captured.message.content), /方案B/, 'chosen answer fed back to the model');
  assert.equal(out.text, '好的，按方案B执行。');
});

test('clarification-first preflights vague prompts before the first model call', async () => {
  const root = tmp();
  const approvals = createApprovalRegistry();
  const events: UiEvent[] = [];
  const emit = (t: string, d: unknown) => {
    const payload = recordPayload(d);
    events.push({ t, d: payload });
    if (t === 'question' && typeof payload.id === 'string') approvals.respond(payload.id, '请审查 README.md 并列出风险');
  };
  const tools = buildAgentToolset({ ctx: { trustedRoot: root, context: {} }, agentDeps: { modelConfig: TEST_LOCAL_MODEL_CONFIG, modelCall: async () => ({}), approvals, emit } });

  const capture: { firstUserMessage: ChatMessage | undefined } = { firstUserMessage: undefined };
  const modelCall: ModelCall = async (args) => {
    const messages = messagesOf(args);
    capture.firstUserMessage = messages.find((m) => m.role === 'user');
    return { content: '收到，我会按 README 审查风险。' };
  };
  const out = await runAgentChat({
    prompt: '帮我处理一下',
    modelConfig: TEST_LOCAL_MODEL_CONFIG,
    trustedRoot: root,
    tools,
    modelCall,
    approvals: asAgentApprovals(approvals),
    emit,
    clarifyBeforeModel: true,
    runStoreRoot: path.join(root, 'runs'),
  });

  const question = events.find((e) => e.t === 'question');
  assert.ok(question, 'vague prompt should ask a clarification question');
  assert.match(String(question.d.question), /缺少/);
  assert.ok(capture.firstUserMessage);
  assert.match(String(capture.firstUserMessage.content), /帮我处理一下/);
  assert.match(String(capture.firstUserMessage.content), /用户澄清/);
  assert.match(String(capture.firstUserMessage.content), /README\.md/);
  assert.equal(out.text, '收到，我会按 README 审查风险。');
});

test('clarification-first skips already explicit prompts', async () => {
  const root = tmp();
  const approvals = createApprovalRegistry();
  const events: UiEvent[] = [];
  const emit = (t: string, d: unknown) => { events.push({ t, d: recordPayload(d) }); };
  const tools = buildAgentToolset({ ctx: { trustedRoot: root, context: {} }, agentDeps: { modelConfig: TEST_LOCAL_MODEL_CONFIG, modelCall: async () => ({}), approvals, emit } });

  const capture: { firstUserMessage: ChatMessage | undefined } = { firstUserMessage: undefined };
  const modelCall: ModelCall = async (args) => {
    const messages = messagesOf(args);
    capture.firstUserMessage = messages.find((m) => m.role === 'user');
    return { content: '开始审查。' };
  };
  await runAgentChat({
    prompt: '请审查 README.md 的安装说明并列出具体问题',
    modelConfig: TEST_LOCAL_MODEL_CONFIG,
    trustedRoot: root,
    tools,
    modelCall,
    approvals: asAgentApprovals(approvals),
    emit,
    clarifyBeforeModel: true,
    runStoreRoot: path.join(root, 'runs'),
  });

  assert.equal(events.some((e) => e.t === 'question'), false);
  assert.ok(capture.firstUserMessage);
  assert.doesNotMatch(String(capture.firstUserMessage.content), /用户澄清/);
});

test('AskUserQuestion fails closed when approval persistence fails', async () => {
  const root = tmp();
  const events: UiEvent[] = [];
  const tools = buildAgentToolset({
    ctx: { trustedRoot: root, context: { tenantId: 'tenant-a', userId: 'user-a' } },
    agentDeps: {
      modelConfig: TEST_LOCAL_MODEL_CONFIG,
      modelCall: async () => ({}),
      approvals: {
        request: () => ({
          id: 'question_persistence_failed',
          promise: Promise.reject(new Error('postgres persistence unavailable')),
        }),
      },
      emit: (t, d) => events.push({ t, d: recordPayload(d) }),
    },
  });
  const questionTool = tools.find((tool) => tool.name === 'AskUserQuestion');
  assert.ok(questionTool?.handler);

  const result = await questionTool.handler({ question: '继续吗?', options: ['是', '否'] });
  assert.deepEqual(result, {
    error: '审批问题未能持久化，已失败关闭',
    code: 'APPROVAL_REQUIRED',
  });
  assert.equal(events.some((event) => event.t === 'question'), true);
  assert.doesNotMatch(JSON.stringify(result), /postgres/i);
});

test('AskUserQuestion does not publish the question before durable readiness', async () => {
  const root = tmp();
  const events: UiEvent[] = [];
  let markReady: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => { markReady = resolve; });
  const tools = buildAgentToolset({
    ctx: { trustedRoot: root, context: { tenantId: 'tenant-a', userId: 'user-a' } },
    agentDeps: {
      modelConfig: TEST_LOCAL_MODEL_CONFIG,
      modelCall: async () => ({}),
      approvals: {
        request: () => ({ id: 'question_ready', ready, promise: Promise.resolve('是') }),
      },
      emit: (t, d) => events.push({ t, d: recordPayload(d) }),
    },
  });
  const questionTool = tools.find((tool) => tool.name === 'AskUserQuestion');
  assert.ok(questionTool?.handler);
  const result = questionTool.handler({ question: '继续吗?', options: ['是', '否'] });
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.equal(events.some((event) => event.t === 'question'), false);
  markReady?.();
  assert.deepEqual(await result, { answer: '是' });
});

test('E2E /api/agent/chat/stream: question frame over SSE, POST { answer } resumes the run', async () => {
  const root = tmp();
  let n = 0;
  const agentModelCall = async () => {
    n += 1;
    if (n === 1) return { content: '', tool_calls: [{ id: 'c1', function: { name: 'AskUserQuestion', arguments: JSON.stringify({ question: '导出什么格式?', options: ['PDF', 'Excel'] }) } }] };
    return { content: '已按所选格式导出。' };
  };
  const server = createServer({ ...TEST_LOCAL_HOST_MODEL_CONFIG, requireAuth: false, trustedRoot: root, enableScheduler: false, kimiChatRunner: async () => fakeKimiTextResult(), agentModelCall });
  const base = await bind(server);
  try {
    const res = await fetch(`${base}/api/agent/chat/stream`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: '导出报告' }) });
    assert.ok(res.body, 'stream response should have a body');
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let all = '';
    let qid: string | null = null;
    while (!qid) {
      const { value, done } = await reader.read();
      if (done) break;
      all += dec.decode(value, { stream: true });
      const m = /event: question\r?\ndata: (\{.*\})/.exec(all);
      if (m) {
        assert.ok(m[1]);
        qid = (JSON.parse(m[1]) as { id?: string }).id || null;
      }
    }
    assert.ok(qid, 'question frame carried an id');
    assert.match(all, /导出什么格式/);
    const ans = await fetch(`${base}/api/approvals/${qid}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ answer: 'Excel' }) });
    assert.equal((await ans.json()).ok, true);
    for (;;) { const { value, done } = await reader.read(); if (done) break; all += dec.decode(value, { stream: true }); }
    assert.match(all, /event: done/);
    assert.match(all, /已按所选格式导出/);
  } finally {
    if (server.closeMcp) server.closeMcp();
    await new Promise((r) => server.close(r));
  }
});
