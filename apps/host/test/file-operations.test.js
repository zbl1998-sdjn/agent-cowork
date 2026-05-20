import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { previewFileOperations, applyFileOperations } from '../src/workspace/file-operations.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kfcowork-ops-'));

test('forbids delete operations', () => {
  assert.throws(() => previewFileOperations([{ type: 'delete', path: path.join(root, 'a.txt') }], { trustedRoot: root }), /forbidden/i);
});

test('forbids overwrite by default', () => {
  const target = path.join(root, 'existing.txt');
  fs.writeFileSync(target, 'old', 'utf8');
  assert.throws(
    () => previewFileOperations([{ type: 'write', path: target, content: 'new', overwrite: false }], { trustedRoot: root }),
    /overwrite/i,
  );
});

test('applies safe write without overwrite flag when file missing', () => {
  const target = path.join(root, 'new.txt');
  const applied = applyFileOperations([{ type: 'write', path: target, content: 'created' }], { trustedRoot: root });
  assert.equal(applied.applied.length, 1);
  assert.equal(applied.applied[0].status, 'applied');
  assert.equal(fs.readFileSync(target, 'utf8'), 'created');
});
