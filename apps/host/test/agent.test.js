import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runAgentChat } from '../src/kimi/agent-runner.js';
import { createAgentTools } from '../src/kimi/agent-tools.js';
import { createApprovalRegistry } from '../src/runtime/approvals.js';
import { LocalSubprocessSandbox } from '../src/sandbox/local-sandbox.js';
import { createServer } from '../src/server.js';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-agent-')); }
async function bind(s) { await new Promise((r) => s.listen(0, '127.0.0.1', r)); return `http://127.0.0.1:${s.address().port}`; }

test('native agent tools (Read/Write/Glob) are jailed to the workspace', async () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'a.txt'), 'hello', 'utf8');
  fs.writeFileSync(path.join(root, '.npmrc'), 'token=secret', 'utf8');
  const tools = createAgentTools({ trustedRoot: root });
  const byName = (n) => tools.find((t) => t.name === n);
  assert.deepEqual(tools.map((t) => t.name).sort(), ['AnalyzeDataFile', 'Edit', 'GitCommit', 'GitDiff', 'GitLog', 'GitStatus', 'Glob', 'Grep', 'PlanFileOrganization', 'Read', 'SearchWorkspace', 'WebFetch', 'Write']);
  const glob = await byName('Glob').handler({ pattern: '*.txt' });
  assert.ok(glob.matches.includes('a.txt'));
  assert.equal(glob.matches.some((match) => match.includes('.npmrc')), false);
  const grep = await byName('Grep').handler({ pattern: 'secret', maxResults: 5 });
  assert.deepEqual(grep.hits, []);
  const read = await byName('Read').handler({ path: 'a.txt' });
  assert.equal(read.content, 'hello');
  await assert.rejects(() => byName('Read').handler({ path: '.npmrc' }), /blocked by policy/);
  const wrote = await byName('Write').handler({ path: 'sub/b.txt', content: 'world' });
  assert.equal(wrote.ok, true);
  assert.equal(fs.readFileSync(path.join(root, 'sub', 'b.txt'), 'utf8'), 'world');
  // Write/Edit are flagged mutating (gated by approval in the loop)
  assert.equal(byName('Write').mutating, true);
  assert.equal(byName('Read').mutating, false);
  assert.equal(byName('SearchWorkspace').mutating, false);
  assert.equal(byName('PlanFileOrganization').mutating, false);
  assert.equal(byName('AnalyzeDataFile').mutating, false);
  assert.equal(byName('GitStatus').mutating, false);
  assert.equal(byName('GitCommit').mutating, true);
  assert.equal(byName('GitCommit').risk, 'high');
  await assert.rejects(() => byName('Write').handler({ path: '../escape.txt', content: 'x' }), /escaped|Sensitive|outside/i);
});

test('Edit replaces a string in a workspace file', async () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'c.txt'), 'foo bar foo', 'utf8');
  const tools = createAgentTools({ trustedRoot: root });
  const edit = tools.find((t) => t.name === 'Edit');
  await edit.handler({ path: 'c.txt', old_string: 'foo', new_string: 'baz' });
  assert.equal(fs.readFileSync(path.join(root, 'c.txt'), 'utf8'), 'baz bar foo');
  const all = await edit.handler({ path: 'c.txt', old_string: 'foo', new_string: 'X', replace_all: true });
  assert.equal(all.replacements, 1);
});

test('Shell captures stdout from quoted node -e commands on Windows local backend', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('Windows shell quoting regression');
    return;
  }
  const root = tmp();
  const tools = createAgentTools({
    trustedRoot: root,
    sandbox: new LocalSubprocessSandbox(),
    sandboxLimits: { allowTools: ['node'] },
  });
  const shell = tools.find((tool) => tool.name === 'Shell');
  const result = await shell.handler({ command: 'node -e "process.stdout.write(\'shell-ok\')"' });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'shell-ok');
  assert.equal(result.stderr, '');
});

test('runAgentChat executes a Write tool call then returns a final answer', async () => {
  const root = tmp();
  const events = [];
  let calls = 0;
  const modelCall = async () => {
    calls += 1;
    if (calls === 1) return { content: '', tool_calls: [{ id: 'c1', function: { name: 'Write', arguments: JSON.stringify({ path: 'out.txt', content: 'hello agent' }) } }] };
    return { content: '已为你创建 out.txt。' };
  };
  const out = await runAgentChat({ prompt: '创建 out.txt', kimiConfig: { model: 'fake' }, trustedRoot: root, modelCall, emit: (type, payload) => events.push({ type, payload }), runStoreRoot: path.join(root, 'runs') });
  assert.equal(fs.readFileSync(path.join(root, 'out.txt'), 'utf8'), 'hello agent');
  assert.ok(events.some((e) => e.type === 'todo_update' && e.payload.status === 'running' && e.payload.text === '调用 Write'), 'tool todo starts running');
  assert.ok(events.some((e) => e.type === 'todo_update' && e.payload.status === 'done' && e.payload.text === '调用 Write'), 'tool todo finishes done');
  assert.ok(events.some((e) => e.type === 'tool_result' && e.payload.name === 'Write' && Number.isFinite(e.payload.durationMs)), 'tool result reports duration');
  assert.equal(out.text, '已为你创建 out.txt。');
});

test('POST /api/agent/chat/stream (autoApprove) writes the file and records an agent-chat run', async () => {
  const root = tmp();
  let calls = 0;
  const agentModelCall = async () => {
    calls += 1;
    if (calls === 1) return { content: '', tool_calls: [{ id: 'c1', function: { name: 'Write', arguments: JSON.stringify({ path: 'note.md', content: '# 标题\n内容' }) } }] };
    return { content: '已写入 note.md。' };
  };
  const server = createServer({ trustedRoot: root, enableScheduler: false, kimiChatRunner: async () => ({}), agentModelCall });
  const base = await bind(server);
  try {
    const res = await fetch(`${base}/api/agent/chat/stream`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: '写 note.md', autoApprove: true }) });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.match(text, /event: tool_call/);
    assert.match(text, /event: todo_update/);
    assert.match(text, /event: done/);
    assert.equal(fs.readFileSync(path.join(root, 'note.md'), 'utf8'), '# 标题\n内容');
    const idx = await (await fetch(`${base}/api/runs/index`)).json();
    assert.ok((idx.runs || []).some((r) => r.type === 'agent-chat'));
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('plan mode blocks writes until ExitPlanMode is approved, then executes', async () => {
  const root = tmp();
  const approvals = createApprovalRegistry();
  const events = [];
  // Auto-approve the plan as soon as it is proposed (simulates the user clicking "批准并执行").
  const emit = (type, payload) => {
    events.push({ type, payload });
    if (type === 'plan_proposed') approvals.resolve(payload.id, 'once');
  };
  let calls = 0;
  const modelCall = async () => {
    calls += 1;
    if (calls === 1) return { content: '', tool_calls: [{ id: 'c1', function: { name: 'Write', arguments: JSON.stringify({ path: 'out.txt', content: 'EARLY' }) } }] };
    if (calls === 2) return { content: '', tool_calls: [{ id: 'c2', function: { name: 'ExitPlanMode', arguments: JSON.stringify({ plan: '1. 写 out.txt' }) } }] };
    if (calls === 3) return { content: '', tool_calls: [{ id: 'c3', function: { name: 'Write', arguments: JSON.stringify({ path: 'out.txt', content: 'APPROVED' }) } }] };
    return { content: '已按计划完成。' };
  };
  const out = await runAgentChat({ prompt: '写 out.txt', kimiConfig: { model: 'fake' }, trustedRoot: root, modelCall, approvals, planMode: true, emit, runStoreRoot: path.join(root, 'runs') });

  // The pre-approval Write must have been blocked, not executed.
  assert.ok(out.steps.some((s) => s.tool === 'Write' && s.planBlocked), 'early write blocked');
  // A plan was proposed (frontend onPlanProposed) and approved.
  assert.ok(events.some((e) => e.type === 'plan_proposed'), 'plan_proposed emitted');
  assert.ok(events.some((e) => e.type === 'todo_snapshot' && e.payload.todos?.[0]?.text === '写 out.txt'), 'plan todo snapshot emitted');
  assert.ok(out.steps.some((s) => s.tool === 'ExitPlanMode' && s.plan && s.approved), 'plan approved');
  // After approval the second Write executed with the approved content.
  assert.equal(fs.readFileSync(path.join(root, 'out.txt'), 'utf8'), 'APPROVED');
  assert.equal(out.text, '已按计划完成。');
});

test('plan mode: rejecting the plan keeps mutating tools blocked', async () => {
  const root = tmp();
  const approvals = createApprovalRegistry();
  let planProposals = 0;
  const emit = (type, payload) => {
    if (type === 'plan_proposed') { planProposals += 1; approvals.resolve(payload.id, 'reject'); }
  };
  let calls = 0;
  const modelCall = async () => {
    calls += 1;
    if (calls === 1) return { content: '', tool_calls: [{ id: 'c1', function: { name: 'ExitPlanMode', arguments: JSON.stringify({ plan: '改 out.txt' }) } }] };
    if (calls === 2) return { content: '', tool_calls: [{ id: 'c2', function: { name: 'Write', arguments: JSON.stringify({ path: 'out.txt', content: 'NOPE' }) } }] };
    return { content: '好的，我再完善计划。' };
  };
  const out = await runAgentChat({ prompt: '改 out.txt', kimiConfig: { model: 'fake' }, trustedRoot: root, modelCall, approvals, planMode: true, emit, runStoreRoot: path.join(root, 'runs') });

  assert.equal(planProposals, 1);
  assert.ok(out.steps.some((s) => s.tool === 'ExitPlanMode' && s.approved === false), 'plan rejected');
  assert.ok(out.steps.some((s) => s.tool === 'Write' && s.planBlocked), 'write still blocked after reject');
  assert.equal(fs.existsSync(path.join(root, 'out.txt')), false, 'file never written');
});

test('a run that exhausts the step budget still returns a written reply (no blank "task ended")', async () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'a.txt'), 'x', 'utf8');
  // Model that NEVER stops calling tools -> the loop runs out of steps. The
  // post-loop forced-summary turn (tools:[]) must produce the final text so the
  // user never sees an empty assistant bubble.
  const modelCall = async ({ tools }) => {
    if (tools && tools.length > 0) {
      return { content: '', tool_calls: [{ id: 'c' + Math.random(), function: { name: 'Glob', arguments: JSON.stringify({ pattern: '*' }) } }] };
    }
    return { content: '【小结】我浏览了工作区。' };
  };
  const out = await runAgentChat({ prompt: '看看这里', kimiConfig: { model: 'fake' }, trustedRoot: root, modelCall, maxSteps: 3, emit: () => {} });
  assert.ok(out.text && out.text.length > 0, 'final text must not be empty after budget exhaustion');
  assert.match(out.text, /小结|工作区/);
});

test('static backstop fires when even the forced summary comes back empty', async () => {
  const root = tmp();
  const modelCall = async ({ tools }) => {
    if (tools && tools.length > 0) return { content: '', tool_calls: [{ id: 'z', function: { name: 'Glob', arguments: '{"pattern":"*"}' } }] };
    return { content: '' }; // forced-summary turn also empty
  };
  const out = await runAgentChat({ prompt: 'x', kimiConfig: { model: 'fake' }, trustedRoot: root, modelCall, maxSteps: 2, emit: () => {} });
  assert.ok(out.text && out.text.length > 0, 'static backstop must provide a non-empty reply');
});
