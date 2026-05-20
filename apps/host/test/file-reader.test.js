import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readTextFile } from '../src/workspace/file-reader.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kfcowork-reader-'));

test('reads text file with sha256 and size metadata', () => {
  const p = path.join(root, 'note.txt');
  const text = 'hello kimi cowork';
  fs.writeFileSync(p, text, 'utf8');

  const result = readTextFile(p, { trustedRoot: root, maxSize: 1024 });
  const expected = crypto.createHash('sha256').update(text).digest('hex');

  assert.equal(result.size, text.length);
  assert.equal(result.sha256, expected);
  assert.equal(result.content, text);
});

test('throws on oversized files', () => {
  const p = path.join(root, 'big.txt');
  const blob = 'x'.repeat(1024 * 1024);
  fs.writeFileSync(p, blob, 'utf8');
  assert.throws(() => readTextFile(p, { trustedRoot: root, maxSize: 16 }));
});

test('throws on binary-like content', () => {
  const p = path.join(root, 'bin.bin');
  fs.writeFileSync(p, Buffer.from([0x00, 0x01, 0x02, 0x03]));
  assert.throws(() => readTextFile(p, { trustedRoot: root }));
});
