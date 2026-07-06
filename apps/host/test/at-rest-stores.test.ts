// 落盘加密接入(切片 2b)——run-store / conversation-store 透明加密回环 + 遗留明文兼容
// ---------------------------------------------------------------------------
// 开关(KCW_ENCRYPT_AT_REST=1)开启时:正文写盘为密文(磁盘看不到明文),读回一致;
// 关闭时保持旧明文行为;遗留明文文件在两态下都能读。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { writeRunRecord, readRunRecord, listRunRecords } from '../src/runtime/run-store.js';
import { createConversationStore } from '../src/storage/conversation-store.js';
import { clearAtRestProtectorCache } from '../src/security/at-rest.js';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-atrest-store-'));
}

function withEncryption<T>(fn: () => T): T {
  const prev = process.env.KCW_ENCRYPT_AT_REST;
  process.env.KCW_ENCRYPT_AT_REST = '1';
  clearAtRestProtectorCache();
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.KCW_ENCRYPT_AT_REST;
    else process.env.KCW_ENCRYPT_AT_REST = prev;
    clearAtRestProtectorCache();
  }
}

const SECRET_PROMPT = '机密:季度并购目标是 Acme, 出价上限 8.8 亿';

test('run-store: with encryption on, run body is sealed on disk but round-trips', () => {
  const root = tmp();
  const runStoreRoot = path.join(root, '.AgentCowork', 'runs');
  withEncryption(() => {
    const runPath = writeRunRecord(runStoreRoot, { id: 'run_20260707_abcd0001', input: { prompt: SECRET_PROMPT }, status: 'succeeded' });
    const raw = fs.readFileSync(runPath, 'utf8');
    assert.ok(!raw.includes(SECRET_PROMPT), 'plaintext run body leaked to disk');
    assert.match(raw, /^aesgcm:v1:/, 'run record is sealed');
    const back = readRunRecord(runStoreRoot, 'run_20260707_abcd0001');
    assert.equal(back?.input?.prompt, SECRET_PROMPT);
    const list = listRunRecords(runStoreRoot);
    assert.equal(list[0]?.prompt, SECRET_PROMPT, 'list decrypts prompt preview');
  });
});

test('run-store: legacy plaintext run records still read after encryption is enabled', () => {
  const root = tmp();
  const runStoreRoot = path.join(root, '.AgentCowork', 'runs');
  fs.mkdirSync(runStoreRoot, { recursive: true });
  fs.writeFileSync(path.join(runStoreRoot, 'run_legacy_0001.json'), JSON.stringify({ id: 'run_legacy_0001', input: { prompt: 'old plain' }, startedAt: '2026-07-06T00:00:00Z' }), 'utf8');
  withEncryption(() => {
    assert.equal(readRunRecord(runStoreRoot, 'run_legacy_0001')?.input?.prompt, 'old plain');
    assert.equal(listRunRecords(runStoreRoot)[0]?.prompt, 'old plain');
  });
});

test('run-store: with encryption off, disk stays plaintext (unchanged behavior)', () => {
  const root = tmp();
  const runStoreRoot = path.join(root, '.AgentCowork', 'runs');
  const runPath = writeRunRecord(runStoreRoot, { id: 'run_plain_0001', input: { prompt: 'visible' }, status: 'succeeded' });
  assert.ok(fs.readFileSync(runPath, 'utf8').includes('visible'), 'default (off) keeps plaintext');
  assert.equal(readRunRecord(runStoreRoot, 'run_plain_0001')?.input?.prompt, 'visible');
});

test('conversation-store: with encryption on, message bodies are sealed on disk but round-trip', () => {
  const root = tmp();
  const store = createConversationStore();
  const ctx = { tenantId: 'tenant_a', userId: 'user_a' };
  withEncryption(() => {
    store.save(root, { id: 'c1', title: 'M&A', messages: [{ role: 'user', content: SECRET_PROMPT }] }, ctx);
    const file = path.join(root, '.AgentCowork', 'conversations', 'tenant_a', 'user_a', 'c1.json');
    const raw = fs.readFileSync(file, 'utf8');
    assert.ok(!raw.includes(SECRET_PROMPT), 'plaintext conversation leaked to disk');
    assert.match(raw, /^aesgcm:v1:/);
    const back = store.get(root, 'c1', ctx);
    assert.equal((back?.messages?.[0] as { content?: string })?.content, SECRET_PROMPT);
    assert.equal(store.listFull(root, ctx)[0]?.id, 'c1', 'listFull decrypts');
  });
});

test('conversation-store: legacy plaintext conversations still read after encryption is enabled', () => {
  const root = tmp();
  const store = createConversationStore();
  const ctx = { tenantId: 'tenant_a', userId: 'user_a' };
  const dir = path.join(root, '.AgentCowork', 'conversations', 'tenant_a', 'user_a');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'c-legacy.json'), JSON.stringify({ id: 'c-legacy', title: 'old', messages: [{ role: 'user', content: 'legacy body' }], updatedAt: '2026-07-06T00:00:00Z' }), 'utf8');
  withEncryption(() => {
    assert.equal((store.get(root, 'c-legacy', ctx)?.messages?.[0] as { content?: string })?.content, 'legacy body');
  });
});
