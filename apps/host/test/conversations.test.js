import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from '../src/server.js';
import { FileConversationStore } from '../src/storage/conversation-store.js';
import { makeTestWorkspace } from './test-fixtures.js';

async function withServer(config, fn) {
  const server = createServer(config);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await fn(baseUrl, server);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function registerUser(baseUrl, username) {
  const res = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: 'passw0rd' }),
  });
  assert.equal(res.status, 200, `register ${username}`);
  return (await res.json()).token;
}

test('conversations are isolated per signed-in user', async () => {
  const trustedRoot = makeTestWorkspace('kcw-conv');
  await withServer({ trustedRoot }, async (baseUrl) => {
    const tokenA = await registerUser(baseUrl, 'alice');
    const tokenB = await registerUser(baseUrl, 'bob');
    const authA = { authorization: `Bearer ${tokenA}`, 'content-type': 'application/json' };
    const authB = { authorization: `Bearer ${tokenB}`, 'content-type': 'application/json' };

    let res = await fetch(`${baseUrl}/api/conversations/c1`, {
      method: 'PUT',
      headers: authA,
      body: JSON.stringify({ title: 'Alice 的对话', messages: [{ role: 'user', text: 'hi' }] }),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).conversation.title, 'Alice 的对话');

    res = await fetch(`${baseUrl}/api/conversations`, { headers: authA });
    const list = (await res.json()).conversations;
    assert.equal(list.length, 1);
    assert.equal(list[0].id, 'c1');

    res = await fetch(`${baseUrl}/api/conversations`, { headers: authB });
    assert.deepEqual((await res.json()).conversations, []);

    res = await fetch(`${baseUrl}/api/conversations/c1`, { headers: authB });
    assert.equal(res.status, 404);

    res = await fetch(`${baseUrl}/api/conversations/c1`, { headers: authA });
    assert.equal(res.status, 200);
    const full = (await res.json()).conversation;
    assert.equal(full.messages.length, 1);
    assert.ok(full.createdAt && full.updatedAt);

    res = await fetch(`${baseUrl}/api/conversations/c1`, { method: 'DELETE', headers: authA });
    assert.equal((await res.json()).deleted, true);
    res = await fetch(`${baseUrl}/api/conversations`, { headers: authA });
    assert.deepEqual((await res.json()).conversations, []);
  });
});

test('upsert preserves createdAt and updates title/messages', async () => {
  const trustedRoot = makeTestWorkspace('kcw-conv-upsert');
  await withServer({ trustedRoot }, async (baseUrl) => {
    const token = await registerUser(baseUrl, 'carol');
    const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    let res = await fetch(`${baseUrl}/api/conversations/x1`, {
      method: 'PUT', headers: auth, body: JSON.stringify({ title: 'v1', messages: [] }),
    });
    const created = (await res.json()).conversation;
    await new Promise((r) => setTimeout(r, 5));
    res = await fetch(`${baseUrl}/api/conversations/x1`, {
      method: 'PUT', headers: auth, body: JSON.stringify({ title: 'v2', pinned: true, messages: [{ role: 'user', text: 'a' }] }),
    });
    assert.equal(res.status, 200);
    res = await fetch(`${baseUrl}/api/conversations/x1`, { headers: auth });
    const full = (await res.json()).conversation;
    assert.equal(full.title, 'v2');
    assert.equal(full.pinned, true);
    assert.equal(full.createdAt, created.createdAt);
    assert.ok(full.updatedAt >= created.updatedAt);
  });
});

test('conversation storage preserves branch metadata and active branch', async () => {
  const trustedRoot = makeTestWorkspace('kcw-conv-branches');
  await withServer({ trustedRoot }, async (baseUrl) => {
    const token = await registerUser(baseUrl, 'dana');
    const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const branches = [
      { id: 'main', title: '主线', messages: [{ id: 'u1', role: 'user', text: '原问题' }, { id: 'a1', role: 'assistant', text: '原回答' }] },
      { id: 'b1', title: '分支 1', parentBranchId: 'main', baseMessageId: 'u1', messages: [{ id: 'u2', role: 'user', text: '新问题' }] },
    ];

    let res = await fetch(`${baseUrl}/api/conversations/branched`, {
      method: 'PUT',
      headers: auth,
      body: JSON.stringify({ title: '有分支', messages: branches[1].messages, activeBranchId: 'b1', branches }),
    });
    assert.equal(res.status, 200);
    const summary = (await res.json()).conversation;
    assert.equal(summary.branchCount, 2);
    assert.equal(summary.activeBranchId, 'b1');

    res = await fetch(`${baseUrl}/api/conversations/branched`, { headers: auth });
    assert.equal(res.status, 200);
    const full = (await res.json()).conversation;
    assert.equal(full.activeBranchId, 'b1');
    assert.equal(full.branches.length, 2);
    assert.deepEqual(full.branches.map((branch) => branch.id), ['main', 'b1']);
    assert.equal(full.branches[0].messages.length, 2);
  });
});

test('FileConversationStore rejects path-traversal ids and isolates by tenant', () => {
  const trustedRoot = makeTestWorkspace('kcw-conv-unit');
  const store = new FileConversationStore();
  assert.throws(() => store.save(trustedRoot, { id: '../escape', messages: [] }, { tenantId: 't1', userId: 'u1' }), /invalid conversation id/);
  store.save(trustedRoot, { id: 'k', title: 't', messages: [] }, { tenantId: 't1', userId: 'u1' });
  assert.deepEqual(store.list(trustedRoot, { tenantId: 't2', userId: 'u1' }), []);
  assert.deepEqual(store.list(trustedRoot, { tenantId: 't1', userId: 'u2' }), []);
  assert.equal(store.list(trustedRoot, { tenantId: 't1', userId: 'u1' }).length, 1);
  const base = path.join(trustedRoot, '.AgentCowork', 'conversations');
  assert.ok(fs.existsSync(path.join(base, 't1', 'u1', 'k.json')));
});
