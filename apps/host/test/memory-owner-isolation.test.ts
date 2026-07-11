import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  appendMemoryFact,
  createMemoryStore,
  listMemoryNotes,
  readMainMemory,
  readMemoryNote,
  writeMemoryNote,
} from '../src/memory/memory-store.js';
import { createUserProfile } from '../src/memory/profile.js';
import {
  deleteKnowledgeItem,
  listKnowledgeItems,
  upsertKnowledgeItem,
} from '../src/memory/knowledge-store.js';
import { recallRelevantKnowledge } from '../src/memory/knowledge-recall.js';
import {
  appendConversationTurn,
  conversationBufferPath,
  readRecentTurns,
} from '../src/memory/conversation-buffer.js';
import {
  isMemoryActiveForRoot,
  readMemorySettings,
  writeMemorySettings,
} from '../src/memory/memory-control.js';
import {
  MemoryOwnerError,
  memoryOwnerMainPath,
  memoryOwnerNotesDir,
  memoryOwnerStorageKey,
  requireMemoryOwner,
} from '../src/memory/memory-owner.js';
import {
  normaliseTenantId,
  normaliseUserId,
  securityDirForMemoryPath,
} from '../src/memory/memory-utils.js';
import {
  clearAtRestProtectorCache,
  resolveAtRestProtector,
} from '../src/security/at-rest.js';
import { createAesGcmProtector } from '../src/security/credential-store.js';

const alice = { tenantId: 'shared-tenant', userId: 'alice' };
const bob = { tenantId: 'shared-tenant', userId: 'bob' };
const localOwner = { tenantId: 'tenant_local', userId: 'user_local' };

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-memory-owner-'));
}

test('memory owner uses the canonical identity contract without coercion or accessors', () => {
  assert.deepEqual(requireMemoryOwner(alice), alice);
  for (const value of ['', ' tenant', 'tenant ', 'tenant/path', 42, null, undefined]) {
    assert.throws(
      () => requireMemoryOwner({ tenantId: value, userId: 'alice' }),
      (error: unknown) => error instanceof MemoryOwnerError,
    );
  }
  assert.equal(normaliseTenantId('tenant_a'), 'tenant_a');
  assert.equal(normaliseUserId('user_a'), 'user_a');
  for (const value of ['', ' tenant', 'tenant ', 'tenant/path', 42, null, undefined]) {
    assert.throws(() => normaliseTenantId(value), /canonical identity part/i);
    assert.throws(() => normaliseUserId(value), /canonical identity part/i);
  }

  let getterCalled = false;
  const accessorScope = Object.defineProperty({ userId: 'alice' }, 'tenantId', {
    enumerable: true,
    get() {
      getterCalled = true;
      return 'shared-tenant';
    },
  });
  assert.throws(
    () => requireMemoryOwner(accessorScope),
    (error: unknown) => error instanceof MemoryOwnerError,
  );
  assert.equal(getterCalled, false);

  const traps = { get: 0, getOwnPropertyDescriptor: 0, getPrototypeOf: 0, ownKeys: 0 };
  const proxyScope = new Proxy({ tenantId: 'shared-tenant', userId: 'alice' }, {
    get(target, key, receiver) {
      traps.get += 1;
      return Reflect.get(target, key, receiver);
    },
    getOwnPropertyDescriptor(target, key) {
      traps.getOwnPropertyDescriptor += 1;
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
    getPrototypeOf(target) {
      traps.getPrototypeOf += 1;
      return Reflect.getPrototypeOf(target);
    },
    ownKeys(target) {
      traps.ownKeys += 1;
      return Reflect.ownKeys(target);
    },
  });
  assert.throws(
    () => requireMemoryOwner(proxyScope),
    (error: unknown) => error instanceof MemoryOwnerError,
  );
  assert.deepEqual(traps, { get: 0, getOwnPropertyDescriptor: 0, getPrototypeOf: 0, ownKeys: 0 });

  const revoked = Proxy.revocable({ tenantId: 'shared-tenant', userId: 'alice' }, {});
  revoked.revoke();
  assert.throws(
    () => requireMemoryOwner(revoked.proxy),
    (error: unknown) => error instanceof MemoryOwnerError,
  );
});

test('file memory facts and logical note names are isolated by exact tenant and user', () => {
  const root = tempRoot();

  assert.throws(() => readMainMemory(root), /memory owner tenantId is required/);
  assert.throws(() => writeMemoryNote(root, 'shared.md', 'missing owner'), /memory owner tenantId is required/);

  appendMemoryFact(root, { key: 'owner', value: 'alice-only', scope: 'project' }, alice);
  appendMemoryFact(root, { key: 'owner', value: 'bob-only', scope: 'user' }, bob);
  writeMemoryNote(root, 'shared.md', 'alice note', alice);
  writeMemoryNote(root, 'shared.md', 'bob note', bob);

  assert.match(readMainMemory(root, alice), /alice-only/);
  assert.doesNotMatch(readMainMemory(root, alice), /bob-only/);
  assert.match(readMainMemory(root, bob), /bob-only/);
  assert.doesNotMatch(readMainMemory(root, bob), /alice-only/);
  assert.equal(readMemoryNote(root, 'shared.md', alice), 'alice note');
  assert.equal(readMemoryNote(root, 'shared.md', bob), 'bob note');
  assert.deepEqual(listMemoryNotes(root, alice).map((note) => note.name), ['shared.md']);
  assert.deepEqual(listMemoryNotes(root, bob).map((note) => note.name), ['shared.md']);

  const physical = writeMemoryNote(root, 'physical.md', 'safe path', alice);
  assert.match(physical, /[\\/]owners[\\/]v1-[a-f0-9]{64}[\\/]notes[\\/]physical\.md$/);
  assert.doesNotMatch(physical, /shared-tenant|alice/);
});

test('legacy file memory is visible only to the explicit local owner and is never claimed', () => {
  const root = tempRoot();
  const legacyDir = path.join(root, '.AgentCowork', 'memory');
  fs.mkdirSync(legacyDir, { recursive: true });
  fs.writeFileSync(path.join(root, '.AgentCowork', 'MEMORY.md'), '# legacy\nlocal-only', 'utf8');
  fs.writeFileSync(path.join(legacyDir, 'legacy.md'), 'legacy note', 'utf8');

  assert.match(readMainMemory(root, localOwner), /local-only/);
  assert.equal(readMemoryNote(root, 'legacy.md', localOwner), 'legacy note');
  assert.equal(readMainMemory(root, alice), '');
  assert.equal(readMemoryNote(root, 'legacy.md', alice), null);
  assert.deepEqual(listMemoryNotes(root, alice), []);
});

test('memory settings are owner-scoped and legacy settings are restricted to local/local', () => {
  const root = tempRoot();

  assert.throws(() => readMemorySettings(root), /memory owner tenantId is required/);
  writeMemorySettings(root, { paused: true }, alice);
  assert.equal(isMemoryActiveForRoot(root, alice), false);
  assert.equal(isMemoryActiveForRoot(root, bob), true);
  assert.equal(readMemorySettings(root, bob).paused, false);

  const physical = path.join(
    root,
    '.AgentCowork',
    'owners',
    memoryOwnerStorageKey(alice),
    'memory-settings.json',
  );
  assert.equal(fs.existsSync(physical), true);
  assert.doesNotMatch(physical, /shared-tenant|alice/);

  const legacyRoot = tempRoot();
  const legacyDir = path.join(legacyRoot, '.AgentCowork');
  fs.mkdirSync(legacyDir, { recursive: true });
  fs.writeFileSync(
    path.join(legacyDir, 'memory-settings.json'),
    JSON.stringify({ enabled: false, paused: true, incognito: false, defaultScope: 'user' }),
    'utf8',
  );
  assert.equal(readMemorySettings(legacyRoot, localOwner).paused, true);
  assert.equal(readMemorySettings(legacyRoot, alice).paused, false);
});

test('profile recall and forget cannot cross same-tenant sibling owners', async () => {
  const root = tempRoot();
  const profile = createUserProfile({ memoryStore: createMemoryStore() });

  await profile.learn(root, { type: 'preference', key: 'reply', value: 'alice-style' }, alice);
  await profile.learn(root, { type: 'preference', key: 'reply', value: 'bob-style' }, bob);
  assert.match((await profile.recall(root, { query: 'reply', context: alice })).entries[0]?.value || '', /alice-style/);
  assert.match((await profile.recall(root, { query: 'reply', context: bob })).entries[0]?.value || '', /bob-style/);

  const forgotten = await profile.forget(root, { key: 'reply' }, bob);
  assert.equal(forgotten.removed, 1);
  assert.equal((await profile.recall(root, { query: 'reply', context: bob })).entries.length, 0);
  assert.equal((await profile.recall(root, { query: 'reply', context: alice })).entries.length, 1);
  await assert.rejects(() => profile.load(root), /memory owner tenantId is required/);
});

test('corrupt profile load and learn fail closed without overwriting the original note', async () => {
  const root = tempRoot();
  const profile = createUserProfile({ memoryStore: createMemoryStore() });
  const corrupt = '{"version":1,"entries":[';
  writeMemoryNote(root, 'profile.md', corrupt, alice);

  await assert.rejects(() => profile.load(root, alice), /profile note is corrupt/);
  await assert.rejects(
    () => profile.learn(root, { type: 'preference', key: 'reply', value: 'must not overwrite' }, alice),
    /profile note is corrupt/,
  );
  assert.equal(readMemoryNote(root, 'profile.md', alice), corrupt);

  const invalidShape = JSON.stringify({ version: 1, entries: [{ key: 'missing fields' }] });
  writeMemoryNote(root, 'profile.md', invalidShape, alice);
  await assert.rejects(() => profile.load(root, alice), /profile note is corrupt/);
  assert.equal(readMemoryNote(root, 'profile.md', alice), invalidShape);
});

test('undecryptable owner memory fails closed without overwriting encrypted bytes', () => {
  const root = tempRoot();
  const mainFile = memoryOwnerMainPath(root, alice);
  const noteFile = path.join(memoryOwnerNotesDir(root, alice), 'corrupt.md');
  const corruptCiphertext = 'aesgcm:v1:AAAA:BBBB:CCCC';
  fs.mkdirSync(path.dirname(noteFile), { recursive: true });
  resolveAtRestProtector(securityDirForMemoryPath(mainFile), {
    fresh: true,
    credentialProtector: createAesGcmProtector({ keyMaterial: 'test-memory-owner-kek' }),
  });
  fs.writeFileSync(mainFile, corruptCiphertext, 'utf8');
  fs.writeFileSync(noteFile, corruptCiphertext, 'utf8');
  const mainBefore = fs.readFileSync(mainFile);
  const noteBefore = fs.readFileSync(noteFile);

  try {
    assert.throws(() => readMainMemory(root, alice), /memory file.*corrupt|decrypt/i);
    assert.throws(() => readMemoryNote(root, 'corrupt.md', alice), /memory file.*corrupt|decrypt/i);
    assert.throws(
      () => appendMemoryFact(root, { key: 'must-not', value: 'overwrite' }, alice),
      /memory file.*corrupt|decrypt/i,
    );
    assert.deepEqual(fs.readFileSync(mainFile), mainBefore);
    assert.deepEqual(fs.readFileSync(noteFile), noteBefore);
  } finally {
    clearAtRestProtectorCache();
  }
});

test('knowledge and conversation recall are owner-scoped and missing owner fails closed', () => {
  const root = tempRoot();
  const aliceResult = upsertKnowledgeItem(
    root,
    { topic: 'identity', title: 'owner', content: 'alice knowledge', confidence: 0.9 },
    { confidenceThreshold: 0.7, context: alice },
  );
  upsertKnowledgeItem(
    root,
    { topic: 'identity', title: 'owner', content: 'bob knowledge', confidence: 0.9 },
    { confidenceThreshold: 0.7, context: bob },
  );
  assert.match(recallRelevantKnowledge(root, 'owner', { context: alice })[0]?.content || '', /alice/);
  assert.match(recallRelevantKnowledge(root, 'owner', { context: bob })[0]?.content || '', /bob/);
  const aliceId = listKnowledgeItems(root, { context: alice })[0]?.id || '';
  assert.equal(aliceResult.stored, true);
  assert.equal(deleteKnowledgeItem(root, aliceId, bob), false);
  assert.equal(listKnowledgeItems(root, { context: alice }).length, 1);
  assert.throws(() => listKnowledgeItems(root), /memory owner tenantId is required/);

  appendConversationTurn(root, 'same-conversation', { role: 'user', text: 'alice turn' }, { context: alice });
  appendConversationTurn(root, 'same-conversation', { role: 'user', text: 'bob turn' }, { context: bob });
  assert.deepEqual(readRecentTurns(root, 'same-conversation', { context: alice }).map((turn) => turn.text), ['alice turn']);
  assert.deepEqual(readRecentTurns(root, 'same-conversation', { context: bob }).map((turn) => turn.text), ['bob turn']);
  assert.throws(() => readRecentTurns(root, 'same-conversation'), /memory owner tenantId is required/);
});

test('corrupt owner knowledge fails closed without being overwritten', () => {
  const root = tempRoot();
  const ownerDir = path.join(root, '.AgentCowork', 'owners', memoryOwnerStorageKey(alice));
  const file = path.join(ownerDir, 'knowledge.json');
  const corrupt = '{"version":1,"items":[';
  fs.mkdirSync(ownerDir, { recursive: true });
  fs.writeFileSync(file, corrupt, 'utf8');

  assert.throws(() => listKnowledgeItems(root, { context: alice }), /knowledge store is corrupt/);
  assert.throws(
    () => upsertKnowledgeItem(
      root,
      { topic: 'identity', title: 'owner', content: 'must not overwrite', confidence: 0.9 },
      { context: alice },
    ),
    /knowledge store is corrupt/,
  );
  assert.equal(fs.readFileSync(file, 'utf8'), corrupt);
});

test('corrupt conversation buffers fail closed without partial recall or overwrite', () => {
  const root = tempRoot();
  const file = conversationBufferPath(root, 'corrupt', alice);
  const corrupt = '{"role":"user","text":"trusted","ts":"now"}\nnot-json\n';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, corrupt, 'utf8');

  assert.throws(() => readRecentTurns(root, 'corrupt', { context: alice }), /conversation buffer is corrupt/);
  assert.throws(
    () => appendConversationTurn(root, 'corrupt', { role: 'assistant', text: 'must not overwrite' }, { context: alice }),
    /conversation buffer is corrupt/,
  );
  assert.equal(fs.readFileSync(file, 'utf8'), corrupt);
});
