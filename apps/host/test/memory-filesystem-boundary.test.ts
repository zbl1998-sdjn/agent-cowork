import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  appendMemoryFact,
  listMemoryNotes,
  readMainMemory,
  readMemoryNote,
  writeMemoryNote,
} from '../src/memory/file-memory-store.js';
import {
  readMemorySettings,
  writeMemorySettings,
} from '../src/memory/memory-settings.js';
import {
  memoryOwnerDir,
} from '../src/memory/memory-owner.js';

const alice = { tenantId: 'tenant_memory_path', userId: 'alice' };
const bob = { tenantId: 'tenant_memory_path', userId: 'bob' };
const localOwner = { tenantId: 'tenant_local', userId: 'user_local' };

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-memory-path-'));
}

function createJunction(target: string, linkPath: string): void {
  (fs as unknown as {
    symlinkSync(source: string, destination: string, type: 'junction'): void;
  }).symlinkSync(target, linkPath, 'junction');
}

test('owner-scoped memory rejects a same-root junction to a sibling owner', {
  skip: process.platform !== 'win32',
}, (t) => {
  const root = tempRoot();
  appendMemoryFact(root, { key: 'owner', value: 'bob-private' }, bob);
  writeMemoryNote(root, 'private.md', 'bob-private-note', bob);
  writeMemorySettings(root, { paused: true }, bob);
  const bobDirectory = memoryOwnerDir(root, bob);
  const aliceDirectory = memoryOwnerDir(root, alice);
  try {
    createJunction(bobDirectory, aliceDirectory);
  } catch (error) {
    t.skip(`junction unavailable: ${String(error)}`);
    return;
  }

  assert.throws(() => readMainMemory(root, alice), /symbolic link|junction|reparse|managed path/i);
  assert.throws(() => readMemoryNote(root, 'private.md', alice), /symbolic link|junction|reparse|managed path/i);
  assert.throws(() => listMemoryNotes(root, alice), /symbolic link|junction|reparse|managed path/i);
  assert.throws(
    () => appendMemoryFact(root, { key: 'must-not', value: 'cross-owner-write' }, alice),
    /symbolic link|junction|reparse|managed path/i,
  );
  assert.throws(
    () => writeMemoryNote(root, 'private.md', 'cross-owner-write', alice),
    /symbolic link|junction|reparse|managed path/i,
  );
  assert.throws(() => readMemorySettings(root, alice), /symbolic link|junction|reparse|managed path/i);
  assert.throws(
    () => writeMemorySettings(root, { paused: false }, alice),
    /symbolic link|junction|reparse|managed path/i,
  );
  assert.match(readMainMemory(root, bob), /bob-private/);
  assert.equal(readMemoryNote(root, 'private.md', bob), 'bob-private-note');
  assert.equal(readMemorySettings(root, bob).paused, true);
});

test('legacy local note paths reject same-root junctions', {
  skip: process.platform !== 'win32',
}, (t) => {
  const root = tempRoot();
  const agentDirectory = path.join(root, '.AgentCowork');
  const sibling = path.join(agentDirectory, 'legacy-sibling');
  const legacyNotes = path.join(agentDirectory, 'memory');
  fs.mkdirSync(sibling, { recursive: true });
  fs.writeFileSync(path.join(sibling, 'legacy.md'), 'must-not-read', 'utf8');
  try {
    createJunction(sibling, legacyNotes);
  } catch (error) {
    t.skip(`junction unavailable: ${String(error)}`);
    return;
  }

  assert.throws(
    () => readMemoryNote(root, 'legacy.md', localOwner),
    /symbolic link|junction|reparse|managed path/i,
  );
  assert.throws(
    () => listMemoryNotes(root, localOwner),
    /symbolic link|junction|reparse|managed path/i,
  );
});
