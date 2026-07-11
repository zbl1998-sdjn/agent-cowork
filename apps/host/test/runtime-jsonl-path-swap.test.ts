import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { appendValidatedJsonl } from '../src/runtime/jsonl-file.js';

type Row = { id: string };
type SymlinkSync = (target: string, linkPath: string, type?: 'file' | 'dir' | 'junction') => void;
const symlinkSync = (fs as unknown as { symlinkSync: SymlinkSync }).symlinkSync;
const validate = (value: unknown): Row => {
  if (!value || typeof value !== 'object' || typeof (value as { id?: unknown }).id !== 'string') {
    throw new Error('invalid row');
  }
  return value as Row;
};

test('runtime JSONL append fails before writing when its parent is swapped after open', {
  skip: process.platform !== 'win32',
}, (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-runtime-jsonl-swap-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-runtime-jsonl-outside-'));
  const displaced = `${parent}-original`;
  const file = path.join(parent, 'runs.jsonl');
  const outsideFile = path.join(outside, 'runs.jsonl');
  fs.writeFileSync(file, '{"id":"seed"}\n', 'utf8');
  fs.writeFileSync(outsideFile, 'outside-sentinel\n', 'utf8');
  const originalBytes = fs.readFileSync(file, 'utf8');
  const originalOpen = fs.openSync;
  let swapped = false;
  fs.openSync = ((target: string, flags: string | number, mode?: number) => {
    if (!swapped && path.resolve(String(target)) === path.resolve(file)) {
      fs.renameSync(parent, displaced);
      try { symlinkSync(outside, parent, 'junction'); } catch (error) {
        fs.renameSync(displaced, parent);
        t.skip(`junction unavailable: ${String(error)}`);
      }
      swapped = true;
    }
    return originalOpen(target, flags, mode);
  }) as typeof fs.openSync;
  try {
    assert.throws(
      () => appendValidatedJsonl(file, { id: 'blocked' }, 'runs index', validate),
      /changed|junction|reparse/i,
    );
  } finally {
    fs.openSync = originalOpen;
  }
  assert.equal(swapped, true);
  assert.equal(fs.readFileSync(path.join(displaced, 'runs.jsonl'), 'utf8'), originalBytes);
  assert.equal(fs.readFileSync(outsideFile, 'utf8'), 'outside-sentinel\n');
});

test('runtime JSONL append rejects an ordinary replacement parent before writing', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-runtime-jsonl-dir-swap-'));
  const replacement = fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-runtime-jsonl-replacement-'));
  const displaced = `${parent}-original`;
  const file = path.join(parent, 'runs.jsonl');
  fs.writeFileSync(file, '{"id":"seed"}\n', 'utf8');
  fs.writeFileSync(path.join(replacement, 'runs.jsonl'), 'replacement-sentinel\n', 'utf8');
  const originalBytes = fs.readFileSync(file, 'utf8');
  const originalOpen = fs.openSync;
  fs.openSync = ((target: string, flags: string | number, mode?: number) => {
    if (path.resolve(target) === path.resolve(file)) {
      fs.renameSync(parent, displaced);
      fs.renameSync(replacement, parent);
    }
    return originalOpen(target, flags, mode);
  }) as typeof fs.openSync;
  try {
    assert.throws(
      () => appendValidatedJsonl(file, { id: 'blocked' }, 'runs index', validate),
      /changed/i,
    );
  } finally {
    fs.openSync = originalOpen;
  }
  assert.equal(fs.readFileSync(path.join(displaced, 'runs.jsonl'), 'utf8'), originalBytes);
  assert.equal(fs.readFileSync(file, 'utf8'), 'replacement-sentinel\n');
});
