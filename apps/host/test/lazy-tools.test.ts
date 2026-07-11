import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runAgentChat } from '../src/kimi/agent-runner.js';
import { addLazySearchTool, createNoopBudgetGuard, parseToolCall } from '../src/kimi/agent/tool-loop-support.js';
import { TEST_LOCAL_MODEL_CONFIG } from './helpers/kimi-config.js';
import type { AgentTool } from '../src/kimi/agent-tools.js';
import type { ModelCall, ModelCallArgs } from '../src/kimi/agent/model-resilience.js';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-lazy-')); }

function lowTool(name: string, onRun: () => void): AgentTool {
  return { name, risk: 'low', mutating: false, description: `${name} tool`, parameters: { type: 'object', properties: {} }, handler: async () => { onRun(); return { ok: true, from: name }; } };
}

function toolNames(args: ModelCallArgs): string[] {
  const { tools } = args;
  assert.ok(Array.isArray(tools));
  return tools.map((tool) => {
    const spec = tool as { function?: { name?: unknown } };
    const name = spec.function?.name;
    if (typeof name !== 'string') throw new Error('tool spec function.name must be a string');
    return name;
  });
}

function seenToolNames(seenTools: string[][], index: number): string[] {
  const names = seenTools[index];
  if (!names) throw new Error(`missing seen tools at index ${index}`);
  return names;
}

test('lazy tools are hidden until search_tools activates them, then callable', async () => {
  const root = tmp();
  let ran = false;
  const lazy = [lowTool('mcp__weather__forecast', () => { ran = true; })];
  const core = [lowTool('Read', () => undefined)];
  const seenTools: string[][] = [];
  let n = 0;
  const modelCall: ModelCall = async (args) => {
    seenTools.push(toolNames(args));
    n += 1;
    if (n === 1) return { content: '', tool_calls: [{ id: 'c1', function: { name: 'search_tools', arguments: JSON.stringify({ query: 'weather forecast' }) } }] };
    if (n === 2) return { content: '', tool_calls: [{ id: 'c2', function: { name: 'mcp__weather__forecast', arguments: '{}' } }] };
    return { content: '完成。' };
  };
  const approvals = { request: () => ({ id: 'connector_approval', promise: Promise.resolve('once') }) };
  const out = await runAgentChat({ prompt: '查天气', kimiConfig: TEST_LOCAL_MODEL_CONFIG, trustedRoot: root, tools: core, lazyTools: lazy, modelCall, approvals, runStoreRoot: path.join(root, 'runs') });

  // Turn 1: the lazy tool is NOT exposed, but search_tools IS.
  const firstTurnTools = seenToolNames(seenTools, 0);
  assert.ok(firstTurnTools.includes('search_tools'), 'search_tools exposed initially');
  assert.ok(!firstTurnTools.includes('mcp__weather__forecast'), 'lazy tool hidden initially');
  // Turn 2: after activation the lazy tool becomes available to the model.
  assert.ok(seenToolNames(seenTools, 1).includes('mcp__weather__forecast'), 'lazy tool activated after search');
  assert.equal(ran, true, `activated lazy tool executed: ${JSON.stringify(out.steps)}`);
  assert.equal(out.text, '完成。');
});

test('no search_tools meta-tool when there are no lazy tools (unchanged behavior)', async () => {
  const root = tmp();
  const core = [lowTool('Read', () => undefined)];
  const seen: { value: string[] | null } = { value: null };
  const modelCall: ModelCall = async (args) => { seen.value = toolNames(args); return { content: 'ok' }; };
  await runAgentChat({ prompt: 'x', kimiConfig: TEST_LOCAL_MODEL_CONFIG, trustedRoot: root, tools: core, lazyTools: [], modelCall, runStoreRoot: path.join(root, 'runs') });
  const names = seen.value;
  assert.ok(names);
  assert.ok(!names.includes('search_tools'), 'no meta-tool when nothing lazy');
});

test('addLazySearchTool ignores malformed lazy tool collections without mutating core tools', () => {
  const core = [lowTool('Read', () => undefined)];
  const toolMap = addLazySearchTool(core, null as unknown as AgentTool[]);

  assert.equal(toolMap.has('Read'), true);
  assert.equal(toolMap.has('search_tools'), false);
  assert.deepEqual(core.map((tool) => tool.name), ['Read']);
});

test('addLazySearchTool ranks, activates, and de-duplicates lazy tools on demand', async () => {
  const core = [lowTool('Read', () => undefined), lowTool('mcp__already__active', () => undefined)];
  const lazy = [
    lowTool('mcp__weather__forecast', () => undefined),
    lowTool('mcp__calendar__list', () => undefined),
    lowTool('mcp__already__active', () => undefined),
  ];
  const toolMap = addLazySearchTool(core, lazy);
  const search = toolMap.get('search_tools');
  assert.equal(search?.risk, 'safe');
  assert.equal(search?.mutating, false);
  if (typeof search?.handler !== 'function') throw new Error('search_tools handler should be present');
  const searchHandler = search.handler;

  const first = await searchHandler({ query: 'weather forecast', limit: 1 });
  assert.deepEqual(first, { activated: [{ name: 'mcp__weather__forecast', description: 'mcp__weather__forecast tool' }] });
  assert.equal(toolMap.has('mcp__weather__forecast'), true);
  assert.equal(core.filter((tool) => tool.name === 'mcp__weather__forecast').length, 1);

  const second = await searchHandler({ query: '', limit: 50 });
  assert.deepEqual(second, { activated: [{ name: 'mcp__calendar__list', description: 'mcp__calendar__list tool' }] });
  assert.equal(core.filter((tool) => tool.name === 'mcp__already__active').length, 1);
  assert.equal(core.some((tool) => tool.name === 'mcp__calendar__list'), true);
});

test('addLazySearchTool clamps empty-query activation to twenty lazy tools', async () => {
  const core = [lowTool('Read', () => undefined)];
  const lazy = Array.from({ length: 25 }, (_, index) => lowTool(`mcp__bulk__tool_${String(index + 1).padStart(2, '0')}`, () => undefined));
  const toolMap = addLazySearchTool(core, lazy);
  const search = toolMap.get('search_tools');
  if (typeof search?.handler !== 'function') throw new Error('search_tools handler should be present');

  const result = await search.handler({ query: '', limit: 100 });
  const activated = (result as { activated?: Array<{ name: string }> }).activated ?? [];

  assert.equal(activated.length, 20);
  assert.equal(activated[0]?.name, 'mcp__bulk__tool_01');
  assert.equal(activated.at(-1)?.name, 'mcp__bulk__tool_20');
  assert.equal(core.length, 22);
  assert.equal(core.some((tool) => tool.name === 'search_tools'), true);
  assert.equal(toolMap.has('mcp__bulk__tool_21'), false);
});

test('parseToolCall tolerates malformed JSON arguments and missing function names', () => {
  assert.deepEqual(parseToolCall({ function: { name: 'Read', arguments: '{"path":"README.md"}' } }), {
    name: 'Read',
    args: { path: 'README.md' },
  });
  assert.deepEqual(parseToolCall({ function: { name: 'Read', arguments: '{bad json' } }), {
    name: 'Read',
    args: {},
  });
  assert.deepEqual(parseToolCall({}), {
    name: undefined,
    args: {},
  });
});

test('createNoopBudgetGuard never aborts and exposes a stable stop message', () => {
  const guard = createNoopBudgetGuard();
  const checked = guard.check();
  const recorded = guard.recordUsage();
  assert.equal(checked, recorded);
  assert.equal(checked.shouldAbort, false);
  assert.equal(checked.snapshot.model, 'default');
  assert.match(guard.stopMessage(), /预算保护/);
});
