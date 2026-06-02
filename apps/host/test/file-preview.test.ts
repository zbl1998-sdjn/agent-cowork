import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readFilePreview } from '../src/workspace/file-preview.js';
import type { BinaryPreview, DelimitedPreview, FilePreview, TextPreview } from '../src/workspace/file-preview.js';
import { makeTestWorkspace } from './test-fixtures.js';

// Use the project's non-sensitive workspace root (the OS temp dir is blocked by
// the path policy on Windows).
function mkRoot() {
  return makeTestWorkspace('kcw-preview');
}

function expectBinaryKind(preview: FilePreview, kind: BinaryPreview['kind']): BinaryPreview {
  assert.equal(preview.kind, kind);
  return preview as BinaryPreview;
}

function expectTextKind(preview: FilePreview, kind: TextPreview['kind']): TextPreview {
  assert.equal(preview.kind, kind);
  return preview as TextPreview;
}

function expectTableKind(preview: FilePreview): DelimitedPreview {
  assert.equal(preview.kind, 'table');
  return preview as DelimitedPreview;
}

function hasStatusCode(error: unknown, statusCode: number): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  return (error as { statusCode?: unknown }).statusCode === statusCode;
}

test('image files come back as base64 with the right mime', () => {
  const root = mkRoot();
  fs.writeFileSync(path.join(root, 'pic.png'), Buffer.from('not-a-real-png-but-bytes'));
  const r = expectBinaryKind(readFilePreview('pic.png', { trustedRoot: root }), 'image');
  assert.equal(r.mime, 'image/png');
  assert.ok(r.base64 && r.base64.length > 0);
});

test('markdown comes back as text (kind=markdown)', () => {
  const root = mkRoot();
  fs.writeFileSync(path.join(root, 'note.md'), '# Hello\n\nworld');
  const r = expectTextKind(readFilePreview('note.md', { trustedRoot: root }), 'markdown');
  assert.match(r.text, /# Hello/);
});

test('pdf comes back as base64 (kind=pdf)', () => {
  const root = mkRoot();
  fs.writeFileSync(path.join(root, 'doc.pdf'), Buffer.from('%PDF-1.4 fake'));
  const r = expectBinaryKind(readFilePreview('doc.pdf', { trustedRoot: root }), 'pdf');
  assert.equal(r.mime, 'application/pdf');
  assert.ok(r.base64.length > 0);
});

test('csv comes back as a bounded table preview', () => {
  const root = mkRoot();
  fs.writeFileSync(path.join(root, 'data.csv'), 'name,amount\nA,12\n"B,B",34\n');
  const r = expectTableKind(readFilePreview('data.csv', { trustedRoot: root }));
  assert.deepEqual(r.table.headers, ['name', 'amount']);
  assert.deepEqual(r.table.rows, [['A', '12'], ['B,B', '34']]);
  assert.match(r.text, /amount/);
});

test('diff files keep a dedicated preview kind', () => {
  const root = mkRoot();
  fs.writeFileSync(path.join(root, 'change.diff'), '--- a/a.txt\n+++ b/a.txt\n+new\n');
  const r = expectTextKind(readFilePreview('change.diff', { trustedRoot: root }), 'diff');
  assert.equal(r.mime, 'text/x-diff');
  assert.match(r.text, /\+new/);
});

test('path traversal outside the trusted root is rejected', () => {
  const root = mkRoot();
  assert.throws(() => readFilePreview('../escape.png', { trustedRoot: root }));
});

test('oversized files are rejected with 413', () => {
  const root = mkRoot();
  fs.writeFileSync(path.join(root, 'big.txt'), 'x'.repeat(2048));
  assert.throws(
    () => readFilePreview('big.txt', { trustedRoot: root, maxBytes: 100 }),
    (err) => hasStatusCode(err, 413),
  );
});

test('preview maxBytes is hard-capped and hidden files are blocked', () => {
  const root = mkRoot();
  fs.writeFileSync(path.join(root, 'huge.txt'), 'x'.repeat(8 * 1024 * 1024 + 1), 'utf8');
  fs.writeFileSync(path.join(root, '.npmrc'), 'token=secret', 'utf8');

  assert.throws(
    () => readFilePreview('huge.txt', { trustedRoot: root, maxBytes: Number.POSITIVE_INFINITY }),
    (err) => hasStatusCode(err, 413),
  );
  assert.throws(() => readFilePreview('.npmrc', { trustedRoot: root }), /blocked by policy/);
});

test('missing files are rejected with 404', () => {
  const root = mkRoot();
  assert.throws(
    () => readFilePreview('nope.txt', { trustedRoot: root }),
    (err) => hasStatusCode(err, 404),
  );
});
