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

function currentConversationFile(root: string, id: string): string {
  const base = path.join(root, '.AgentCowork', 'conversations');
  const ownerDirectory = fs.readdirSync(base).find((name) => /^v1-[a-f0-9]{64}$/.test(name));
  assert.ok(ownerDirectory, 'current conversation owner directory exists');
  return path.join(base, ownerDirectory, `${id}.json`);
}

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
    const base = path.join(root, '.AgentCowork', 'conversations');
    const [ownerDirectory] = fs.readdirSync(base);
    assert.match(ownerDirectory || '', /^v1-[a-f0-9]{64}$/);
    const file = path.join(base, ownerDirectory || '', 'c1.json');
    const raw = fs.readFileSync(file, 'utf8');
    assert.ok(!raw.includes(SECRET_PROMPT), 'plaintext conversation leaked to disk');
    assert.match(raw, /^aesgcm:v1:/);
    const back = store.get(root, 'c1', ctx);
    assert.equal((back?.messages?.[0] as { content?: string })?.content, SECRET_PROMPT);
    assert.equal(store.listFull(root, ctx)[0]?.id, 'c1', 'listFull decrypts');
  });
});

test('conversation-store: legacy local plaintext conversations still read after encryption is enabled', () => {
  const root = tmp();
  const store = createConversationStore();
  const ctx = { tenantId: 'tenant_local', userId: 'user_local' };
  const dir = path.join(root, '.AgentCowork', 'conversations', 'tenant_local', 'user_local');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'c-legacy.json'), JSON.stringify({ id: 'c-legacy', title: 'old', messages: [{ role: 'user', content: 'legacy body' }], updatedAt: '2026-07-06T00:00:00Z' }), 'utf8');
  withEncryption(() => {
    assert.equal((store.get(root, 'c-legacy', ctx)?.messages?.[0] as { content?: string })?.content, 'legacy body');
    assert.equal(store.get(root, 'c-legacy', { tenantId: 'tenant_a', userId: 'user_a' }), null);
  });
});

test('conversation-store: save refuses to overwrite unreadable or invalid existing bytes', async (t) => {
  const nestedContext = t as unknown as {
    test(name: string, fn: () => void): Promise<void>;
  };
  const cases = [
    ['ciphertext cannot be decrypted', 'aesgcm:v1:AAAA:BBBB:CCCC'],
    ['plaintext cannot be parsed as JSON', '{'],
    ['parsed JSON is not a conversation record', '{}'],
    [
      'parsed conversation id does not match its file name',
      JSON.stringify({ id: 'c-other', title: 'before', messages: [] }),
    ],
  ] as const;

  for (const [name, unreadableBody] of cases) {
    await nestedContext.test(name, () => {
      const root = tmp();
      const store = createConversationStore();
      const ctx = { tenantId: 'tenant_a', userId: 'user_a' };
      withEncryption(() => {
        store.save(root, { id: 'c-corrupt', title: 'before', messages: [] }, ctx);
        const file = currentConversationFile(root, 'c-corrupt');
        const originalBytes = Buffer.from(unreadableBody, 'utf8');
        fs.writeFileSync(file, originalBytes);

        assert.equal(store.get(root, 'c-corrupt', ctx), null, 'precondition: existing document is unreadable');
        assert.throws(
          () => store.save(root, { id: 'c-corrupt', title: 'after', messages: [] }, ctx),
          /cannot be decrypted or parsed; refusing to overwrite/i,
        );
        assert.deepEqual(fs.readFileSync(file), originalBytes, 'failed save preserves the original bytes');
      });
    });
  }
});

test('conversation-store: an atomic update failure preserves the prior record and removes its temp file', () => {
  const root = tmp();
  const store = createConversationStore();
  const ctx = { tenantId: 'tenant_a', userId: 'user_a' };
  store.save(root, { id: 'c-atomic', title: 'before', messages: [] }, ctx);
  const file = currentConversationFile(root, 'c-atomic');
  const originalBytes = fs.readFileSync(file);
  const originalCloseSync = fs.closeSync;
  let injected = false;
  fs.closeSync = ((descriptor: number) => {
    if (!injected) {
      injected = true;
      throw new Error('simulated close failure before atomic rename');
    }
    return originalCloseSync(descriptor);
  }) as typeof fs.closeSync;
  try {
    assert.throws(
      () => store.save(root, { id: 'c-atomic', title: 'after', messages: [] }, ctx),
      /simulated close failure/,
    );
  } finally {
    fs.closeSync = originalCloseSync;
  }

  assert.equal(injected, true, 'the atomic writer reached its pre-rename close step');
  assert.deepEqual(fs.readFileSync(file), originalBytes);
  assert.equal(store.get(root, 'c-atomic', ctx)?.title, 'before');
  const basename = path.basename(file);
  assert.deepEqual(
    fs.readdirSync(path.dirname(file)).filter((name) => name.startsWith(`.${basename}.`) && name.endsWith('.tmp')),
    [],
  );
});
