import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { AddressInfo } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createClarificationStore } from '../src/runtime/clarifications.js';
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

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-clr-'));
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

function responseBody(response: JsonResponse, label: string): Record<string, unknown> {
  return recordValue(response.body, label);
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
  const res = await fetch(`${base}${route}`, init);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) as unknown : null };
}

test('clarification store normalizes options and answers', () => {
  const store = createClarificationStore();
  const q = store.create({ question: '选哪个格式?', options: ['Word', { label: 'PDF', description: '便携' }] });
  assert.match(q.id, /^clr_/);
  assert.equal(q.options.length, 2);
  assert.equal(present(q.options[0], 'first clarification option').label, 'Word');
  assert.equal(present(q.options[1], 'second clarification option').description, '便携');
  assert.equal(q.status, 'pending');
  const a = store.answer(q.id, 'PDF');
  assert.equal(a.status, 'answered');
  assert.equal(a.answer, 'PDF');
  assert.throws(() => store.create({ question: '' }), (error) => {
    assert.equal(recordValue(error, 'empty question error').statusCode, 400);
    return true;
  });
  assert.throws(() => store.answer('ghost', 'x'), (error) => {
    assert.equal(recordValue(error, 'missing clarification error').statusCode, 404);
    return true;
  });
});

test('clarify routes: create -> get -> answer round-trip', async () => {
  const server = createServer({ trustedRoot: tempRoot(), enableScheduler: false });
  const base = await bind(server);
  try {
    const created = await jsonRequest(base, '/api/clarify', { method: 'POST', body: { question: '导出哪种?', options: ['xlsx', 'csv'] } });
    assert.equal(created.status, 200);
    const createdClarification = recordValue(responseBody(created, 'created clarification response').clarification, 'created clarification');
    const id = String(createdClarification.id);
    const got = await jsonRequest(base, `/api/clarify/${id}`);
    assert.equal(recordValue(responseBody(got, 'loaded clarification response').clarification, 'loaded clarification').status, 'pending');
    const answered = await jsonRequest(base, `/api/clarify/${id}/answer`, { method: 'POST', body: { value: 'csv' } });
    const answeredClarification = recordValue(responseBody(answered, 'answered clarification response').clarification, 'answered clarification');
    assert.equal(answeredClarification.status, 'answered');
    assert.equal(answeredClarification.answer, 'csv');
    const missing = await jsonRequest(base, '/api/clarify/clr_missing');
    assert.equal(missing.status, 404);

    const invalid = await jsonRequest(base, '/api/clarify', { method: 'POST', body: { question: ['bad'], options: ['x'] } });
    assert.equal(invalid.status, 400);

    const nonArrayOptions = await jsonRequest(base, '/api/clarify', { method: 'POST', body: { question: '继续吗?', options: 'yes' } });
    assert.equal(nonArrayOptions.status, 200);
    const normalizedClarification = recordValue(responseBody(nonArrayOptions, 'normalized clarification response').clarification, 'normalized clarification');
    assert.deepEqual(recordArray(normalizedClarification.options, 'normalized options'), []);

    const manyOptions = await jsonRequest(base, '/api/clarify', {
      method: 'POST',
      body: { question: '选项过多时?', options: Array.from({ length: 10 }, (_, i) => `选项${i + 1}`) },
    });
    assert.equal(manyOptions.status, 200);
    const manyClarification = recordValue(responseBody(manyOptions, 'many-options clarification response').clarification, 'many-options clarification');
    assert.equal(recordArray(manyClarification.options, 'many options').length, 8);
  } finally {
    await closeTestServer(server);
  }
});
