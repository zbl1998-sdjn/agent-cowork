import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { runAgentChat } from '../src/kimi/agent-runner.js';
import { makeTestWorkspace } from './test-fixtures.js';
import { TEST_LOCAL_MODEL_CONFIG } from './helpers/kimi-config.js';

type EmittedEvent = {
  t: string;
  d: unknown;
};

function fileWrittenPayload(event: EmittedEvent): { path: string } {
  assert.ok(event.d && typeof event.d === 'object');
  const payload = event.d as { path?: unknown };
  if (typeof payload.path !== 'string') throw new Error('file_written payload path must be a string');
  return { path: payload.path };
}

// Use the repo-local workspace root (not os.tmpdir(), which on Windows resolves
// under AppData and is — correctly — never a real user workspace).
function tmp() { return makeTestWorkspace('kcw-fw'); }

test('successful Write emits a file_written frame with the path (for openable artifact cards)', async () => {
  const root = tmp();
  const events: EmittedEvent[] = [];
  let n = 0;
  const modelCall = async () => {
    n += 1;
    if (n === 1) return { content: '', tool_calls: [{ id: 'c1', function: { name: 'Write', arguments: JSON.stringify({ path: 'report.md', content: '# hi' }) } }] };
    return { content: '已生成 report.md。' };
  };
  const approvals = { request: () => ({ id: 'write_approval', promise: Promise.resolve('once') }) };
  await runAgentChat({ prompt: '写报告', kimiConfig: TEST_LOCAL_MODEL_CONFIG, trustedRoot: root, modelCall, approvals, emit: (t, d) => events.push({ t, d }), runStoreRoot: path.join(root, 'runs') });
  const fw = events.filter((e) => e.t === 'file_written');
  assert.equal(fw.length, 1, 'one file_written frame');
  assert.ok(fw[0]);
  assert.equal(fileWrittenPayload(fw[0]).path, 'report.md');
});

test('read-only tools do not emit file_written', async () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'a.txt'), 'x', 'utf8');
  const events: EmittedEvent[] = [];
  let n = 0;
  const modelCall = async () => {
    n += 1;
    if (n === 1) return { content: '', tool_calls: [{ id: 'c1', function: { name: 'Read', arguments: JSON.stringify({ path: 'a.txt' }) } }] };
    return { content: '读完了。' };
  };
  await runAgentChat({ prompt: '看文件', kimiConfig: TEST_LOCAL_MODEL_CONFIG, trustedRoot: root, modelCall, emit: (t, d) => events.push({ t, d }), runStoreRoot: path.join(root, 'runs') });
  assert.equal(events.filter((e) => e.t === 'file_written').length, 0);
});
