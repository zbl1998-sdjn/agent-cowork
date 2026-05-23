import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readFilePreview } from '../src/workspace/file-preview.js';
import { makeTestWorkspace } from './test-fixtures.js';

// Use the project's non-sensitive workspace root (the OS temp dir is blocked by
// the path policy on Windows).
function mkRoot() {
  return makeTestWorkspace('kcw-preview');
}

test('image files come back as base64 with the right mime', () => {
  const root = mkRoot();
  fs.writeFileSync(path.join(root, 'pic.png'), Buffer.from('not-a-real-png-but-bytes'));
  const r = readFilePreview('pic.png', { trustedRoot: root });
  assert.equal(r.kind, 'image');
  assert.equal(r.mime, 'image/png');
  assert.ok(r.base64 && r.base64.length > 0);
  assert.equal(r.text, undefined);
});

test('markdown comes back as text (kind=markdown)', () => {
  const root = mkRoot();
  fs.writeFileSync(path.join(root, 'note.md'), '# Hello\n\nworld');
  const r = readFilePreview('note.md', { trustedRoot: root });
  assert.equal(r.kind, 'markdown');
  assert.match(r.text, /# Hello/);
  assert.equal(r.base64, undefined);
});

test('pdf comes back as base64 (kind=pdf)', () => {
  const root = mkRoot();
  fs.writeFileSync(path.join(root, 'doc.pdf'), Buffer.from('%PDF-1.4 fake'));
  const r = readFilePreview('doc.pdf', { trustedRoot: root });
  assert.equal(r.kind, 'pdf');
  assert.equal(r.mime, 'application/pdf');
  assert.ok(r.base64.length > 0);
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
    (err) => err.statusCode === 413,
  );
});

test('missing files are rejected with 404', () => {
  const root = mkRoot();
  assert.throws(
    () => readFilePreview('nope.txt', { trustedRoot: root }),
    (err) => err.statusCode === 404,
  );
});
