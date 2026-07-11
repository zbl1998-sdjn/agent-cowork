import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { RunsIndex } from '../src/runtime/runs-index.js';

type SymlinkSync = (target: string, linkPath: string, type?: 'file' | 'dir' | 'junction') => void;
const symlinkSync = (fs as unknown as { symlinkSync: SymlinkSync }).symlinkSync;

function tempRoot(prefix = 'kcw-runs-index-path-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function linkDirectory(target: string, linkPath: string): void {
  try {
    symlinkSync(target, linkPath, 'junction');
  } catch {
    symlinkSync(target, linkPath, 'dir');
  }
}

function record(id: string): Record<string, unknown> {
  return { id, tenantId: 'tenant_a', userId: 'user_a', type: 'agent', status: 'running' };
}

test('RunsIndex constructor rejects replay through an indexRoot junction', () => {
  const container = tempRoot();
  const outside = tempRoot('kcw-runs-index-outside-');
  fs.writeFileSync(path.join(outside, 'index.jsonl'), '', 'utf8');
  const linkedRoot = path.join(container, 'index');
  linkDirectory(outside, linkedRoot);

  assert.throws(
    () => new RunsIndex({ indexRoot: linkedRoot }),
    /symbolic link|junction|reparse|managed/i,
  );
});

test('RunsIndex append rejects a root junction installed after construction', () => {
  const container = tempRoot();
  const outside = tempRoot('kcw-runs-index-append-outside-');
  const root = path.join(container, 'index');
  const displaced = path.join(container, 'index-original');
  fs.mkdirSync(root);
  const index = new RunsIndex({ indexRoot: root });
  fs.renameSync(root, displaced);
  linkDirectory(outside, root);

  assert.throws(
    () => index.upsert(record('run_index_root_junction')),
    /changed|symbolic link|junction|reparse|managed/i,
  );
  assert.equal(index.get('run_index_root_junction'), null);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('RunsIndex keeps one boundary from owner claim through JSONL append', () => {
  const container = tempRoot();
  const root = path.join(container, 'index');
  const displaced = path.join(container, 'index-original');
  fs.mkdirSync(root);
  const index = new RunsIndex({ indexRoot: root });
  const id = 'run_index_claim_then_swap';
  const claimName = `${crypto.createHash('sha256').update(id).digest('hex')}.json`;
  const claimPath = path.join(root, '.owners', claimName);
  const originalLstatSync = fs.lstatSync;
  let swapped = false;
  fs.lstatSync = ((...args: unknown[]) => {
    const result = Reflect.apply(originalLstatSync, fs, args);
    if (!swapped && path.resolve(String(args[0])) === path.resolve(claimPath) && result.isFile()) {
      fs.renameSync(root, displaced);
      fs.mkdirSync(root);
      swapped = true;
    }
    return result;
  }) as typeof fs.lstatSync;

  try {
    assert.throws(
      () => index.upsert(record(id)),
      /changed during operation|managed|path boundary/i,
    );
  } finally {
    fs.lstatSync = originalLstatSync;
  }
  assert.equal(swapped, true, 'test must replace indexRoot after claim verification');
  assert.equal(index.get(id), null, 'failed append must not update in-memory records');
  assert.deepEqual(fs.readdirSync(root), [], 'replacement root must receive no JSONL append');
});
