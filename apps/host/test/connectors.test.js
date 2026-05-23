import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { listConnectors, suggestConnectors } from '../src/connectors/catalog.js';
import { createServer } from '../src/server.js';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-conn-')); }
async function bind(s) { await new Promise((r) => s.listen(0, '127.0.0.1', r)); return `http://127.0.0.1:${s.address().port}`; }
async function J(base, route) { const res = await fetch(`${base}${route}`); const t = await res.text(); return { status: res.status, body: t ? JSON.parse(t) : null }; }

test('connector catalog lists and keyword-suggests', () => {
  assert.ok(listConnectors().length >= 5);
  const sqlite = suggestConnectors('数据库 sql');
  assert.ok(sqlite.some((c) => c.id === 'sqlite' || c.id === 'postgres'));
  const web = suggestConnectors('抓取网页');
  assert.ok(web.some((c) => c.id === 'web-fetch'));
  assert.ok(suggestConnectors('').length >= 1);
});

test('GET /api/connectors + /api/connectors/suggest', async () => {
  const server = createServer({ trustedRoot: tmp(), enableScheduler: false });
  const base = await bind(server);
  try {
    const all = await J(base, '/api/connectors');
    assert.equal(all.status, 200);
    assert.ok(all.body.connectors.length >= 5);
    const sug = await J(base, '/api/connectors/suggest?q=git');
    assert.equal(sug.body.query, 'git');
    assert.ok(sug.body.connectors.some((c) => c.id === 'git'));
  } finally {
    await new Promise((r) => server.close(r));
  }
});
