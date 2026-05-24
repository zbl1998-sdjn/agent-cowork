import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildAgentToolset, runAgentChat } from '../src/kimi/agent-runner.js';
import { createApprovalRegistry } from '../src/runtime/approvals.js';
import { createServer } from '../src/server.js';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-auq-')); }
async function bind(s) { await new Promise((r) => s.listen(0, '127.0.0.1', r)); return `http://127.0.0.1:${s.address().port}`; }

test('AskUserQuestion: agent emits a question frame and the answer flows back to the model', async () => {
  const root = tmp();
  const approvals = createApprovalRegistry();
  const events = [];
  // Simulate the user picking the 2nd option as soon as the question is asked.
  const emit = (t, d) => { events.push({ t, d }); if (t === 'question') approvals.respond(d.id, '方案B'); };
  const tools = buildAgentToolset({ ctx: { trustedRoot: root, context: {} }, agentDeps: { kimiConfig: {}, modelCall: async () => ({}), approvals, emit } });
  assert.ok(tools.some((t) => t.name === 'AskUserQuestion'), 'AskUserQuestion tool present');

  let captured = null;
  let n = 0;
  const modelCall = async ({ messages }) => {
    n += 1;
    if (n === 1) return { content: '', tool_calls: [{ id: 'c1', function: { name: 'AskUserQuestion', arguments: JSON.stringify({ question: '用哪个方案?', options: ['方案A', '方案B'] }) } }] };
    captured = messages[messages.length - 1]; // the tool result message
    return { content: '好的，按方案B执行。' };
  };
  const out = await runAgentChat({
    prompt: '请在 README.md 里的方案A和方案B之间帮我选择一个导出方案',
    kimiConfig: {},
    trustedRoot: root,
    tools,
    modelCall,
    approvals,
    emit,
    clarifyBeforeModel: true,
    runStoreRoot: path.join(root, 'runs'),
  });

  const q = events.find((e) => e.t === 'question');
  assert.ok(q, 'question frame emitted');
  assert.equal(q.d.question, '用哪个方案?');
  assert.deepEqual(q.d.options.map((o) => o.label), ['方案A', '方案B']);
  assert.match(captured.content, /方案B/, 'chosen answer fed back to the model');
  assert.equal(out.text, '好的，按方案B执行。');
});

test('clarification-first preflights vague prompts before the first model call', async () => {
  const root = tmp();
  const approvals = createApprovalRegistry();
  const events = [];
  const emit = (t, d) => {
    events.push({ t, d });
    if (t === 'question') approvals.respond(d.id, '请审查 README.md 并列出风险');
  };
  const tools = buildAgentToolset({ ctx: { trustedRoot: root, context: {} }, agentDeps: { kimiConfig: {}, modelCall: async () => ({}), approvals, emit } });

  let firstUserMessage = null;
  const modelCall = async ({ messages }) => {
    firstUserMessage = messages.find((m) => m.role === 'user');
    return { content: '收到，我会按 README 审查风险。' };
  };
  const out = await runAgentChat({
    prompt: '帮我处理一下',
    kimiConfig: {},
    trustedRoot: root,
    tools,
    modelCall,
    approvals,
    emit,
    clarifyBeforeModel: true,
    runStoreRoot: path.join(root, 'runs'),
  });

  const question = events.find((e) => e.t === 'question');
  assert.ok(question, 'vague prompt should ask a clarification question');
  assert.match(question.d.question, /缺少/);
  assert.match(firstUserMessage.content, /帮我处理一下/);
  assert.match(firstUserMessage.content, /用户澄清/);
  assert.match(firstUserMessage.content, /README\.md/);
  assert.equal(out.text, '收到，我会按 README 审查风险。');
});

test('clarification-first skips already explicit prompts', async () => {
  const root = tmp();
  const approvals = createApprovalRegistry();
  const events = [];
  const emit = (t, d) => { events.push({ t, d }); };
  const tools = buildAgentToolset({ ctx: { trustedRoot: root, context: {} }, agentDeps: { kimiConfig: {}, modelCall: async () => ({}), approvals, emit } });

  let firstUserMessage = null;
  const modelCall = async ({ messages }) => {
    firstUserMessage = messages.find((m) => m.role === 'user');
    return { content: '开始审查。' };
  };
  await runAgentChat({
    prompt: '请审查 README.md 的安装说明并列出具体问题',
    kimiConfig: {},
    trustedRoot: root,
    tools,
    modelCall,
    approvals,
    emit,
    clarifyBeforeModel: true,
    runStoreRoot: path.join(root, 'runs'),
  });

  assert.equal(events.some((e) => e.t === 'question'), false);
  assert.doesNotMatch(firstUserMessage.content, /用户澄清/);
});

test('E2E /api/agent/chat/stream: question frame over SSE, POST { answer } resumes the run', async () => {
  const root = tmp();
  let n = 0;
  const agentModelCall = async () => {
    n += 1;
    if (n === 1) return { content: '', tool_calls: [{ id: 'c1', function: { name: 'AskUserQuestion', arguments: JSON.stringify({ question: '导出什么格式?', options: ['PDF', 'Excel'] }) } }] };
    return { content: '已按所选格式导出。' };
  };
  const server = createServer({ trustedRoot: root, enableScheduler: false, kimiChatRunner: async () => ({}), agentModelCall });
  const base = await bind(server);
  try {
    const res = await fetch(`${base}/api/agent/chat/stream`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: '导出报告' }) });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let all = '';
    let qid = null;
    while (!qid) {
      const { value, done } = await reader.read();
      if (done) break;
      all += dec.decode(value, { stream: true });
      const m = /event: question\r?\ndata: (\{.*\})/.exec(all);
      if (m) qid = JSON.parse(m[1]).id;
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
