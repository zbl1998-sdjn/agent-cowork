import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { webFetch } from '../src/tools/web-fetch.js';
import { createBuiltinTools } from '../src/tools/builtin-tools.js';
import { ToolRegistry } from '../src/tools/tool-registry.js';

async function startServer(handler) {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, port: server.address().port };
}

test('webFetch retrieves a page body with status + content-type', async () => {
  const { server, port } = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('hello from fixture');
  });
  try {
    // allowInternal because the fixture is on 127.0.0.1
    const out = await webFetch({ url: `http://127.0.0.1:${port}/`, allowInternal: true });
    assert.equal(out.ok, true);
    assert.equal(out.status, 200);
    assert.match(out.contentType, /text\/plain/);
    assert.equal(out.text, 'hello from fixture');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('webFetch caps the body at maxBytes and flags truncation', async () => {
  const { server, port } = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('x'.repeat(5000));
  });
  try {
    const out = await webFetch({ url: `http://127.0.0.1:${port}/`, allowInternal: true, maxBytes: 100 });
    assert.equal(out.truncated, true);
    assert.equal(out.text.length, 100);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('webFetch rejects non-http schemes and internal hosts by default', async () => {
  await assert.rejects(() => webFetch({ url: 'file:///etc/passwd' }), /http\(s\)/);
  await assert.rejects(() => webFetch({ url: 'ftp://example.com' }), /http\(s\)/);
  await assert.rejects(() => webFetch({ url: 'http://localhost/' }), /blocked/);
  await assert.rejects(() => webFetch({ url: 'http://127.0.0.1:9/' }), /blocked/);
});

test('web.fetch is exposed as a built-in tool', async () => {
  const { server, port } = await startServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"k":1}'); });
  try {
    const registry = new ToolRegistry().registerMany(createBuiltinTools({}));
    assert.equal(registry.has('web.fetch'), true);
    assert.equal(registry.descriptor('web.fetch').requiresApproval, true);
    const res = await registry.call('web.fetch', { url: `http://127.0.0.1:${port}/`, allowInternal: true });
    assert.equal(res.status, 200);
    assert.match(res.text, /"k":1/);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
