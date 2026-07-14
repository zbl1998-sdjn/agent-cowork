import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { handleConversationRoutes } from '../src/routes/conversation-routes.js';
import { createServer } from '../src/server.js';
import { createUserStore } from '../src/auth/user-store.js';
import { FileConversationStore } from '../src/storage/conversation-store.js';
import { assertTrustedPath } from '../src/security/path-policy.js';
import { bind, close, recordArray, recordValue, stringField } from './helpers/host-http.js';
import { makeTestWorkspace } from './test-fixtures.js';
import type { HttpRequestLike, HttpResponseLike } from '../src/http/request-utils.js';
import type { ServerConfig, HostServer } from '../src/server.js';
import { samePathReal } from './helpers/path-swap.js';

type JsonRecord = Record<string, unknown>;
type CapturedResponse = HttpResponseLike & { status: number; body: string; json(): JsonRecord };
type RequestListener = (...args: unknown[]) => void;
type SupportedRequestListener = RequestListener | ((chunk: Buffer | string) => void) | (() => void) | ((error: Error) => void);

class FakeJsonRequest implements HttpRequestLike {
  headers: Record<string, string | string[] | undefined>;
  method: string;
  private readonly listeners = new Map<string, RequestListener[]>();

  constructor(method: string, private readonly body?: unknown) {
    this.method = method;
    this.headers = body === undefined ? {} : { 'content-type': 'application/json' };
    void Promise.resolve().then(() => {
      if (this.body !== undefined) this.emit('data', Buffer.from(JSON.stringify(this.body)));
      this.emit('end');
    });
  }

  on(event: 'data', listener: (chunk: Buffer | string) => void): this;
  on(event: 'end', listener: () => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: string, listener: RequestListener): this;
  on(event: string, listener: SupportedRequestListener): this {
    const listeners = this.listeners.get(event) || [];
    listeners.push(listener as RequestListener);
    this.listeners.set(event, listeners);
    return this;
  }

  resume(): void {
    // Test request bodies are emitted eagerly; there is nothing to drain.
  }

  private emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) || []) listener(...args);
  }
}

function capturedResponse(): CapturedResponse {
  return {
    status: 0,
    body: '',
    writeHead(statusCode) {
      this.status = statusCode;
    },
    end(chunk = '') {
      this.body = String(chunk);
    },
    json() {
      return recordValue(JSON.parse(this.body || '{}') as unknown, 'captured response body');
    },
  };
}

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

test('conversations are isolated per signed-in user', async () => {
  const trustedRoot = makeTestWorkspace('kcw-conv');
  const authStore = createUserStore();
  const tokenA = authStore.createSession(authStore.register('alice', 'passw0rd'));
  const tokenB = authStore.createSession(authStore.register('bob', 'passw0rd'));
  await withServer({ trustedRoot, authStore }, async (baseUrl) => {
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
  const authStore = createUserStore();
  const token = authStore.createSession(authStore.register('carol', 'passw0rd'));
  await withServer({ trustedRoot, authStore }, async (baseUrl) => {
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
  const authStore = createUserStore();
  const token = authStore.createSession(authStore.register('dana', 'passw0rd'));
  await withServer({ trustedRoot, authStore }, async (baseUrl) => {
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

test('conversation list supports full/query modes and rejects malformed route inputs', async () => {
  const trustedRoot = makeTestWorkspace('kcw-conv-query');
  const authStore = createUserStore();
  const token = authStore.createSession(authStore.register('erin', 'passw0rd'));
  await withServer({ trustedRoot, authStore }, async (baseUrl) => {
    const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    for (const item of [
      { id: 'needle-a', title: 'Needle Alpha', text: 'first' },
      { id: 'needle-b', title: 'Needle Beta', text: 'second' },
      { id: 'other', title: 'Other Topic', text: 'third' },
    ]) {
      const saved = await fetch(`${baseUrl}/api/conversations/${item.id}`, {
        method: 'PUT',
        headers: auth,
        body: JSON.stringify({ title: item.title, messages: [{ role: 'user', text: item.text }] }),
      });
      assert.equal(saved.status, 200);
    }

    let res = await fetch(`${baseUrl}/api/conversations?full=1&limit=1`, { headers: auth });
    assert.equal(res.status, 200);
    let body = await jsonRecord(res, 'full list response');
    let conversations = recordArray(body.conversations, 'full conversations');
    assert.equal(conversations.length, 1);
    assert.equal(recordArray(conversations[0]?.messages, 'full conversation messages').length, 1);

    res = await fetch(`${baseUrl}/api/conversations?q=needle&limit=1&offset=-5`, { headers: auth });
    assert.equal(res.status, 200);
    body = await jsonRecord(res, 'query response');
    conversations = recordArray(body.conversations, 'query conversations');
    assert.equal(body.total, 2);
    assert.equal(body.limit, 1);
    assert.equal(body.offset, 0);
    assert.equal(conversations.length, 1);
    assert.match(String(conversations[0]?.title), /Needle/);

    res = await fetch(`${baseUrl}/api/conversations?limit=not-a-number`, { headers: auth });
    assert.equal(res.status, 400);
    assert.match(String((await jsonRecord(res, 'bad limit response')).error), /number/i);

    const outsideRoot = encodeURIComponent(path.dirname(trustedRoot));
    res = await fetch(`${baseUrl}/api/conversations?trustedRoot=${outsideRoot}`, { headers: auth });
    assert.equal(res.status, 400);
    assert.match(String((await jsonRecord(res, 'bad root response')).error), /outside|trusted/i);

    res = await fetch(`${baseUrl}/api/conversations/%E0%A4%A`, { headers: auth });
    assert.equal(res.status, 400);
    assert.match(String((await jsonRecord(res, 'bad id response')).error), /invalid conversation id/i);
  });
});

test('conversation route error paths fail closed for missing records and store failures', async () => {
  const trustedRoot = makeTestWorkspace('kcw-conv-route-errors');
  const requestContext = { tenantId: 'tenant-route', userId: 'user-route', traceId: 'trace-route' };
  const store = {
    list: () => [],
    get: (_root: string, id: string) => (id === 'throws' ? Promise.reject(new Error('get failed')) : null),
    save: () => {
      throw new Error('save refused');
    },
    remove: () => {
      throw new Error('remove refused');
    },
  };

  let response = capturedResponse();
  assert.equal(await handleConversationRoutes({
    request: new FakeJsonRequest('GET'),
    response,
    pathname: '/api/conversations/missing',
    requestUrl: new URL('http://local/api/conversations/missing'),
    requestContext,
    trustedRootDefault: trustedRoot,
    safeTrustedRoot: (value) => assertTrustedPath(path.resolve(String(value || trustedRoot)), trustedRoot),
    conversationStore: store,
  }), true);
  assert.equal(response.status, 404);
  assert.match(String(response.json().error), /not found/i);

  response = capturedResponse();
  assert.equal(await handleConversationRoutes({
    request: new FakeJsonRequest('GET'),
    response,
    pathname: '/api/conversations/throws',
    requestUrl: new URL('http://local/api/conversations/throws'),
    requestContext,
    trustedRootDefault: trustedRoot,
    safeTrustedRoot: (value) => assertTrustedPath(path.resolve(String(value || trustedRoot)), trustedRoot),
    conversationStore: store,
  }), true);
  assert.equal(response.status, 400);
  assert.match(String(response.json().error), /get failed/);

  response = capturedResponse();
  assert.equal(await handleConversationRoutes({
    request: new FakeJsonRequest('PUT', { title: 'bad save' }),
    response,
    pathname: '/api/conversations/save-fails',
    requestUrl: new URL('http://local/api/conversations/save-fails'),
    requestContext,
    trustedRootDefault: trustedRoot,
    safeTrustedRoot: (value) => assertTrustedPath(path.resolve(String(value || trustedRoot)), trustedRoot),
    conversationStore: store,
  }), true);
  assert.equal(response.status, 400);
  assert.match(String(response.json().error), /save refused/);

  response = capturedResponse();
  assert.equal(await handleConversationRoutes({
    request: new FakeJsonRequest('PUT', { trustedRoot: path.dirname(trustedRoot), title: 'escaped root' }),
    response,
    pathname: '/api/conversations/root-escape',
    requestUrl: new URL('http://local/api/conversations/root-escape'),
    requestContext,
    trustedRootDefault: trustedRoot,
    safeTrustedRoot: (value) => assertTrustedPath(path.resolve(String(value || trustedRoot)), trustedRoot),
    conversationStore: store,
  }), true);
  assert.equal(response.status, 400);
  assert.match(String(response.json().error), /outside|trusted/i);

  response = capturedResponse();
  assert.equal(await handleConversationRoutes({
    request: new FakeJsonRequest('DELETE'),
    response,
    pathname: '/api/conversations/remove-fails',
    requestUrl: new URL('http://local/api/conversations/remove-fails'),
    requestContext,
    trustedRootDefault: trustedRoot,
    safeTrustedRoot: (value) => assertTrustedPath(path.resolve(String(value || trustedRoot)), trustedRoot),
    conversationStore: store,
  }), true);
  assert.equal(response.status, 400);
  assert.match(String(response.json().error), /remove refused/);

  response = capturedResponse();
  assert.equal(await handleConversationRoutes({
    request: new FakeJsonRequest('POST'),
    response,
    pathname: '/api/conversations/remove-fails',
    requestUrl: new URL('http://local/api/conversations/remove-fails'),
    requestContext,
    trustedRootDefault: trustedRoot,
    safeTrustedRoot: (value) => assertTrustedPath(path.resolve(String(value || trustedRoot)), trustedRoot),
    conversationStore: store,
  }), false);
  assert.equal(response.status, 0);
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
  const ownerDirectories = fs.readdirSync(base);
  assert.equal(ownerDirectories.length, 1);
  assert.match(ownerDirectories[0] || '', /^v1-[a-f0-9]{64}$/);
  assert.ok(fs.existsSync(path.join(base, ownerDirectories[0] || '', 'k.json')));
});

test('FileConversationStore owner keys do not collide after sanitizing or truncation', () => {
  const trustedRoot = makeTestWorkspace('kcw-conv-owner-collision');
  const store = new FileConversationStore();
  const pairs = [
    [
      { tenantId: 'tenant-collision', userId: 'alice/slash' },
      { tenantId: 'tenant-collision', userId: 'alice_slash' },
    ],
    [
      { tenantId: 'tenant/slash', userId: 'same-user' },
      { tenantId: 'tenant_slash', userId: 'same-user' },
    ],
    [
      { tenantId: 'tenant-long', userId: `${'u'.repeat(96)}A` },
      { tenantId: 'tenant-long', userId: `${'u'.repeat(96)}B` },
    ],
  ] as const;

  for (const [ownerA, ownerB] of pairs) {
    store.save(trustedRoot, { id: 'shared', title: 'Alice secret', messages: [{ role: 'user', text: 'secret' }] }, ownerA);
    assert.equal(store.get(trustedRoot, 'shared', ownerB), null);
    assert.deepEqual(store.list(trustedRoot, ownerB), []);
    assert.deepEqual(store.listFull(trustedRoot, ownerB), []);
    assert.equal(store.query(trustedRoot, ownerB, { q: 'Alice' }).total, 0);
    assert.equal(store.remove(trustedRoot, 'shared', ownerB), false);

    store.save(trustedRoot, { id: 'shared', title: 'Bob private', messages: [] }, ownerB);
    assert.equal(store.get(trustedRoot, 'shared', ownerA)?.title, 'Alice secret');
    assert.equal(store.get(trustedRoot, 'shared', ownerB)?.title, 'Bob private');
    assert.equal(store.remove(trustedRoot, 'shared', ownerB), true);
    assert.equal(store.get(trustedRoot, 'shared', ownerA)?.title, 'Alice secret');
    assert.equal(store.remove(trustedRoot, 'shared', ownerA), true);
  }
});

test('FileConversationStore delete failure cannot revive a legacy local copy', () => {
  const trustedRoot = makeTestWorkspace('kcw-conv-legacy-delete');
  const store = new FileConversationStore();
  const context = { tenantId: 'tenant_local', userId: 'user_local' };
  const base = path.join(trustedRoot, '.AgentCowork', 'conversations');
  const legacyDirectory = path.join(base, 'tenant_local', 'user_local');
  const legacyFile = path.join(legacyDirectory, 'shared.json');
  fs.mkdirSync(legacyDirectory, { recursive: true });
  fs.writeFileSync(legacyFile, JSON.stringify({
    id: 'shared',
    title: 'Legacy body',
    pinned: false,
    messages: [],
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
  }), 'utf8');
  store.save(trustedRoot, { id: 'shared', title: 'Current body', messages: [] }, context);
  const currentDirectory = fs.readdirSync(base).find((name) => /^v1-[a-f0-9]{64}$/.test(name));
  assert.ok(currentDirectory);
  const currentFile = path.join(base, currentDirectory, 'shared.json');
  assert.ok(fs.existsSync(currentFile));

  const originalUnlinkSync = fs.unlinkSync;
  fs.unlinkSync = ((filePath: string) => {
    if (samePathReal(String(filePath), legacyFile)) throw new Error('legacy file is locked');
    return originalUnlinkSync(filePath);
  }) as typeof fs.unlinkSync;
  try {
    assert.throws(() => store.remove(trustedRoot, 'shared', context), /legacy file is locked/);
    assert.equal(store.get(trustedRoot, 'shared', context)?.title, 'Current body');
    assert.ok(fs.existsSync(currentFile), 'current copy must remain authoritative after a legacy delete failure');
  } finally {
    fs.unlinkSync = originalUnlinkSync;
  }
});
