import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonlWriter } from '../src/storage/jsonl-writer.js';

test('JsonlWriter rotates by size and keeps maxFiles generations', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-jsonl-'));
  const file = path.join(dir, 'audit.jsonl');
  // tiny cap so a few records trigger rotation; keep 2 generations.
  const w = new JsonlWriter(file, { maxBytes: 200, maxFiles: 2 });
  for (let i = 0; i < 50; i += 1) w.append({ i, pad: 'x'.repeat(40) });

  assert.ok(fs.existsSync(file), 'live file exists');
  assert.ok(fs.existsSync(`${file}.1`), 'rotated .1 exists');
  // maxFiles=2 -> never keep a .2
  assert.ok(!fs.existsSync(`${file}.2`), '.2 should not exist (dropped beyond maxFiles)');
  // live file stays bounded (roughly under cap + one record).
  assert.ok(fs.statSync(file).size <= 400, 'live file is bounded');
  // content is valid JSONL.
  const last = fs.readFileSync(file, 'utf8').trim().split('\n').pop();
  assert.ok(last);
  assert.doesNotThrow(() => JSON.parse(last));
});

test('JsonlWriter without rotation pressure keeps a single file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-jsonl2-'));
  const file = path.join(dir, 'a.jsonl');
  const w = new JsonlWriter(file, { maxBytes: 1024 * 1024 });
  w.append({ ok: 1 });
  w.append({ ok: 2 });
  assert.ok(!fs.existsSync(`${file}.1`), 'no rotation when under cap');
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 2);
});

test('JsonlWriter keeps the live file unchanged when staged rotation fails', () => {
  const scenarios: Array<{
    name: string;
    installFailure(): () => void;
  }> = [
    {
      name: 'copy',
      installFailure: () => {
        const original = fs.copyFileSync;
        fs.copyFileSync = (() => { throw new Error('injected copy failure'); }) as typeof fs.copyFileSync;
        return () => { fs.copyFileSync = original; };
      },
    },
    {
      name: 'fsync',
      installFailure: () => {
        const original = fs.fsyncSync;
        fs.fsyncSync = (() => { throw new Error('injected fsync failure'); }) as typeof fs.fsyncSync;
        return () => { fs.fsyncSync = original; };
      },
    },
    {
      name: 'rename',
      installFailure: () => {
        const original = fs.renameSync;
        fs.renameSync = (() => { throw new Error('injected rename failure'); }) as typeof fs.renameSync;
        return () => { fs.renameSync = original; };
      },
    },
  ];

  for (const scenario of scenarios) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `kcw-jsonl-${scenario.name}-`));
    const file = path.join(dir, 'audit.jsonl');
    fs.writeFileSync(file, '{"seed":"preserve-me"}\n', 'utf8');
    const before = fs.readFileSync(file, 'utf8');
    const writer = new JsonlWriter(file, { maxBytes: Buffer.byteLength(before, 'utf8'), maxFiles: 2 });
    const restore = scenario.installFailure();
    try {
      assert.throws(() => writer.append({ next: scenario.name }), /injected/);
      assert.equal(fs.readFileSync(file, 'utf8'), before, `${scenario.name} failure changed live bytes`);
    } finally {
      restore();
    }
  }
});

test('JsonlWriter appends through a private fsynced descriptor', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-jsonl-private-'));
  const file = path.join(dir, 'audit.jsonl');
  const fileSystem = fs as typeof fs & { fchmodSync(descriptor: number, mode: number): void };
  const originalOpen = fs.openSync;
  const originalFchmod = fileSystem.fchmodSync;
  const originalFsync = fs.fsyncSync;
  let openedMode: number | undefined;
  let chmodMode: number | undefined;
  let fsyncCalls = 0;
  fs.openSync = ((target: string, flags: string | number, mode?: number) => {
    if (path.resolve(target) === path.resolve(file)) openedMode = mode;
    return originalOpen(target, flags, mode);
  }) as typeof fs.openSync;
  fileSystem.fchmodSync = ((descriptor: number, mode: number) => {
    chmodMode = mode;
    originalFchmod(descriptor, mode);
  });
  fs.fsyncSync = ((descriptor: number) => {
    fsyncCalls += 1;
    originalFsync(descriptor);
  }) as typeof fs.fsyncSync;
  try {
    new JsonlWriter(file, { maxBytes: 1024 }).append({ private: true });
  } finally {
    fs.openSync = originalOpen;
    fileSystem.fchmodSync = originalFchmod;
    fs.fsyncSync = originalFsync;
  }
  assert.equal(openedMode, 0o600);
  assert.equal(chmodMode, 0o600);
  assert.ok(fsyncCalls > 0);
});
