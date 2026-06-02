import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { AddressInfo } from 'node:http';
import path from 'node:path';
import { createServer } from '../src/server.js';
import { createBuiltinTools } from '../src/tools/builtin-tools.js';
import { ToolRegistry } from '../src/tools/tool-registry.js';
import { makeTestWorkspace } from './test-fixtures.js';
import { closeTestServer } from './helpers/close-server.js';
import type { ServerConfig } from '../src/server.js';

function recordValue(value: unknown, label: string): Record<string, unknown> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${label} should be an object`);
  return value as Record<string, unknown>;
}

function recordArray(value: unknown, label: string): Array<Record<string, unknown>> {
  assert.ok(Array.isArray(value), `${label} should be an array`);
  return value.map((item, index) => recordValue(item, `${label}[${index}]`));
}

function present<T>(value: T | null | undefined, label: string): T {
  assert.ok(value, `${label} should exist`);
  return value;
}

async function withServer(config: Partial<ServerConfig>, fn: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = createServer({ requireAuth: false, ...config });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  assert.ok(address && typeof address === 'object', 'test server should bind to a TCP port');
  const baseUrl = `http://127.0.0.1:${(address as AddressInfo).port}`;
  try {
    await fn(baseUrl);
  } finally {
    await closeTestServer(server);
  }
}

test('workspace search route returns chunks with source line references', async () => {
  const trustedRoot = makeTestWorkspace('workspace-search');
  const doc = path.join(trustedRoot, 'notes.md');
  fs.writeFileSync(doc, 'Intro\nLocal RAG cites sources\nDone\n', 'utf8');
  fs.writeFileSync(path.join(trustedRoot, '.npmrc'), 'rag sources secret token\n', 'utf8');

  await withServer({ trustedRoot }, async (baseUrl: string) => {
    const response = await fetch(`${baseUrl}/api/workspace/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ trustedRoot, query: 'rag sources', limit: 3, maxChunkLines: 1 }),
    });

    assert.equal(response.status, 200);
    const body = recordValue(await response.json(), 'workspace search response');
    assert.equal(body.query, 'rag sources');
    assert.ok(Number(body.indexedFiles) >= 1);
    assert.equal(recordArray(body.chunks, 'search chunks').length, 1);
    const firstSource = present(recordArray(body.sources, 'search sources')[0], 'first search source');
    assert.equal(firstSource.relativePath, 'notes.md');
    assert.equal(firstSource.startLine, 2);
    assert.equal(firstSource.endLine, 2);
    assert.match(String(firstSource.excerpt), /Local RAG cites sources/);
  });
});

test('workspace search route validates required query and sanitizes optional fields', async () => {
  const trustedRoot = makeTestWorkspace('workspace-search-validation');
  fs.writeFileSync(path.join(trustedRoot, 'notes.md'), 'Validation route keeps search inputs bounded\n', 'utf8');

  await withServer({ trustedRoot }, async (baseUrl: string) => {
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
    const body = recordValue(await response.json(), 'workspace search validation response');
    assert.equal(body.root, trustedRoot);
    const sources = recordArray(body.sources, 'validation search sources');
    assert.equal(sources.length, 1);
    assert.equal(present(sources[0], 'first validation source').relativePath, 'notes.md');
  });
});

test('SearchWorkspace builtin tool is read-only and jailed to the trusted root', async () => {
  const trustedRoot = makeTestWorkspace('workspace-search-tool');
  fs.writeFileSync(path.join(trustedRoot, 'guide.md'), 'Alpha project glossary lives here\n', 'utf8');
  const registry = new ToolRegistry().registerMany(createBuiltinTools({ sandbox: null }));

  assert.equal(registry.has('SearchWorkspace'), true);
  const result = await registry.call('SearchWorkspace', { query: 'glossary', limit: 2 }, { trustedRoot });

  const resultRecord = recordValue(result, 'SearchWorkspace result');
  const sources = recordArray(resultRecord.sources, 'SearchWorkspace sources');
  assert.equal(sources.length, 1);
  assert.equal(present(sources[0], 'first SearchWorkspace source').relativePath, 'guide.md');
});
