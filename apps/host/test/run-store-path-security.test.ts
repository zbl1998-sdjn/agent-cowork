import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  listRunRecords,
  readRunRecord,
  writeRunRecord,
} from '../src/runtime/run-store.js';
import { samePathReal } from './helpers/path-swap.js';

type SymlinkSync = (target: string, linkPath: string, type?: 'file' | 'dir' | 'junction') => void;
const symlinkSync = (fs as unknown as { symlinkSync: SymlinkSync }).symlinkSync;

function tempRoot(prefix = 'kcw-run-path-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function linkDirectory(target: string, linkPath: string): void {
  try {
    symlinkSync(target, linkPath, 'junction');
  } catch {
    symlinkSync(target, linkPath, 'dir');
  }
}

function persistedRun(id: string) {
  return {
    id,
    status: 'succeeded',
    startedAt: '2026-07-11T00:00:00.000Z',
    input: { prompt: 'private run data' },
  };
}

test('run writes reject same-root .owners junctions without publishing a claim or record', () => {
  const root = tempRoot();
  const runs = path.join(root, 'runs');
  const sibling = path.join(root, 'sibling');
  fs.mkdirSync(runs);
  fs.mkdirSync(sibling);
  linkDirectory(sibling, path.join(runs, '.owners'));

  assert.throws(
    () => writeRunRecord(runs, persistedRun('run_owner_junction')),
    /symbolic link|junction|reparse|managed|path boundary/i,
  );
  assert.deepEqual(fs.readdirSync(sibling), []);
  assert.equal(fs.existsSync(path.join(runs, 'run_owner_junction.json')), false);
});

test('one run write guard rejects a regular .owners directory replaced during mkdir', () => {
  const root = tempRoot();
  const runs = path.join(root, 'runs');
  const owners = path.join(runs, '.owners');
  const displaced = path.join(runs, '.owners-original');
  fs.mkdirSync(owners, { recursive: true });
  const originalMkdirSync = fs.mkdirSync;
  let swapped = false;
  fs.mkdirSync = ((...args: unknown[]) => {
    const result = Reflect.apply(originalMkdirSync, fs, args);
    if (!swapped && samePathReal(String(args[0]), owners)) {
      fs.renameSync(owners, displaced);
      originalMkdirSync(owners);
      swapped = true;
    }
    return result;
  }) as typeof fs.mkdirSync;

  try {
    assert.throws(
      () => writeRunRecord(runs, persistedRun('run_owner_swap')),
      /changed during operation|path boundary|managed/i,
    );
  } finally {
    fs.mkdirSync = originalMkdirSync;
  }
  assert.equal(swapped, true, 'test must replace the existing .owners directory');
  assert.deepEqual(fs.readdirSync(owners), []);
  assert.equal(fs.existsSync(path.join(runs, 'run_owner_swap.json')), false);
});

test('run reads and lists reject a run root junction', () => {
  const container = tempRoot();
  const outside = tempRoot('kcw-run-path-outside-');
  const runId = 'run_linked_root';
  fs.writeFileSync(path.join(outside, `${runId}.json`), `${JSON.stringify(persistedRun(runId))}\n`, 'utf8');
  const linkedRoot = path.join(container, 'runs');
  linkDirectory(outside, linkedRoot);

  assert.throws(
    () => readRunRecord(linkedRoot, runId),
    /symbolic link|junction|reparse|managed|path boundary/i,
  );
  assert.throws(
    () => listRunRecords(linkedRoot),
    /symbolic link|junction|reparse|managed|path boundary/i,
  );
});

test('run listing revalidates the root after enumeration', () => {
  const container = tempRoot();
  const runs = path.join(container, 'runs');
  const displaced = path.join(container, 'runs-original');
  const runId = 'run_list_root_swap';
  fs.mkdirSync(runs);
  fs.writeFileSync(path.join(runs, `${runId}.json`), `${JSON.stringify(persistedRun(runId))}\n`, 'utf8');
  const originalReaddirSync = fs.readdirSync;
  let swapped = false;
  fs.readdirSync = ((...args: unknown[]) => {
    const result = Reflect.apply(originalReaddirSync, fs, args);
    if (!swapped && samePathReal(String(args[0]), runs)) {
      fs.renameSync(runs, displaced);
      fs.mkdirSync(runs);
      fs.writeFileSync(path.join(runs, 'attacker.json'), 'preserve', 'utf8');
      swapped = true;
    }
    return result;
  }) as typeof fs.readdirSync;

  try {
    assert.throws(() => listRunRecords(runs), /changed during operation|path boundary|managed/i);
  } finally {
    fs.readdirSync = originalReaddirSync;
  }
  assert.equal(swapped, true);
  assert.equal(fs.readFileSync(path.join(runs, 'attacker.json'), 'utf8'), 'preserve');
});

test('run listing does not swallow a record identity change after descriptor read', () => {
  const runs = path.join(tempRoot(), 'runs');
  const runId = 'run_list_entry_swap';
  const file = path.join(runs, `${runId}.json`);
  const displaced = path.join(runs, `${runId}.original.json`);
  fs.mkdirSync(runs);
  fs.writeFileSync(file, `${JSON.stringify(persistedRun(runId))}\n`, 'utf8');
  const originalReadFileSync = fs.readFileSync;
  let swapped = false;
  fs.readFileSync = ((...args: unknown[]) => {
    const result = Reflect.apply(originalReadFileSync, fs, args);
    const target = args[0];
    if (!swapped && (typeof target === 'number' || path.resolve(String(target)) === path.resolve(file))) {
      fs.renameSync(file, displaced);
      fs.writeFileSync(file, `${JSON.stringify(persistedRun(runId))}\n`, 'utf8');
      swapped = true;
    }
    return result;
  }) as typeof fs.readFileSync;

  try {
    assert.throws(() => listRunRecords(runs), /changed during operation|path boundary|managed file/i);
  } finally {
    fs.readFileSync = originalReadFileSync;
  }
  assert.equal(swapped, true, 'test must replace the record after its bytes are read');
});
