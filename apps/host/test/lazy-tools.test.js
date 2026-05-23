import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runAgentChat } from '../src/kimi/agent-runner.js';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-lazy-')); }

function lowTool(name, onRun) {
  return { name, risk: 'low', mutating: false, description: `${name} tool`, parameters: { type: 'object', properties: {} }, handler: async () => { onRun(); return { ok: true, from: name }; } };
}

test('lazy tools are hidden until search_tools activates them, then callable', async () => {
  const root = tmp();
  let ran = false;
  const lazy = [lowTool('mcp__weather__forecast', () => { ran = true; })];
  const core = [lowTool('Read', () => {})];
  const seenTools = [];
  let n = 0;
  const modelCall = async ({ tools }) => {
    seenTools.push(tools.map((t) => t.function.name));
    n += 1;
    if (n === 1) return { content: '', tool_calls: [{ id: 'c1', function: { name: 'search_tools', arguments: JSON.stringify({ query: 'weather forecast' }) } }] };
    if (n === 2) return { content: '', tool_calls: [{ id: 'c2', function: { name: 'mcp__weather__forecast', arguments: '{}' } }] };
    return { content: '完成。' };
  };
  const out = await runAgentChat({ prompt: '查天气', kimiConfig: { model: 'fake' }, trustedRoot: root, tools: core, lazyTools: lazy, modelCall, runStoreRoot: path.join(root, 'runs') });

  // Turn 1: the lazy tool is NOT exposed, but search_tools IS.
  assert.ok(seenTools[0].includes('search_tools'), 'search_tools exposed initially');
  assert.ok(!seenTools[0].includes('mcp__weather__forecast'), 'lazy tool hidden initially');
  // Turn 2: after activation the lazy tool becomes available to the model.
  assert.ok(seenTools[1].includes('mcp__weather__forecast'), 'lazy tool activated after search');
  assert.equal(ran, true, 'activated lazy tool executed');
  assert.equal(out.text, '完成。');
});

test('no search_tools meta-tool when there are no lazy tools (unchanged behavior)', async () => {
  const root = tmp();
  const core = [lowTool('Read', () => {})];
  let seen = null;
  const modelCall = async ({ tools }) => { seen = tools.map((t) => t.function.name); return { content: 'ok' }; };
  await runAgentChat({ prompt: 'x', kimiConfig: { model: 'fake' }, trustedRoot: root, tools: core, lazyTools: [], modelCall, runStoreRoot: path.join(root, 'runs') });
  assert.ok(!seen.includes('search_tools'), 'no meta-tool when nothing lazy');
});
