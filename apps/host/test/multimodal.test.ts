import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { AddressInfo } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildAttachmentContext } from '../src/workspace/attachment-context.js';
import { createServer } from '../src/server.js';
import { closeTestServer } from './helpers/close-server.js';
import type { HostServer } from '../src/server.js';

type JsonRequestOptions = {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
};

type JsonResponse = {
  status: number;
  body: unknown;
};

function seed(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-mm-'));
  fs.writeFileSync(path.join(root, 'note.txt'), '这是附件正文内容', 'utf8');
  return root;
}

function present<T>(value: T | null | undefined, label: string): T {
  assert.ok(value, `${label} should exist`);
  return value;
}

function recordValue(value: unknown, label: string): Record<string, unknown> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${label} should be an object`);
  return value as Record<string, unknown>;
}

function recordArray(value: unknown, label: string): Array<Record<string, unknown>> {
  assert.ok(Array.isArray(value), `${label} should be an array`);
  return value.map((item, index) => recordValue(item, `${label}[${index}]`));
}

async function bind(server: HostServer): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  assert.ok(address && typeof address === 'object', 'test server should bind to a TCP port');
  return `http://127.0.0.1:${(address as AddressInfo).port}`;
}

async function jsonRequest(base: string, route: string, options: JsonRequestOptions = {}): Promise<JsonResponse> {
  const init: RequestInit = {
    method: options.method || 'GET',
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
  };
  if (options.body !== undefined) {
    init.body = JSON.stringify(options.body);
  }
  const response = await fetch(`${base}${route}`, init);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) as unknown : null };
}

test('buildAttachmentContext extracts text and tags images', () => {
  const root = seed();
  const out = buildAttachmentContext({
    files: [path.join(root, 'note.txt'), { path: path.join(root, 'pic.png') }],
    trustedRoot: root,
  });
  assert.equal(out.items.length, 2);
  const textItem = out.items.find((i) => i.excerpt);
  assert.match(present(textItem?.excerpt, 'text attachment excerpt'), /附件正文/);
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
    const res = await jsonRequest(base, '/api/attachments/context', { method: 'POST', body: { trustedRoot: root, files: [path.join(root, 'note.txt')] } });
    assert.equal(res.status, 200);
    const body = recordValue(res.body, 'attachment response body');
    assert.equal(recordValue(body.counts, 'attachment counts').texts, 1);
    const items = recordArray(body.items, 'attachment items');
    assert.match(String(present(items[0], 'first attachment item').excerpt), /附件正文/);
  } finally {
    await closeTestServer(server);
  }
});
