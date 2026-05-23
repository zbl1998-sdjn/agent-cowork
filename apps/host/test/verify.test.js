import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runAgentChat } from '../src/kimi/agent-runner.js';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-verify-')); }

function mut(name, onRun) {
  return { name, risk: 'low', mutating: true, description: name, parameters: { type: 'object', properties: {} }, handler: async () => { onRun(); return { ok: true }; } };
}
function ro(name, onRun) {
  return { name, risk: 'low', mutating: false, description: name, parameters: { type: 'object', properties: {} }, handler: async () => { onRun(); return { ok: true, read: true }; } };
}

test('verify=true: after a mutation, agent runs a read-only self-check round then finalizes', async () => {
  const root = tmp();
  let readBack = false;
  const tools = [mut('Write', () => {}), ro('Read', () => { readBack = true; })];
  const events = [];
  let n = 0;
  const modelCall = async () => {
    n += 1;
    if (n === 1) return { content: '', tool_calls: [{ id: 'c1', function: { name: 'Write', arguments: '{}' } }] };
    if (n === 2) return { content: '初稿完成。' }; // first "final" -> triggers verification
    if (n === 3) return { content: '', tool_calls: [{ id: 'c3', function: { name: 'Read', arguments: '{}' } }] };
    return { content: '已核对，无误。' };
  };
  const out = await runAgentChat({ prompt: '改文件', kimiConfig: { model: 'fake' }, trustedRoot: root, tools, modelCall, verify: true, emit: (t, d) => events.push({ t, d }), runStoreRoot: path.join(root, 'runs') });

  assert.ok(events.some((e) => e.t === 'verify_start'), 'verify_start emitted');
  assert.equal(readBack, true, 'read-only self-check ran');
  assert.equal(out.text, '已核对，无误。', 'final text is the post-verification summary');
});

test('verify=true but nothing mutated: no verification round', async () => {
  const root = tmp();
  const tools = [ro('Read', () => {})];
  const events = [];
  let n = 0;
  const modelCall = async () => {
    n += 1;
    if (n === 1) return { content: '', tool_calls: [{ id: 'c1', function: { name: 'Read', arguments: '{}' } }] };
    return { content: '只读完成。' };
  };
  const out = await runAgentChat({ prompt: '看一下', kimiConfig: { model: 'fake' }, trustedRoot: root, tools, modelCall, verify: true, emit: (t, d) => events.push({ t, d }), runStoreRoot: path.join(root, 'runs') });
  assert.ok(!events.some((e) => e.t === 'verify_start'), 'no verify when nothing changed');
  assert.equal(out.text, '只读完成。');
});

test('verify=false (default): no self-check even after a mutation', async () => {
  const root = tmp();
  const tools = [mut('Write', () => {})];
  const events = [];
  let n = 0;
  const modelCall = async () => {
    n += 1;
    if (n === 1) return { content: '', tool_calls: [{ id: 'c1', function: { name: 'Write', arguments: '{}' } }] };
    return { content: '完成。' };
  };
  const out = await runAgentChat({ prompt: '改文件', kimiConfig: { model: 'fake' }, trustedRoot: root, tools, modelCall, emit: (t, d) => events.push({ t, d }), runStoreRoot: path.join(root, 'runs') });
  assert.ok(!events.some((e) => e.t === 'verify_start'), 'no verify when verify=false');
  assert.equal(out.text, '完成。');
});
