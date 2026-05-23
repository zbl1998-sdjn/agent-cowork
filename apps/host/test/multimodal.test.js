import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildAttachmentContext } from '../src/workspace/attachment-context.js';
import { createServer } from '../src/server.js';

function seed() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-mm-'));
  fs.writeFileSync(path.join(root, 'note.txt'), '这是附件正文内容', 'utf8');
  return root;
}
async function bind(s) { await new Promise((r) => s.listen(0, '127.0.0.1', r)); return `http://127.0.0.1:${s.address().port}`; }
async function J(base, route, opt = {}) {
  const res = await fetch(`${base}${route}`, { method: opt.method || 'GET', headers: { 'content-type': 'application/json', ...(opt.headers || {}) }, body: opt.body ? JSON.stringify(opt.body) : undefined });
  const t = await res.text(); return { status: res.status, body: t ? JSON.parse(t) : null };
}

test('buildAttachmentContext extracts text and tags images', () => {
  const root = seed();
  const out = buildAttachmentContext({
    files: [path.join(root, 'note.txt'), { path: path.join(root, 'pic.png') }],
    trustedRoot: root,
  });
  assert.equal(out.items.length, 2);
  const textItem = out.items.find((i) => i.excerpt);
  assert.match(textItem.excerpt, /附件正文/);
  const img = out.items.find((i) => i.kind === 'image');
  assert.ok(img && img.ext === '.png');
  assert.equal(out.counts.images, 1);
  assert.equal(out.counts.texts, 1);
});

test('POST /api/attachments/context returns extracted attachment context', async () => {
  const root = seed();
  const server = createServer({ trustedRoot: root, enableScheduler: false });
  const base = await bind(server);
  try {
    const res = await J(base, '/api/attachments/context', { method: 'POST', body: { trustedRoot: root, files: [path.join(root, 'note.txt')] } });
    assert.equal(res.status, 200);
    assert.equal(res.body.counts.texts, 1);
    assert.match(res.body.items[0].excerpt, /附件正文/);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
