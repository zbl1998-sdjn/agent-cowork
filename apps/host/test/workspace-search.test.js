import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from '../src/server.js';
import { createBuiltinTools } from '../src/tools/builtin-tools.js';
import { ToolRegistry } from '../src/tools/tool-registry.js';
import { makeTestWorkspace } from './test-fixtures.js';

async function withServer(config, fn) {
  const server = createServer({ requireAuth: false, ...config });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    await fn(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('workspace search route returns chunks with source line references', async () => {
  const trustedRoot = makeTestWorkspace('workspace-search');
  const doc = path.join(trustedRoot, 'notes.md');
  fs.writeFileSync(doc, 'Intro\nLocal RAG cites sources\nDone\n', 'utf8');
  fs.writeFileSync(path.join(trustedRoot, '.npmrc'), 'rag sources secret token\n', 'utf8');

  await withServer({ trustedRoot }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/workspace/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ trustedRoot, query: 'rag sources', limit: 3, maxChunkLines: 1 }),
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.query, 'rag sources');
    assert.ok(body.indexedFiles >= 1);
    assert.equal(body.chunks.length, 1);
    assert.equal(body.sources[0].relativePath, 'notes.md');
    assert.equal(body.sources[0].startLine, 2);
    assert.equal(body.sources[0].endLine, 2);
    assert.match(body.sources[0].excerpt, /Local RAG cites sources/);
  });
});

test('workspace search route validates required query and sanitizes optional fields', async () => {
  const trustedRoot = makeTestWorkspace('workspace-search-validation');
  fs.writeFileSync(path.join(trustedRoot, 'notes.md'), 'Validation route keeps search inputs bounded\n', 'utf8');

  await withServer({ trustedRoot }, async (baseUrl) => {
    const invalid = await fetch(`${baseUrl}/api/workspace/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: ['validation'] }),
    });
    assert.equal(invalid.status, 400);

    const response = await fetch(`${baseUrl}/api/workspace/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        trustedRoot: ['not-a-root'],
        query: 'validation',
        limit: '1',
        maxFiles: 'bad-limit',
        maxChunkLines: '1',
      }),
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.root, trustedRoot);
    assert.equal(body.sources.length, 1);
    assert.equal(body.sources[0].relativePath, 'notes.md');
  });
});

test('SearchWorkspace builtin tool is read-only and jailed to the trusted root', async () => {
  const trustedRoot = makeTestWorkspace('workspace-search-tool');
  fs.writeFileSync(path.join(trustedRoot, 'guide.md'), 'Alpha project glossary lives here\n', 'utf8');
  const registry = new ToolRegistry().registerMany(createBuiltinTools({ sandbox: null }));

  assert.equal(registry.has('SearchWorkspace'), true);
  const result = await registry.call('SearchWorkspace', { query: 'glossary', limit: 2 }, { trustedRoot });

  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].relativePath, 'guide.md');
});
