import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { JsonlWriter } from '../src/storage/jsonl-writer.js';
import { samePathReal } from './helpers/path-swap.js';

type SymlinkSync = (target: string, linkPath: string, type?: 'file' | 'dir' | 'junction') => void;
const symlinkSync = (fs as unknown as { symlinkSync: SymlinkSync }).symlinkSync;

test('JsonlWriter append fails before writing when its managed parent is swapped after open', {
  skip: process.platform !== 'win32',
}, (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-jsonl-swap-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-jsonl-outside-'));
  const displaced = `${parent}-original`;
  const file = path.join(parent, 'audit.jsonl');
  const outsideFile = path.join(outside, 'audit.jsonl');
  fs.writeFileSync(file, '{"seed":true}\n', 'utf8');
  fs.writeFileSync(outsideFile, 'outside-sentinel\n', 'utf8');
  const originalBytes = fs.readFileSync(file, 'utf8');
  const writer = new JsonlWriter(file, { maxBytes: 1024 });
  const originalOpen = fs.openSync;
  let swapped = false;
  fs.openSync = ((target: string, flags: string | number, mode?: number) => {
    if (!swapped && samePathReal(String(target), file)) {
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
    assert.throws(() => writer.append({ blocked: true }), /changed|junction|reparse/i);
  } finally {
    fs.openSync = originalOpen;
  }
  assert.equal(swapped, true);
  assert.equal(fs.readFileSync(path.join(displaced, 'audit.jsonl'), 'utf8'), originalBytes);
  assert.equal(fs.readFileSync(outsideFile, 'utf8'), 'outside-sentinel\n');
});

test('JsonlWriter append rejects an ordinary replacement parent before writing', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-jsonl-dir-swap-'));
  const replacement = fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-jsonl-replacement-'));
  const displaced = `${parent}-original`;
  const file = path.join(parent, 'audit.jsonl');
  fs.writeFileSync(file, '{"seed":true}\n', 'utf8');
  fs.writeFileSync(path.join(replacement, 'audit.jsonl'), 'replacement-sentinel\n', 'utf8');
  const originalBytes = fs.readFileSync(file, 'utf8');
  const writer = new JsonlWriter(file, { maxBytes: 1024 });
  const originalOpen = fs.openSync;
  fs.openSync = ((target: string, flags: string | number, mode?: number) => {
    if (samePathReal(target, file)) {
      fs.renameSync(parent, displaced);
      fs.renameSync(replacement, parent);
    }
    return originalOpen(target, flags, mode);
  }) as typeof fs.openSync;
  try {
    assert.throws(() => writer.append({ blocked: true }), /changed/i);
  } finally {
    fs.openSync = originalOpen;
  }
  assert.equal(fs.readFileSync(path.join(displaced, 'audit.jsonl'), 'utf8'), originalBytes);
  assert.equal(fs.readFileSync(file, 'utf8'), 'replacement-sentinel\n');
});
