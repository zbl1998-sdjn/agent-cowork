import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApprovalDiffPreview } from '../src/engine/agent/approval-diff-preview.js';

test('text edits round-trip as a diffable text preview', () => {
  const preview = buildApprovalDiffPreview({ path: 'a.txt', before: 'hello\nworld\n', after: 'hello\nthere\n' });
  assert.deepEqual(preview, { kind: 'text', path: 'a.txt', before: 'hello\nworld\n', after: 'hello\nthere\n' });
});

test('a brand-new file has a null before side', () => {
  const preview = buildApprovalDiffPreview({ path: 'new.txt', before: null, after: 'fresh content\n' });
  assert.deepEqual(preview, { kind: 'text', path: 'new.txt', before: null, after: 'fresh content\n' });
});

const NUL = String.fromCharCode(0);

test('binary content (NUL byte) in the new content switches to a byte-count-only preview', () => {
  const binaryAfterContent = `PNG${NUL}DATA`;
  const preview = buildApprovalDiffPreview({ path: 'img.png', before: null, after: binaryAfterContent });
  assert.equal(preview.kind, 'binary');
  assert.equal((preview as { beforeBytes: number | null }).beforeBytes, null);
  assert.equal((preview as { afterBytes: number }).afterBytes, Buffer.byteLength(binaryAfterContent, 'utf8'));
});

test('binary content (NUL byte) in the existing file also switches to a byte-count-only preview', () => {
  const binaryBeforeContent = `OLD${NUL}BYTES`;
  const preview = buildApprovalDiffPreview({ path: 'img.png', before: binaryBeforeContent, after: 'new text' });
  assert.equal(preview.kind, 'binary');
  assert.equal((preview as { beforeBytes: number | null }).beforeBytes, Buffer.byteLength(binaryBeforeContent, 'utf8'));
  assert.equal((preview as { afterBytes: number }).afterBytes, Buffer.byteLength('new text', 'utf8'));
});

test('oversized text is clipped with a truncation marker rather than sent whole', () => {
  const huge = 'x'.repeat(10_000);
  const preview = buildApprovalDiffPreview({ path: 'big.txt', before: null, after: huge });
  assert.equal(preview.kind, 'text');
  const after = (preview as { after: string }).after;
  assert.ok(after.length < huge.length);
  assert.match(after, /已截断/);
});
