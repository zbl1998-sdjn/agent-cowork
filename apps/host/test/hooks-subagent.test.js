import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHookEngine } from '../src/runtime/hooks.js';
import { runAgentChat, buildAgentToolset } from '../src/kimi/agent-runner.js';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-hk-')); }

test('hook engine: pre_tool hook can block by tool match', async () => {
  const engine = createHookEngine({ hooks: [
    { event: 'pre_tool', tool: 'Shell', handler: async () => ({ block: true, reason: 'no shell' }) },
    { event: 'post_tool', tool: '*', handler: async () => ({ ok: true }) },
  ] });
  const blocked = engine.blocked(await engine.run('pre_tool', { name: 'Shell' }));
  assert.ok(blocked && blocked.block);
  assert.equal(engine.blocked(await engine.run('pre_tool', { name: 'Write' })), null);
});

test('runAgentChat: a pre_tool hook blocks the tool (not executed)', async () => {
  const root = tmp();
  let ran = false;
  const tools = [{ name: 'Danger', risk: 'low', description: '', parameters: { type: 'object', properties: {} }, handler: async () => { ran = true; return { ok: true }; } }];
  let n = 0;
  const modelCall = async () => { n += 1; return n === 1 ? { content: '', tool_calls: [{ id: 'c1', function: { name: 'Danger', arguments: '{}' } }] } : { content: '完成。' }; };
  const hooks = createHookEngine({ hooks: [{ event: 'pre_tool', tool: 'Danger', handler: async () => ({ block: true, reason: '策略禁止' }) }] });
  const out = await runAgentChat({ prompt: 'x', kimiConfig: { model: 'fake' }, trustedRoot: root, runStoreRoot: path.join(root, 'runs'), tools, modelCall, hooks });
  assert.equal(ran, false, 'blocked tool must not run');
  assert.ok(out.steps.some((s) => s.tool === 'Danger' && s.blocked));
});

test('Agent tool spawns a nested sub-agent and returns its result', async () => {
  const root = tmp();
  // sub-agent model: always returns a final answer (no tool calls)
  const subModel = async () => ({ content: '子任务完成' });
  const tools = buildAgentToolset({
    ctx: { trustedRoot: root, context: {} },
    agentDeps: { kimiConfig: { model: 'fake' }, modelCall: subModel, approvals: null, autoApprove: true, hooks: null, emit: () => {} },
    runDeps: { runStoreRoot: path.join(root, 'runs') },
  });
  const agentTool = tools.find((t) => t.name === 'Agent');
  assert.ok(agentTool, 'Agent tool present');
  const res = await agentTool.handler({ task: '整理一下' });
  assert.equal(res.text, '子任务完成');
});
