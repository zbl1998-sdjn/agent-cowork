import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  appendConversationTurn,
  clearConversationBuffer,
  conversationBufferPath,
  readRecentTurns,
} from '../src/memory/conversation-buffer.js';
import { memoryOwnerDir } from '../src/memory/memory-owner.js';
import { samePathReal } from './helpers/path-swap.js';

const alice = { tenantId: 'tenant_conversation_path', userId: 'alice' };
const bob = { tenantId: 'tenant_conversation_path', userId: 'bob' };

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-conversation-path-'));
}

function createJunction(target: string, linkPath: string): void {
  (fs as unknown as {
    symlinkSync(source: string, destination: string, type: 'junction'): void;
  }).symlinkSync(target, linkPath, 'junction');
}

function swapDirectory(directory: string, displaced: string, replacementFile: string): void {
  fs.renameSync(directory, displaced);
  fs.mkdirSync(path.dirname(replacementFile), { recursive: true });
  fs.writeFileSync(replacementFile, 'must-not-delete', 'utf8');
}

test('conversation buffers reject a same-root junction to a sibling owner', {
  skip: process.platform !== 'win32',
}, (t) => {
  const root = tempRoot();
  appendConversationTurn(root, 'shared', { role: 'user', text: 'bob-private' }, { context: bob });
  const bobFile = conversationBufferPath(root, 'shared', bob);
  const bobBefore = fs.readFileSync(bobFile);
  try {
    createJunction(memoryOwnerDir(root, bob), memoryOwnerDir(root, alice));
  } catch (error) {
    t.skip(`junction unavailable: ${String(error)}`);
    return;
  }

  assert.throws(
    () => readRecentTurns(root, 'shared', { context: alice }),
    /symbolic link|junction|reparse|managed path|boundary/i,
  );
  assert.throws(
    () => appendConversationTurn(root, 'shared', { role: 'assistant', text: 'cross-owner-write' }, { context: alice }),
    /symbolic link|junction|reparse|managed path|boundary/i,
  );
  assert.throws(
    () => clearConversationBuffer(root, 'shared', alice),
    /symbolic link|junction|reparse|managed path|boundary/i,
  );
  assert.deepEqual(fs.readFileSync(bobFile), bobBefore);
});

test('conversation reads reject a regular file replacement after open', () => {
  const root = tempRoot();
  appendConversationTurn(root, 'stable', { role: 'user', text: 'original-turn' }, { context: alice });
  const file = conversationBufferPath(root, 'stable', alice);
  const displaced = `${file}.original`;
  const originalOpen = fs.openSync;
  let injected = false;
  fs.openSync = ((target: unknown, ...args: unknown[]) => {
    const descriptor = Reflect.apply(originalOpen, fs, [target, ...args]) as number;
    if (!injected && samePathReal(String(target), file)) {
      injected = true;
      fs.renameSync(file, displaced);
      fs.writeFileSync(file, `${JSON.stringify({
        role: 'user', text: 'replacement-turn', ts: '2026-07-11T00:00:00.000Z',
      })}\n`, 'utf8');
    }
    return descriptor;
  }) as typeof fs.openSync;
  try {
    assert.throws(
      () => readRecentTurns(root, 'stable', { context: alice }),
      /managed file changed|changed during operation|boundary/i,
    );
  } finally {
    fs.openSync = originalOpen;
  }
  assert.match(fs.readFileSync(displaced, 'utf8'), /original-turn/);
});

test('clearConversationBuffer exposes filesystem deletion failures', () => {
  const root = tempRoot();
  appendConversationTurn(root, 'delete-failure', { role: 'user', text: 'keep-me' }, { context: alice });
  const file = conversationBufferPath(root, 'delete-failure', alice);
  const originalRm = fs.rmSync;
  const originalUnlink = fs.unlinkSync;
  const fail = (target: unknown): never => {
    if (samePathReal(String(target), file)) throw new Error('injected delete failure');
    throw new Error(`unexpected delete target: ${String(target)}`);
  };
  fs.rmSync = fail as typeof fs.rmSync;
  fs.unlinkSync = fail as typeof fs.unlinkSync;
  try {
    assert.throws(
      () => clearConversationBuffer(root, 'delete-failure', alice),
      /injected delete failure/,
    );
  } finally {
    fs.rmSync = originalRm;
    fs.unlinkSync = originalUnlink;
  }
  assert.equal(fs.existsSync(file), true);
});

test('clear rejects an owner directory replacement before unlink without misdeleting', () => {
  const root = tempRoot();
  appendConversationTurn(root, 'delete-swap', { role: 'user', text: 'original-turn' }, { context: alice });
  const file = conversationBufferPath(root, 'delete-swap', alice);
  const ownerDirectory = memoryOwnerDir(root, alice);
  const displaced = `${ownerDirectory}.original`;
  const replacementFile = conversationBufferPath(root, 'delete-swap', alice);
  const originalLstat = fs.lstatSync;
  let injected = false;
  fs.lstatSync = ((target: unknown, ...args: unknown[]) => {
    const stats = Reflect.apply(originalLstat, fs, [target, ...args]) as fs.Stats;
    if (!injected && samePathReal(String(target), file)) {
      injected = true;
      swapDirectory(ownerDirectory, displaced, replacementFile);
    }
    return stats;
  }) as typeof fs.lstatSync;
  try {
    assert.throws(
      () => clearConversationBuffer(root, 'delete-swap', alice),
      /changed during operation|boundary/i,
    );
  } finally {
    fs.lstatSync = originalLstat;
  }
  assert.equal(injected, true);
  assert.equal(fs.readFileSync(replacementFile, 'utf8'), 'must-not-delete');
  assert.match(fs.readFileSync(path.join(displaced, 'conversations', path.basename(file)), 'utf8'), /original-turn/);
});
