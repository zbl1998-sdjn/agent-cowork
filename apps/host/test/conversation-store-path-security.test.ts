import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { conversationOwnerDirectory } from '../src/storage/conversation-owner.js';
import { FileConversationStore } from '../src/storage/conversation-store.js';
import type { ConversationContext } from '../src/storage/conversation-types.js';
import { samePathReal } from './helpers/path-swap.js';

type SymlinkSync = (target: string, linkPath: string, type?: 'file' | 'dir' | 'junction') => void;
const symlinkSync = (fs as unknown as { symlinkSync: SymlinkSync }).symlinkSync;

function tempRoot(prefix = 'kcw-conversation-path-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function conversationRoot(root: string): string {
  return path.join(root, '.AgentCowork', 'conversations');
}

function ownerDirectory(root: string, context: ConversationContext): string {
  return path.join(conversationRoot(root), conversationOwnerDirectory(context));
}

function linkDirectory(target: string, linkPath: string): void {
  try {
    symlinkSync(target, linkPath, 'junction');
  } catch {
    symlinkSync(target, linkPath, 'dir');
  }
}

function assertPathFailure(action: () => unknown): void {
  assert.throws(action, /conversation.*(?:symbolic|junction|reparse|managed|escaped|changed|unsafe)/i);
}

const OWNER_A = { tenantId: 'tenant_path', userId: 'user_a' };
const OWNER_B = { tenantId: 'tenant_path', userId: 'user_b' };

function crossOwnerJunctionFixture(t: TestContext) {
  const root = tempRoot();
  const store = new FileConversationStore();
  store.save(root, { id: 'shared', title: 'Owner B secret', messages: [] }, OWNER_B);
  const targetDirectory = ownerDirectory(root, OWNER_B);
  const linkedDirectory = ownerDirectory(root, OWNER_A);
  try {
    linkDirectory(targetDirectory, linkedDirectory);
  } catch (error) {
    t.skip(`symlink/junction unavailable: ${String(error)}`);
  }
  const targetFile = path.join(targetDirectory, 'shared.json');
  return { root, store, targetFile, before: fs.readFileSync(targetFile) };
}

test('cross-owner directory junctions are rejected by every conversation read surface', (t) => {
  const { root, store, targetFile, before } = crossOwnerJunctionFixture(t);
  for (const operation of [
    () => store.get(root, 'shared', OWNER_A),
    () => store.list(root, OWNER_A),
    () => store.listFull(root, OWNER_A),
    () => store.query(root, OWNER_A, { q: 'secret' }),
  ]) assertPathFailure(operation);
  assert.deepEqual(fs.readFileSync(targetFile), before);
});

test('cross-owner directory junctions cannot overwrite a sibling conversation', (t) => {
  const { root, store, targetFile, before } = crossOwnerJunctionFixture(t);
  assertPathFailure(() => store.save(
    root,
    { id: 'shared', title: 'Owner A overwrite', messages: [] },
    OWNER_A,
  ));
  assert.deepEqual(fs.readFileSync(targetFile), before);
});

test('cross-owner directory junctions cannot delete a sibling conversation', (t) => {
  const { root, store, targetFile, before } = crossOwnerJunctionFixture(t);
  assertPathFailure(() => store.remove(root, 'shared', OWNER_A));
  assert.deepEqual(fs.readFileSync(targetFile), before);
});

function legacyJunctionFixture(t: TestContext) {
  const root = tempRoot();
  const outside = tempRoot('kcw-conversation-legacy-outside-');
  const legacyUserDirectory = path.join(outside, 'user_local');
  fs.mkdirSync(legacyUserDirectory);
  const legacyFile = path.join(legacyUserDirectory, 'legacy.json');
  fs.writeFileSync(legacyFile, JSON.stringify({
    id: 'legacy',
    title: 'Outside legacy body',
    messages: [],
  }), 'utf8');
  const base = conversationRoot(root);
  fs.mkdirSync(base, { recursive: true });
  try {
    linkDirectory(outside, path.join(base, 'tenant_local'));
  } catch (error) {
    t.skip(`symlink/junction unavailable: ${String(error)}`);
  }
  return {
    root,
    store: new FileConversationStore(),
    legacyFile,
    before: fs.readFileSync(legacyFile),
    context: { tenantId: 'tenant_local', userId: 'user_local' },
  };
}

test('legacy local path segments are never followed for read, save, or delete', (t) => {
  const { root, store, legacyFile, before, context } = legacyJunctionFixture(t);
  assertPathFailure(() => store.get(root, 'legacy', context));
  assertPathFailure(() => store.list(root, context));
  assertPathFailure(() => store.save(root, { id: 'legacy', title: 'overwrite', messages: [] }, context));
  assertPathFailure(() => store.remove(root, 'legacy', context));
  assert.deepEqual(fs.readFileSync(legacyFile), before);
  assert.equal(fs.existsSync(path.join(ownerDirectory(root, context), 'legacy.json')), false);
});

test('save revalidates the owner directory after mkdir before writing any file', (t) => {
  const root = tempRoot();
  const outside = tempRoot('kcw-conversation-swap-outside-');
  const directory = ownerDirectory(root, OWNER_A);
  const displaced = `${directory}-original`;
  const originalMkdirSync = fs.mkdirSync;
  let swapped = false;
  fs.mkdirSync = ((...args: unknown[]) => {
    const result = Reflect.apply(originalMkdirSync, fs, args);
    if (!swapped && samePathReal(String(args[0]), directory)) {
      fs.renameSync(directory, displaced);
      try {
        linkDirectory(outside, directory);
      } catch (error) {
        fs.renameSync(displaced, directory);
        t.skip(`symlink/junction unavailable: ${String(error)}`);
      }
      swapped = true;
    }
    return result;
  }) as typeof fs.mkdirSync;

  try {
    assertPathFailure(() => new FileConversationStore().save(
      root,
      { id: 'swapped', title: 'must stay local', messages: [] },
      OWNER_A,
    ));
  } finally {
    fs.mkdirSync = originalMkdirSync;
  }
  assert.equal(swapped, true, 'test must exercise the post-mkdir directory swap');
  assert.deepEqual(fs.readdirSync(outside), []);
  assert.deepEqual(fs.readdirSync(displaced), []);
});

test('conversation reads reject a file replaced after its bytes are read', () => {
  const root = tempRoot();
  const store = new FileConversationStore();
  store.save(root, { id: 'replace-me', title: 'before', messages: [] }, OWNER_A);
  const file = path.join(ownerDirectory(root, OWNER_A), 'replace-me.json');
  const originalReadFileSync = fs.readFileSync;
  let replaced = false;
  fs.readFileSync = ((filePath: unknown, ...args: unknown[]) => {
    const value = Reflect.apply(originalReadFileSync, fs, [filePath, ...args]);
    if (!replaced && typeof filePath !== 'number'
      && samePathReal(String(filePath), file)) {
      replaced = true;
      fs.writeFileSync(file, JSON.stringify({
        id: 'replace-me', title: 'replacement with different bytes', messages: [],
      }), 'utf8');
    }
    return value;
  }) as typeof fs.readFileSync;
  try {
    assertPathFailure(() => store.get(root, 'replace-me', OWNER_A));
  } finally {
    fs.readFileSync = originalReadFileSync;
  }
  assert.equal(replaced, true, 'test must replace the file between read and revalidation');
});
