import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createServer } from '../src/server.js';
import { arrayField, bind, close, jsonRequest, stringField, tempRoot } from './helpers/host-http.js';

function tmp(): string {
  return tempRoot('kcw-cc-');
}

function numberField(source: Record<string, unknown>, key: string, label = key): number {
  const value = source[key];
  if (typeof value !== 'number') {
    throw new TypeError(`${label} should be a number`);
  }
  return value;
}

function booleanField(source: Record<string, unknown>, key: string, label = key): boolean {
  const value = source[key];
  if (typeof value !== 'boolean') {
    throw new TypeError(`${label} should be a boolean`);
  }
  return value;
}

function stringArrayField(source: Record<string, unknown>, key: string, label = key): string[] {
  const value = source[key];
  assert.ok(Array.isArray(value), `${label} should be an array`);
  for (const [index, item] of value.entries()) {
    assert.equal(typeof item, 'string', `${label}[${index}] should be a string`);
  }
  return value as string[];
}

test('POST /api/connectors/connect (filesystem) connects fs MCP server, tools become available', async () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'hi.txt'), 'hi', 'utf8');
  const server = createServer({ trustedRoot: root, enableScheduler: false });
  const base = await bind(server);
  try {
    const conn = await jsonRequest(base, '/api/connectors/connect', { method: 'POST', body: { id: 'filesystem', trustedRoot: root } });
    assert.equal(conn.status, 200);
    assert.ok(numberField(conn.body, 'connected') >= 1, 'imported fs tools');
    assert.ok(stringArrayField(conn.body, 'mcpServers').includes('fs'));
    const tools = await jsonRequest(base, '/api/tools');
    assert.ok(arrayField(tools.body, 'tools').some((tool) => stringField(tool, 'name') === 'mcp__fs__read_text'));
    const list = await jsonRequest(base, '/api/connectors');
    assert.ok(stringArrayField(list.body, 'connected').includes('fs'));
  } finally {
    await close(server);
  }
});

test('POST /api/connectors/disconnect revokes filesystem MCP tools', async () => {
  const root = tmp();
  const server = createServer({ trustedRoot: root, enableScheduler: false });
  const base = await bind(server);
  try {
    const conn = await jsonRequest(base, '/api/connectors/connect', { method: 'POST', body: { id: 'filesystem', trustedRoot: root } });
    assert.equal(conn.status, 200);
    assert.ok(stringArrayField(conn.body, 'mcpServers').includes('fs'));

    const out = await jsonRequest(base, '/api/connectors/disconnect', { method: 'POST', body: { id: 'filesystem' } });
    assert.equal(out.status, 200);
    assert.equal(stringField(out.body, 'name'), 'fs');
    assert.equal(booleanField(out.body, 'removed'), true);
    assert.ok(numberField(out.body, 'toolsRemoved') >= 1);
    assert.deepEqual(stringArrayField(out.body, 'mcpServers'), []);

    const tools = await jsonRequest(base, '/api/tools');
    assert.equal(arrayField(tools.body, 'tools').some((tool) => stringField(tool, 'name') === 'mcp__fs__read_text'), false);
    const list = await jsonRequest(base, '/api/connectors');
    assert.deepEqual(stringArrayField(list.body, 'connected'), []);
  } finally {
    await close(server);
  }
});

test('POST /api/connectors/disconnect rejects an unsupported connector id', async () => {
  const server = createServer({ trustedRoot: tmp(), enableScheduler: false });
  const base = await bind(server);
  try {
    const res = await jsonRequest(base, '/api/connectors/disconnect', { method: 'POST', body: { id: 'sqlite' } });
    assert.equal(res.status, 400);
    assert.match(stringField(res.body, 'error'), /unsupported connector/i);
  } finally {
    await close(server);
  }
});

test('POST /api/connectors/connect requires id or command', async () => {
  const server = createServer({ trustedRoot: tmp(), enableScheduler: false });
  const base = await bind(server);
  try {
    const res = await jsonRequest(base, '/api/connectors/connect', { method: 'POST', body: {} });
    assert.equal(res.status, 400);
  } finally {
    await close(server);
  }
});
