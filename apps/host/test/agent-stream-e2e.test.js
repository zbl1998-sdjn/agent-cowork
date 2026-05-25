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

test('E2E /api/agent/chat/stream: resumeRunId continues from checkpoint without replaying writes', async () => {
  const root = tmp();
  let firstRunCalls = 0;
  let resumeMode = false;
  let resumedSawToolResult = false;
  const agentModelCall = async ({ messages }) => {
    const sawToolResult = Array.isArray(messages)
      && messages.some((message) => message.role === 'tool' && message.tool_call_id === 'c1');
    if (resumeMode && sawToolResult) {
      resumedSawToolResult = true;
      return { content: '续跑完成。', usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } };
    }
    if (!resumeMode) {
      firstRunCalls += 1;
      if (firstRunCalls === 1) {
        return {
          content: '',
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          tool_calls: [{
            id: 'c1',
            function: { name: 'Write', arguments: JSON.stringify({ path: 'resume.txt', content: 'first' }) },
          }],
        };
      }
      throw new Error('simulated crash after checkpoint');
    }
    return {
      content: '',
      tool_calls: [{
        id: 'c_replay',
        function: { name: 'Write', arguments: JSON.stringify({ path: 'resume.txt', content: 'replayed' }) },
      }],
    };
  };
  const server = createServer({ trustedRoot: root, enableScheduler: false, kimiChatRunner: async () => ({}), agentModelCall });
  const base = await bind(server);
  try {
    const first = await fetch(`${base}/api/agent/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: '写入后模拟崩溃', autoApprove: true }),
    });
    const firstText = await readStream(first);
    assert.match(firstText, /event: error/);
    const runId = JSON.parse(/event: start\s+data: ([^\n]+)/.exec(firstText)[1]).runId;
    assert.ok(runId, 'first run emitted runId');
    assert.equal(fs.readFileSync(path.join(root, 'resume.txt'), 'utf8'), 'first');

    resumeMode = true;
    const resumed = await fetch(`${base}/api/agent/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ resumeRunId: runId, autoApprove: true }),
    });
    assert.equal(resumed.status, 200);
    const resumedText = await readStream(resumed);
    assert.match(resumedText, /"resumed":true/);
    assert.match(resumedText, /event: done/);
    assert.match(resumedText, /续跑完成/);
    assert.equal(resumedSawToolResult, true);
    assert.equal(fs.readFileSync(path.join(root, 'resume.txt'), 'utf8'), 'first');
  } finally {
    await closeTestServer(server);
  }
});
