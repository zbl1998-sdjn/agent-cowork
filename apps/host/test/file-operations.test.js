import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { previewFileOperations, applyFileOperations, rollbackFileOperations } from '../src/workspace/file-operations.js';
import { makeTestWorkspace } from './test-fixtures.js';

const root = makeTestWorkspace('kfcowork-ops');

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

test('applies binary write operations from base64 content', () => {
  const target = path.join(root, 'report.xlsx');
  const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]);
  const applied = applyFileOperations(
    [
      {
        type: 'write',
        path: target,
        encoding: 'base64',
        contentBase64: bytes.toString('base64'),
      },
    ],
    { trustedRoot: root },
  );
  assert.equal(applied.applied.length, 1);
  assert.deepEqual(fs.readFileSync(target), bytes);
});

test('rolls back a newly created file only when the expected hash still matches', () => {
  const target = path.join(root, 'rollback-created.txt');
  const applied = applyFileOperations([{ type: 'write', path: target, content: 'created-for-rollback' }], { trustedRoot: root });
  assert.equal(fs.existsSync(target), true);

  const rolledBack = rollbackFileOperations(applied.applied, { trustedRoot: root });
  assert.equal(rolledBack.rolledBack.length, 1);
  assert.equal(rolledBack.rolledBack[0].status, 'rolled_back');
  assert.equal(fs.existsSync(target), false);
});

test('restores overwritten file content from a jailed rollback backup', () => {
  const target = path.join(root, 'rollback-overwrite.txt');
  fs.writeFileSync(target, 'before', 'utf8');
  const applied = applyFileOperations(
    [{ type: 'write', path: target, content: 'after', overwrite: true }],
    { trustedRoot: root, rollbackBatchId: 'test-overwrite' },
  );
  assert.equal(fs.readFileSync(target, 'utf8'), 'after');
  assert.match(applied.applied[0].rollback.backupPath, /[\\/]rollback[\\/]test-overwrite[\\/]/);

  rollbackFileOperations(applied.applied, { trustedRoot: root });
  assert.equal(fs.readFileSync(target, 'utf8'), 'before');
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

test('rolls back move operations in reverse order', () => {
  const source = path.join(root, 'rollback-move-source.txt');
  const target = path.join(root, 'rollback', 'rollback-move-target.txt');
  fs.writeFileSync(source, 'move-me-back', 'utf8');

  const applied = applyFileOperations([{ type: 'move', from: source, to: target }], { trustedRoot: root });
  assert.equal(fs.existsSync(source), false);
  assert.equal(fs.readFileSync(target, 'utf8'), 'move-me-back');

  rollbackFileOperations(applied.applied, { trustedRoot: root });
  assert.equal(fs.readFileSync(source, 'utf8'), 'move-me-back');
  assert.equal(fs.existsSync(target), false);
});
