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

test('forbids rename when target already exists', () => {
  const source = path.join(root, 'rename-source.txt');
  const target = path.join(root, 'rename-target.txt');
  fs.writeFileSync(source, 'source', 'utf8');
  fs.writeFileSync(target, 'target', 'utf8');

  assert.throws(
    () => previewFileOperations([{ type: 'rename', path: source, newName: path.basename(target) }], { trustedRoot: root }),
    /target already exists/i,
  );
});

test('forbids move when target already exists', () => {
  const source = path.join(root, 'move-source.txt');
  const target = path.join(root, 'archive', 'move-target.txt');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(source, 'source', 'utf8');
  fs.writeFileSync(target, 'target', 'utf8');

  assert.throws(
    () => previewFileOperations([{ type: 'move', from: source, to: target }], { trustedRoot: root }),
    /target already exists/i,
  );
});

test('forbids move when target directory already exists', () => {
  const source = path.join(root, 'move-source-dir-target.txt');
  const target = path.join(root, 'archive', 'existing-dir-target');
  fs.writeFileSync(source, 'source', 'utf8');
  fs.mkdirSync(target, { recursive: true });

  assert.throws(
    () => previewFileOperations([{ type: 'move', from: source, to: target }], { trustedRoot: root }),
    /target already exists/i,
  );
});
