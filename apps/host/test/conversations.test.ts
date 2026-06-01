import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from '../src/server.js';
import { FileConversationStore } from '../src/storage/conversation-store.js';
import { bind, close, recordArray, recordValue, stringField } from './helpers/host-http.js';
import { makeTestWorkspace } from './test-fixtures.js';
import type { ServerConfig, HostServer } from '../src/server.js';

type JsonRecord = Record<string, unknown>;

async function withServer(config: ServerConfig, fn: (baseUrl: string, server: HostServer) => Promise<void>): Promise<void> {
  const server = createServer(config);
  const baseUrl = await bind(server);
  try {
    await fn(baseUrl, server);
  } finally {
    await close(server);
  }
}

async function jsonRecord(response: Response, label: string): Promise<JsonRecord> {
  return recordValue(await response.json() as unknown, label);
}

async function conversationFrom(response: Response, label: string): Promise<JsonRecord> {
  return recordValue((await jsonRecord(response, `${label} response`)).conversation, label);
}

async function conversationListFrom(response: Response, label: string): Promise<JsonRecord[]> {
  return recordArray((await jsonRecord(response, `${label} response`)).conversations, label);
}

async function registerUser(baseUrl: string, username: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: 'passw0rd' }),
  });
  assert.equal(res.status, 200, `register ${username}`);
  return stringField(await jsonRecord(res, `register ${username}`), 'token');
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
    assert.equal((await conversationFrom(res, 'Alice conversation')).title, 'Alice 的对话');

    res = await fetch(`${baseUrl}/api/conversations`, { headers: authA });
    const list = await conversationListFrom(res, 'Alice conversations');
    assert.equal(list.length, 1);
    const [conversation] = list;
    assert.ok(conversation, 'Alice conversation summary should exist');
    assert.equal(conversation.id, 'c1');

    res = await fetch(`${baseUrl}/api/conversations`, { headers: authB });
    assert.deepEqual(await conversationListFrom(res, 'Bob conversations'), []);

    res = await fetch(`${baseUrl}/api/conversations/c1`, { headers: authB });
    assert.equal(res.status, 404);

    res = await fetch(`${baseUrl}/api/conversations/c1`, { headers: authA });
    assert.equal(res.status, 200);
    const full = await conversationFrom(res, 'full conversation');
    assert.equal(recordArray(full.messages, 'full conversation messages').length, 1);
    assert.ok(full.createdAt && full.updatedAt);

    res = await fetch(`${baseUrl}/api/conversations/c1`, { method: 'DELETE', headers: authA });
    assert.equal((await jsonRecord(res, 'delete conversation response')).deleted, true);
    res = await fetch(`${baseUrl}/api/conversations`, { headers: authA });
    assert.deepEqual(await conversationListFrom(res, 'Alice conversations after delete'), []);
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
    const created = await conversationFrom(res, 'created conversation');
    await new Promise((r) => setTimeout(r, 5));
    res = await fetch(`${baseUrl}/api/conversations/x1`, {
      method: 'PUT', headers: auth, body: JSON.stringify({ title: 'v2', pinned: true, messages: [{ role: 'user', text: 'a' }] }),
    });
    assert.equal(res.status, 200);
    res = await fetch(`${baseUrl}/api/conversations/x1`, { headers: auth });
    const full = await conversationFrom(res, 'updated conversation');
    assert.equal(full.title, 'v2');
    assert.equal(full.pinned, true);
    assert.equal(stringField(full, 'createdAt'), stringField(created, 'createdAt'));
    assert.ok(stringField(full, 'updatedAt') >= stringField(created, 'updatedAt'));

    res = await fetch(`${baseUrl}/api/conversations/bad-body`, {
      method: 'PUT',
      headers: auth,
      body: JSON.stringify({ title: ['not-valid'], pinned: 'true' }),
    });
    assert.equal(res.status, 400);
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
      body: JSON.stringify({ title: '有分支', messages: branches[1]?.messages || [], activeBranchId: 'b1', branches }),
    });
    assert.equal(res.status, 200);
    const summary = await conversationFrom(res, 'branched summary');
    assert.equal(summary.branchCount, 2);
    assert.equal(summary.activeBranchId, 'b1');

    res = await fetch(`${baseUrl}/api/conversations/branched`, { headers: auth });
    assert.equal(res.status, 200);
    const full = await conversationFrom(res, 'branched full conversation');
    assert.equal(full.activeBranchId, 'b1');
    const savedBranches = recordArray(full.branches, 'saved branches');
    assert.equal(savedBranches.length, 2);
    assert.deepEqual(savedBranches.map((branch) => branch.id), ['main', 'b1']);
    const [mainBranch] = savedBranches;
    assert.ok(mainBranch, 'main branch should exist');
    assert.equal(recordArray(mainBranch.messages, 'main branch messages').length, 2);
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
