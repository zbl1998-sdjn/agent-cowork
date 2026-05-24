import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildPlan } from '../src/runtime/plan-builder.js';
import { ToolRegistry } from '../src/tools/tool-registry.js';
import { createServer } from '../src/server.js';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-plan-')); }
async function bind(s) { await new Promise((r) => s.listen(0, '127.0.0.1', r)); return `http://127.0.0.1:${s.address().port}`; }
async function J(base, route, opt = {}) {
  const res = await fetch(`${base}${route}`, { method: opt.method || 'GET', headers: { 'content-type': 'application/json', ...(opt.headers || {}) }, body: opt.body ? JSON.stringify(opt.body) : undefined });
  const t = await res.text(); return { status: res.status, body: t ? JSON.parse(t) : null };
}

test('buildPlan default heuristic maps goal to relevant tools, filtering unknowns', async () => {
  const reg = new ToolRegistry();
  reg.register({ name: 'sandbox.exec', description: 'run command', handler: () => {} });
  reg.register({ name: 'recipe.summary-report', description: '总结报告', handler: () => {} });
  const plan = await buildPlan({ goal: 'sandbox', registry: reg });
  assert.equal(plan.executable, true);
  assert.ok(plan.steps.some((s) => s.tool === 'sandbox.exec'));
  assert.ok(plan.steps.every((s) => reg.has(s.tool)));
});

test('buildPlan accepts an injected planner and drops steps with unknown tools', async () => {
  const reg = new ToolRegistry();
  reg.register({ name: 'known.tool', description: '', handler: () => {} });
  const planner = async ({ goal }) => ({ goal, steps: [
    { tool: 'known.tool', args: { x: 1 }, rationale: 'r1' },
    { tool: 'ghost.tool', args: {}, rationale: 'r2' },
  ] });
  const plan = await buildPlan({ goal: 'do it', registry: reg, planner });
  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0].tool, 'known.tool');
  assert.deepEqual(plan.steps[0].args, { x: 1 });
});

test('buildPlan requires a goal', async () => {
  const reg = new ToolRegistry();
  await assert.rejects(() => buildPlan({ goal: '   ', registry: reg }), (e) => { assert.equal(e.statusCode, 400); return true; });
});

test('POST /api/plan proposes steps, then they execute via /api/subagent/run', async () => {
  const trustedRoot = tmp();
  fs.writeFileSync(path.join(trustedRoot, 'plan-notes.txt'), 'plan route searchable fixture', 'utf8');
  const server = createServer({ trustedRoot, enableScheduler: false, requireAuth: false, trustIdentityHeaders: true });
  const base = await bind(server);
  try {
    const plan = await J(base, '/api/plan', { method: 'POST', body: { goal: 'SearchWorkspace' } });
    assert.equal(plan.status, 200);
    assert.ok(plan.body.steps.length >= 1);
    assert.ok(plan.body.steps.some((s) => s.tool === 'SearchWorkspace'));

    // Execute a concrete read-only step; approval-gated tools use the Agent approval flow.
    const run = await J(base, '/api/subagent/run', {
      method: 'POST', headers: { 'idempotency-key': 'plan-exec-1' },
      body: { goal: 'workspace search', steps: [{ tool: 'SearchWorkspace', args: { query: 'searchable fixture', limit: 3 } }] },
    });
    assert.equal(run.status, 200);
    assert.equal(run.body.ok, true);
    assert.ok(run.body.steps[0].summary.keys.includes('chunks'));
  } finally {
    await new Promise((r) => server.close(r));
  }
});
