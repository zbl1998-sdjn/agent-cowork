import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createServer } from '../src/server.js';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-stream-')); }
async function bind(s) { await new Promise((r) => s.listen(0, '127.0.0.1', r)); return `http://127.0.0.1:${s.address().port}`; }

test('POST /api/kimi/chat/stream emits start/token/done SSE frames and records a run', async () => {
  const fakeStream = async ({ prompt, onToken }) => {
    assert.match(prompt, /你好/);
    for (const t of ['你', '好', '世界']) onToken(t);
    return { text: '你好世界', model: 'fake-model' };
  };
  const server = createServer({
    trustedRoot: tmp(),
    enableScheduler: false,
    kimiChatRunner: async () => ({ ok: true, text: 'x' }), // flips kimiApiEnabled on
    kimiChatStreamRunner: fakeStream,
  });
  const base = await bind(server);
  try {
    const res = await fetch(`${base}/api/kimi/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: '你好', model: 'fake-model' }),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/event-stream/);
    const text = await res.text();
    assert.match(text, /event: start/);
    assert.match(text, /event: token/);
    assert.equal((text.match(/event: token/g) || []).length, 3, 'one token frame per delta');
    assert.match(text, /event: done/);
    assert.match(text, /你好世界/);

    const idx = await (await fetch(`${base}/api/runs/index`)).json();
    assert.ok((idx.runs || []).some((r) => r.type === 'kimi-chat'));
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('POST /api/kimi/chat/stream returns 503 when Kimi API is not configured', async () => {
  const server = createServer({ trustedRoot: tmp(), enableScheduler: false });
  const base = await bind(server);
  try {
    const res = await fetch(`${base}/api/kimi/chat/stream`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'hi' }),
    });
    assert.equal(res.status, 503);
    assert.match((await res.json()).error, /需要模型回复时请联网/);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
