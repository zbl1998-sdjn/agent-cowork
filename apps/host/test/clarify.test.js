import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createClarificationStore } from '../src/runtime/clarifications.js';
import { createServer } from '../src/server.js';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-clr-')); }
async function bind(s) { await new Promise((r) => s.listen(0, '127.0.0.1', r)); return `http://127.0.0.1:${s.address().port}`; }
async function J(base, route, opt = {}) {
  const res = await fetch(`${base}${route}`, { method: opt.method || 'GET', headers: { 'content-type': 'application/json', ...(opt.headers || {}) }, body: opt.body ? JSON.stringify(opt.body) : undefined });
  const t = await res.text(); return { status: res.status, body: t ? JSON.parse(t) : null };
}

test('clarification store normalizes options and answers', () => {
  const store = createClarificationStore();
  const q = store.create({ question: '选哪个格式?', options: ['Word', { label: 'PDF', description: '便携' }] });
  assert.match(q.id, /^clr_/);
  assert.equal(q.options.length, 2);
  assert.equal(q.options[0].label, 'Word');
  assert.equal(q.options[1].description, '便携');
  assert.equal(q.status, 'pending');
  const a = store.answer(q.id, 'PDF');
  assert.equal(a.status, 'answered');
  assert.equal(a.answer, 'PDF');
  assert.throws(() => store.create({ question: '' }), (e) => { assert.equal(e.statusCode, 400); return true; });
  assert.throws(() => store.answer('ghost', 'x'), (e) => { assert.equal(e.statusCode, 404); return true; });
});

test('clarify routes: create -> get -> answer round-trip', async () => {
  const server = createServer({ trustedRoot: tmp(), enableScheduler: false });
  const base = await bind(server);
  try {
    const created = await J(base, '/api/clarify', { method: 'POST', body: { question: '导出哪种?', options: ['xlsx', 'csv'] } });
    assert.equal(created.status, 200);
    const id = created.body.clarification.id;
    const got = await J(base, `/api/clarify/${id}`);
    assert.equal(got.body.clarification.status, 'pending');
    const answered = await J(base, `/api/clarify/${id}/answer`, { method: 'POST', body: { value: 'csv' } });
    assert.equal(answered.body.clarification.status, 'answered');
    assert.equal(answered.body.clarification.answer, 'csv');
    const missing = await J(base, '/api/clarify/clr_missing');
    assert.equal(missing.status, 404);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
