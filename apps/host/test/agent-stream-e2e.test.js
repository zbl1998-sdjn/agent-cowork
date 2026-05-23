import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createServer } from '../src/server.js';
import { closeTestServer } from './helpers/close-server.js';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-e2e-')); }
async function bind(s) { await new Promise((r) => s.listen(0, '127.0.0.1', r)); return `http://127.0.0.1:${s.address().port}`; }
async function readStream(res) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let all = '';
  for (;;) { const { value, done } = await reader.read(); if (done) break; all += dec.decode(value, { stream: true }); }
  return all;
}

test('E2E /api/agent/chat/stream: file_written + verify_start + done (deep thinking)', async () => {
  const root = tmp();
  let n = 0;
  const agentModelCall = async () => {
    n += 1;
    if (n === 1) return { content: '', tool_calls: [{ id: 'c1', function: { name: 'Write', arguments: JSON.stringify({ path: 'report.md', content: '# 报告' }) } }] };
    if (n === 2) return { content: '初稿完成。' };
    if (n === 3) return { content: '', tool_calls: [{ id: 'c3', function: { name: 'Read', arguments: JSON.stringify({ path: 'report.md' }) } }] };
    return { content: '已核对，report.md 无误。' };
  };
  const server = createServer({ trustedRoot: root, enableScheduler: false, kimiChatRunner: async () => ({}), agentModelCall });
  const base = await bind(server);
  try {
    const res = await fetch(`${base}/api/agent/chat/stream`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: '写报告', autoApprove: true, thinking: 'deep' }) });
    assert.equal(res.status, 200);
    const all = await readStream(res);
    assert.match(all, /event: file_written/);
    assert.match(all, /report\.md/);
    assert.match(all, /event: verify_start/);
    assert.match(all, /event: done/);
    assert.match(all, /已核对/);
    assert.equal(fs.readFileSync(path.join(root, 'report.md'), 'utf8'), '# 报告');
  } finally {
    await closeTestServer(server);
  }
});

test('E2E /api/agent/chat/stream: inline chart fenced block streams through to the client', async () => {
  const root = tmp();
  const chart = '```chart\n{"kind":"bar","data":{"labels":["A","B"],"datasets":[{"data":[1,2]}]}}\n```';
  const agentModelCall = async () => ({ content: `这是结果：\n${chart}` });
  const server = createServer({ trustedRoot: root, enableScheduler: false, kimiChatRunner: async () => ({}), agentModelCall });
  const base = await bind(server);
  try {
    const res = await fetch(`${base}/api/agent/chat/stream`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: '画个图' }) });
    const all = await readStream(res);
    assert.match(all, /event: done/);
    assert.ok(all.includes('chart') && all.includes('bar'), 'chart spec streamed to client for inline rendering');
  } finally {
    await closeTestServer(server);
  }
});

test('E2E /api/agent/chat/stream: lazy tools — connected mcp tools hidden until search_tools activates them', async () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'hi.txt'), 'hi', 'utf8');
  const seen = [];
  let n = 0;
  const agentModelCall = async ({ tools }) => {
    seen.push((tools || []).map((t) => t.function.name));
    n += 1;
    if (n === 1) return { content: '', tool_calls: [{ id: 'c1', function: { name: 'search_tools', arguments: JSON.stringify({ query: 'fs list dir' }) } }] };
    return { content: '已检索到可用工具。' };
  };
  const server = createServer({ trustedRoot: root, enableScheduler: false, kimiChatRunner: async () => ({}), agentModelCall });
  const base = await bind(server);
  try {
    const conn = await fetch(`${base}/api/connectors/connect`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'filesystem', trustedRoot: root }) });
    assert.equal(conn.status, 200);
    const res = await fetch(`${base}/api/agent/chat/stream`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: '列目录', autoApprove: true }) });
    const all = await readStream(res);
    assert.match(all, /event: done/);
    assert.ok(seen[0].includes('search_tools'), 'search_tools meta-tool exposed initially');
    assert.ok(!seen[0].some((nm) => nm.startsWith('mcp__fs__')), 'mcp tools hidden on the first turn');
    assert.ok(seen[1] && seen[1].some((nm) => nm.startsWith('mcp__fs__')), 'mcp tool activated after search_tools');
  } finally {
    await closeTestServer(server);
  }
});
