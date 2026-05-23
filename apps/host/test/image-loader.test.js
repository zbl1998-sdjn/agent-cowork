import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadImageContentParts, isImagePath } from '../src/workspace/image-loader.js';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-img-')); }

test('isImagePath recognizes common image extensions', () => {
  assert.equal(isImagePath('x.png'), true);
  assert.equal(isImagePath('photo.JPG'), true);
  assert.equal(isImagePath('doc.txt'), false);
  assert.equal(isImagePath(''), false);
});

test('loadImageContentParts encodes images, skips non-images and jail escapes', () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'a.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]));
  fs.writeFileSync(path.join(root, 'note.txt'), 'hi');
  const parts = loadImageContentParts({ trustedRoot: root, paths: ['a.png', 'note.txt', '../../etc/x.png'] });
  assert.equal(parts.length, 1, 'only the real in-root image');
  assert.equal(parts[0].type, 'image_url');
  assert.match(parts[0].image_url.url, /^data:image\/png;base64,/);
});

test('loadImageContentParts caps the number of images', () => {
  const root = tmp();
  for (let i = 0; i < 10; i += 1) fs.writeFileSync(path.join(root, `i${i}.png`), Buffer.from([0x89, 0x50]));
  const parts = loadImageContentParts({ trustedRoot: root, paths: Array.from({ length: 10 }, (_, i) => `i${i}.png`), maxImages: 3 });
  assert.equal(parts.length, 3);
});
