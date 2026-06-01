import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runAgentChat } from '../src/kimi/agent-runner.js';
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
  const out = await runAgentChat({ prompt: '查天气', kimiConfig: { model: 'fake' }, trustedRoot: root, tools: core, lazyTools: lazy, modelCall, runStoreRoot: path.join(root, 'runs') });

  // Turn 1: the lazy tool is NOT exposed, but search_tools IS.
  const firstTurnTools = seenToolNames(seenTools, 0);
  assert.ok(firstTurnTools.includes('search_tools'), 'search_tools exposed initially');
  assert.ok(!firstTurnTools.includes('mcp__weather__forecast'), 'lazy tool hidden initially');
  // Turn 2: after activation the lazy tool becomes available to the model.
  assert.ok(seenToolNames(seenTools, 1).includes('mcp__weather__forecast'), 'lazy tool activated after search');
  assert.equal(ran, true, 'activated lazy tool executed');
  assert.equal(out.text, '完成。');
});

test('no search_tools meta-tool when there are no lazy tools (unchanged behavior)', async () => {
  const root = tmp();
  const core = [lowTool('Read', () => undefined)];
  const seen: { value: string[] | null } = { value: null };
  const modelCall: ModelCall = async (args) => { seen.value = toolNames(args); return { content: 'ok' }; };
  await runAgentChat({ prompt: 'x', kimiConfig: { model: 'fake' }, trustedRoot: root, tools: core, lazyTools: [], modelCall, runStoreRoot: path.join(root, 'runs') });
  const names = seen.value;
  assert.ok(names);
  assert.ok(!names.includes('search_tools'), 'no meta-tool when nothing lazy');
});
