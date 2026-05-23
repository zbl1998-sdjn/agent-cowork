import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createServer } from '../src/server.js';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-vis-')); }
async function bind(s) { await new Promise((r) => s.listen(0, '127.0.0.1', r)); return `http://127.0.0.1:${s.address().port}`; }

test('E2E: agent stream attaches uploaded images as multipart image_url content', async () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'shot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]));
  let captured = null;
  const agentModelCall = async ({ messages }) => { captured = messages; return { content: '我看到一张图片。' }; };
  const server = createServer({ trustedRoot: root, enableScheduler: false, kimiChatRunner: async () => ({}), agentModelCall });
  const base = await bind(server);
  try {
    const res = await fetch(`${base}/api/agent/chat/stream`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: '这是什么图', images: ['shot.png'] }) });
    assert.equal(res.status, 200);
    await res.text();
    const userMsg = captured.find((m) => m.role === 'user');
    assert.ok(Array.isArray(userMsg.content), 'user content is multipart array');
    assert.ok(userMsg.content.some((p) => p.type === 'image_url' && /^data:image\/png;base64,/.test(p.image_url.url)), 'has image_url part');
    assert.ok(userMsg.content.some((p) => p.type === 'text' && /这是什么图/.test(p.text)), 'has text part');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('E2E: agent stream without images keeps a plain string user message', async () => {
  const root = tmp();
  let captured = null;
  const agentModelCall = async ({ messages }) => { captured = messages; return { content: 'ok' }; };
  const server = createServer({ trustedRoot: root, enableScheduler: false, kimiChatRunner: async () => ({}), agentModelCall });
  const base = await bind(server);
  try {
    await (await fetch(`${base}/api/agent/chat/stream`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: '只是文字' }) })).text();
    const userMsg = captured.find((m) => m.role === 'user');
    assert.equal(typeof userMsg.content, 'string');
    assert.equal(userMsg.content, '只是文字');
  } finally {
    await new Promise((r) => server.close(r));
  }
});
