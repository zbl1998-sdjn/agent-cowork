import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  appendMemoryFact,
  readMainMemory,
  writeMemoryNote,
} from '../src/memory/file-memory-store.js';
import { readMemorySettings, writeMemorySettings } from '../src/memory/memory-settings.js';
import { memoryOwnerDir, memoryOwnerMainPath } from '../src/memory/memory-owner.js';
import { AtRestKeyError } from '../src/security/at-rest.js';

const alice = { tenantId: 'tenant_memory_path', userId: 'alice' };

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-memory-mutation-'));
}

function withEncryptionDisabled<T>(action: () => T): T {
  const previous = process.env.KCW_ENCRYPT_AT_REST;
  process.env.KCW_ENCRYPT_AT_REST = '0';
  try {
    return action();
  } finally {
    if (previous === undefined) delete process.env.KCW_ENCRYPT_AT_REST;
    else process.env.KCW_ENCRYPT_AT_REST = previous;
  }
}

function injectDirectorySwapAfterFileClose(
  directory: string,
  displaced: string,
): { restore: () => void; wasInjected: () => boolean } {
  const originalClose = fs.closeSync;
  const originalLstat = fs.lstatSync;
  let armed = false;
  let injected = false;
  fs.closeSync = ((descriptor: number) => {
    originalClose(descriptor);
    armed = true;
  }) as typeof fs.closeSync;
  fs.lstatSync = ((target: unknown, ...args: unknown[]) => {
    if (armed && path.resolve(String(target)) === path.resolve(directory)) {
      armed = false;
      injected = true;
      fs.renameSync(directory, displaced);
      fs.mkdirSync(directory);
    }
    return Reflect.apply(originalLstat, fs, [target, ...args]) as fs.Stats;
  }) as typeof fs.lstatSync;
  return {
    restore() {
      fs.closeSync = originalClose;
      fs.lstatSync = originalLstat;
    },
    wasInjected: () => injected,
  };
}

test('descriptor reads reject a regular memory file replacement', () => {
  withEncryptionDisabled(() => {
    const root = tempRoot();
    appendMemoryFact(root, { key: 'owner', value: 'alice-original' }, alice);
    const file = memoryOwnerMainPath(root, alice);
    const displaced = `${file}.original`;
    const originalOpen = fs.openSync;
    let injected = false;
    fs.openSync = ((target: unknown, ...args: unknown[]) => {
      const descriptor = Reflect.apply(originalOpen, fs, [target, ...args]) as number;
      if (!injected && path.resolve(String(target)) === path.resolve(file)) {
        injected = true;
        fs.renameSync(file, displaced);
        fs.writeFileSync(file, '# replacement\nmalicious', 'utf8');
      }
      return descriptor;
    }) as typeof fs.openSync;
    try {
      assert.throws(
        () => readMainMemory(root, alice),
        /managed file changed|changed during operation|boundary/i,
      );
    } finally {
      fs.openSync = originalOpen;
    }
    assert.match(fs.readFileSync(displaced, 'utf8'), /alice-original/);
  });
});

test('append rejects an owner directory replacement after reading', () => {
  withEncryptionDisabled(() => {
    const root = tempRoot();
    appendMemoryFact(root, { key: 'owner', value: 'alice-original' }, alice);
    const ownerDirectory = memoryOwnerDir(root, alice);
    const displaced = `${ownerDirectory}.original`;
    const before = fs.readFileSync(memoryOwnerMainPath(root, alice));
    const injection = injectDirectorySwapAfterFileClose(ownerDirectory, displaced);
    try {
      assert.throws(
        () => appendMemoryFact(root, { key: 'must-not', value: 'write-replacement' }, alice),
        /changed during operation|boundary/i,
      );
    } finally {
      injection.restore();
    }
    assert.equal(injection.wasInjected(), true);
    assert.equal(fs.existsSync(memoryOwnerMainPath(root, alice)), false);
    assert.deepEqual(fs.readFileSync(path.join(displaced, 'MEMORY.md')), before);
  });
});

test('atomic note writes reject an owner replacement after mkdir and before open', () => {
  withEncryptionDisabled(() => {
    const root = tempRoot();
    appendMemoryFact(root, { key: 'owner', value: 'alice-original' }, alice);
    const ownerDirectory = memoryOwnerDir(root, alice);
    const notesDirectory = path.join(ownerDirectory, 'notes');
    const displaced = `${ownerDirectory}.original`;
    const originalMkdir = fs.mkdirSync;
    let injected = false;
    fs.mkdirSync = ((target: unknown, ...args: unknown[]) => {
      const result = Reflect.apply(originalMkdir, fs, [target, ...args]) as unknown;
      if (!injected && path.resolve(String(target)) === path.resolve(notesDirectory)) {
        injected = true;
        fs.renameSync(ownerDirectory, displaced);
        originalMkdir(ownerDirectory);
      }
      return result;
    }) as typeof fs.mkdirSync;
    try {
      assert.throws(
        () => writeMemoryNote(root, 'blocked.md', 'must-not-write', alice),
        /changed during operation|boundary/i,
      );
    } finally {
      fs.mkdirSync = originalMkdir;
    }
    assert.equal(fs.existsSync(path.join(ownerDirectory, 'notes', 'blocked.md')), false);
    assert.equal(fs.existsSync(path.join(displaced, 'notes', 'blocked.md')), false);
  });
});

test('settings update keeps one guard across read and write', () => {
  withEncryptionDisabled(() => {
    const root = tempRoot();
    writeMemorySettings(root, { paused: false }, alice);
    const ownerDirectory = memoryOwnerDir(root, alice);
    const displaced = `${ownerDirectory}.original`;
    const injection = injectDirectorySwapAfterFileClose(ownerDirectory, displaced);
    try {
      assert.throws(
        () => writeMemorySettings(root, { paused: true }, alice),
        /changed during operation|boundary/i,
      );
    } finally {
      injection.restore();
    }
    assert.equal(injection.wasInjected(), true);
    assert.equal(fs.existsSync(path.join(ownerDirectory, 'memory-settings.json')), false);
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(displaced, 'memory-settings.json'), 'utf8')).paused,
      false,
    );
  });
});

test('descriptor-based memory reads preserve AtRestKeyError identity', () => {
  withEncryptionDisabled(() => {
    const root = tempRoot();
    writeMemorySettings(root, { paused: false }, alice);
    const keyError = new AtRestKeyError('injected memory key failure');
    const originalRead = fs.readFileSync;
    let injected = false;
    fs.readFileSync = ((target: unknown, ...args: unknown[]) => {
      if (!injected && typeof target === 'number') {
        injected = true;
        throw keyError;
      }
      return Reflect.apply(originalRead, fs, [target, ...args]) as unknown;
    }) as typeof fs.readFileSync;
    try {
      assert.throws(() => readMemorySettings(root, alice), (error) => error === keyError);
    } finally {
      fs.readFileSync = originalRead;
    }
  });
});
