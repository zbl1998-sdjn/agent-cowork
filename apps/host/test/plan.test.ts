import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { AddressInfo } from 'node:http';
import { buildPlan } from '../src/runtime/plan-builder.js';
import type { Planner } from '../src/runtime/plan-builder.js';
import { ToolRegistry } from '../src/tools/tool-registry.js';
import { createServer } from '../src/server.js';

type HostServer = ReturnType<typeof createServer>;
type JsonOptions = { body?: unknown; headers?: Record<string, string>; method?: string };
type JsonResponse<T> = { status: number; body: T };
type PlanRouteBody = { steps: Array<{ tool: string }> };
type SubagentRunBody = { ok: boolean; steps: Array<{ summary: { keys: string[] } }> };

function tmp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-plan-')); }
async function bind(server: HostServer): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  assert.ok(address !== null);
  assert.equal(typeof address, 'object');
  return `http://127.0.0.1:${(address as AddressInfo).port}`;
}
async function J<T>(base: string, route: string, opt: JsonOptions = {}): Promise<JsonResponse<T>> {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...(opt.headers || {}) };
  const init: RequestInit = { method: opt.method || 'GET', headers };
  if (opt.body !== undefined) init.body = JSON.stringify(opt.body);
  const res = await fetch(`${base}${route}`, init);
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
}

test('buildPlan default heuristic maps goal to relevant tools, filtering unknowns', async () => {
  const reg = new ToolRegistry();
  reg.register({ name: 'sandbox.exec', description: 'run command', handler: () => null });
  reg.register({ name: 'recipe.summary-report', description: '总结报告', handler: () => null });
  const plan = await buildPlan({ goal: 'sandbox', registry: reg });
  assert.equal(plan.executable, true);
  assert.ok(plan.steps.some((s) => s.tool === 'sandbox.exec'));
  assert.ok(plan.steps.every((s) => reg.has(s.tool)));
});

test('buildPlan accepts an injected planner and drops steps with unknown tools', async () => {
  const reg = new ToolRegistry();
  reg.register({ name: 'known.tool', description: '', handler: () => null });
  const planner: Planner = async ({ goal }) => ({ goal, steps: [
    { tool: 'known.tool', args: { x: 1 }, rationale: 'r1' },
    { tool: 'ghost.tool', args: {}, rationale: 'r2' },
  ] });
  const plan = await buildPlan({ goal: 'do it', registry: reg, planner });
  assert.equal(plan.steps.length, 1);
  const step = plan.steps[0];
  assert.ok(step);
  assert.equal(step.tool, 'known.tool');
  assert.deepEqual(step.args, { x: 1 });
});

test('buildPlan requires a goal', async () => {
  const reg = new ToolRegistry();
  await assert.rejects(() => buildPlan({ goal: '   ', registry: reg }), (error: unknown) => {
    assert.equal((error as Error & { statusCode?: number }).statusCode, 400);
    return true;
  });
});

test('POST /api/plan proposes steps, then they execute via /api/subagent/run', async () => {
  const trustedRoot = tmp();
  fs.writeFileSync(path.join(trustedRoot, 'plan-notes.txt'), 'plan route searchable fixture', 'utf8');
  const server = createServer({ trustedRoot, enableScheduler: false, requireAuth: false, trustIdentityHeaders: true });
  const base = await bind(server);
  try {
    const plan = await J<PlanRouteBody>(base, '/api/plan', { method: 'POST', body: { goal: 'SearchWorkspace' } });
    assert.equal(plan.status, 200);
    assert.ok(plan.body.steps.length >= 1);
    assert.ok(plan.body.steps.some((s) => s.tool === 'SearchWorkspace'));

    // Execute a concrete read-only step; approval-gated tools use the Agent approval flow.
    const run = await J<SubagentRunBody>(base, '/api/subagent/run', {
      method: 'POST', headers: { 'idempotency-key': 'plan-exec-1' },
      body: { goal: 'workspace search', steps: [{ tool: 'SearchWorkspace', args: { query: 'searchable fixture', limit: 3 } }] },
    });
    assert.equal(run.status, 200);
    assert.equal(run.body.ok, true);
    const runStep = run.body.steps[0];
    assert.ok(runStep);
    assert.ok(runStep.summary.keys.includes('chunks'));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('POST /api/plan validates goal at the route boundary', async () => {
  const trustedRoot = tmp();
  const server = createServer({ trustedRoot, enableScheduler: false, requireAuth: false, trustIdentityHeaders: true });
  const base = await bind(server);
  try {
    const missing = await J<{ error: string }>(base, '/api/plan', { method: 'POST', body: {} });
    assert.equal(missing.status, 400);
    assert.match(missing.body.error, /goal/i);

    const invalid = await J<{ error: string }>(base, '/api/plan', { method: 'POST', body: { goal: ['SearchWorkspace'] } });
    assert.equal(invalid.status, 400);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
