import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  writePrivateFileAtomically,
  writePrivateFileOnceAtomically,
} from '../src/security/private-atomic-file.js';

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-private-atomic-'));
}

test('atomic writer rejects unsafe suffixes before touching the destination directory', () => {
  for (const suffix of ['', '../escape', 'nested/name', 'a'.repeat(129)]) {
    const root = tempRoot();
    const directory = path.join(root, 'private');
    assert.throws(
      () => writePrivateFileAtomically(path.join(directory, 'record.json'), 'secret', {
        randomSuffix: () => suffix,
      }),
      /Invalid atomic file suffix/,
    );
    assert.equal(fs.existsSync(directory), false);
  }
});

test('atomic writer never removes a colliding temporary file it did not create', () => {
  const directory = tempRoot();
  const target = path.join(directory, 'record.json');
  const suffix = 'collision';
  const temporary = path.join(directory, `.record.json.${process.pid}.${suffix}.tmp`);
  fs.writeFileSync(target, 'before', 'utf8');
  fs.writeFileSync(temporary, 'sentinel', 'utf8');

  assert.throws(
    () => writePrivateFileAtomically(target, 'after', { randomSuffix: () => suffix }),
    (error: unknown) => (error as { code?: unknown }).code === 'EEXIST',
  );
  assert.equal(fs.readFileSync(target, 'utf8'), 'before');
  assert.equal(fs.readFileSync(temporary, 'utf8'), 'sentinel');
});

test('atomic writer removes its partial temporary file after a write failure', () => {
  const directory = tempRoot();
  const target = path.join(directory, 'record.json');
  fs.writeFileSync(target, 'before', 'utf8');
  const originalWriteFileSync = fs.writeFileSync;
  fs.writeFileSync = ((...args: unknown[]) => {
    const [destination] = args;
    if (typeof destination === 'number') {
      const writeDescriptor = originalWriteFileSync as unknown as (
        descriptor: number,
        data: string,
        encoding: string,
      ) => void;
      writeDescriptor(destination, 'partial', 'utf8');
      throw new Error('injected partial write failure');
    }
    return Reflect.apply(originalWriteFileSync, fs, args);
  }) as typeof fs.writeFileSync;

  try {
    assert.throws(
      () => writePrivateFileAtomically(target, 'after', { randomSuffix: () => 'partial' }),
      /injected partial write failure/,
    );
  } finally {
    fs.writeFileSync = originalWriteFileSync;
  }

  assert.equal(fs.readFileSync(target, 'utf8'), 'before');
  assert.deepEqual(fs.readdirSync(directory), ['record.json']);
});

test('atomic writer replaces the destination and leaves no temporary sibling', () => {
  const directory = tempRoot();
  const target = path.join(directory, 'record.json');
  fs.writeFileSync(target, 'before', 'utf8');

  writePrivateFileAtomically(target, 'after', { randomSuffix: () => 'success' });

  assert.equal(fs.readFileSync(target, 'utf8'), 'after');
  assert.deepEqual(fs.readdirSync(directory), ['record.json']);
});

test('atomic writers fsync each complete candidate before publishing it', () => {
  const directory = tempRoot();
  const replaceTarget = path.join(directory, 'record.json');
  const onceTarget = path.join(directory, 'claim.json');
  const originalFsyncSync = fs.fsyncSync;
  const originalRenameSync = fs.renameSync;
  const fileSystem = fs as unknown as {
    linkSync(source: string, destination: string): void;
  };
  const originalLinkSync = fileSystem.linkSync;
  let synced = false;
  let publishes = 0;

  fs.fsyncSync = ((descriptor: number) => {
    synced = true;
    return originalFsyncSync(descriptor);
  }) as typeof fs.fsyncSync;
  fs.renameSync = ((source: fs.PathLike, destination: fs.PathLike) => {
    assert.equal(synced, true, 'replacement candidate must be synced before rename');
    publishes += 1;
    synced = false;
    return originalRenameSync(source, destination);
  }) as typeof fs.renameSync;
  fileSystem.linkSync = (source, destination) => {
    assert.equal(synced, true, 'create-once candidate must be synced before link');
    publishes += 1;
    synced = false;
    return originalLinkSync(source, destination);
  };

  try {
    writePrivateFileAtomically(replaceTarget, 'replacement', { randomSuffix: () => 'sync-replace' });
    writePrivateFileOnceAtomically(onceTarget, 'create-once', { randomSuffix: () => 'sync-once' });
  } finally {
    fs.fsyncSync = originalFsyncSync;
    fs.renameSync = originalRenameSync;
    fileSystem.linkSync = originalLinkSync;
  }
  assert.equal(publishes, 2);
});

test('create-once atomic writer preserves an existing winner and removes its candidate', () => {
  const directory = tempRoot();
  const target = path.join(directory, 'claim.json');
  fs.writeFileSync(target, 'winner', 'utf8');

  const created = writePrivateFileOnceAtomically(target, 'candidate', {
    randomSuffix: () => 'loser',
  });

  assert.equal(created, false);
  assert.equal(fs.readFileSync(target, 'utf8'), 'winner');
  assert.deepEqual(fs.readdirSync(directory), ['claim.json']);
});

test('create-once writer runs the optional path guard after mkdir and before candidate creation', () => {
  const root = tempRoot();
  const directory = path.join(root, 'claims');
  const target = path.join(directory, 'claim.json');
  const guarded: string[] = [];

  assert.throws(
    () => writePrivateFileOnceAtomically(target, 'candidate', {
      randomSuffix: () => 'guarded',
      beforeFilesystemMutation(candidatePath) {
        guarded.push(candidatePath);
        if (path.basename(candidatePath).endsWith('.tmp')) {
          throw new Error('injected path guard rejection');
        }
      },
    }),
    /injected path guard rejection/,
  );

  assert.ok(guarded.some((candidate) => path.resolve(candidate) === path.resolve(directory)));
  assert.equal(fs.existsSync(target), false);
  assert.deepEqual(fs.readdirSync(directory), []);
});

test('create-once atomic writer cleans a partial candidate and failed publish', () => {
  for (const failure of ['write', 'publish'] as const) {
    const directory = tempRoot();
    const target = path.join(directory, 'claim.json');
    const originalWriteFileSync = fs.writeFileSync;
    const fileSystem = fs as unknown as {
      linkSync(source: string, destination: string): void;
    };
    const originalLinkSync = fileSystem.linkSync;
    if (failure === 'write') {
      fs.writeFileSync = ((...args: unknown[]) => {
        const [destination] = args;
        if (typeof destination === 'number') {
          const writeDescriptor = originalWriteFileSync as unknown as (
            descriptor: number,
            data: string,
            encoding: string,
          ) => void;
          writeDescriptor(destination, 'partial', 'utf8');
          throw new Error('injected create-once write failure');
        }
        return Reflect.apply(originalWriteFileSync, fs, args);
      }) as typeof fs.writeFileSync;
    } else {
      fileSystem.linkSync = () => {
        throw new Error('injected create-once publish failure');
      };
    }

    try {
      assert.throws(
        () => writePrivateFileOnceAtomically(target, 'candidate', {
          randomSuffix: () => failure,
        }),
        new RegExp(`injected create-once ${failure} failure`),
      );
    } finally {
      fs.writeFileSync = originalWriteFileSync;
      fileSystem.linkSync = originalLinkSync;
    }
    assert.equal(fs.existsSync(target), false);
    assert.deepEqual(fs.readdirSync(directory), []);
  }
});

test('create-once atomic writer publishes a complete private file exactly once', () => {
  const directory = tempRoot();
  const target = path.join(directory, 'claim.json');

  assert.equal(writePrivateFileOnceAtomically(target, 'first', {
    randomSuffix: () => 'first',
  }), true);
  assert.equal(writePrivateFileOnceAtomically(target, 'second', {
    randomSuffix: () => 'second',
  }), false);
  assert.equal(fs.readFileSync(target, 'utf8'), 'first');
  assert.deepEqual(fs.readdirSync(directory), ['claim.json']);
});
