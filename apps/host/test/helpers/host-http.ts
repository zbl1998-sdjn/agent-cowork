import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { AddressInfo } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { HostServer } from '../../src/server.js';
import { closeTestServer } from './close-server.js';

type JsonRequestOptions = {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
};

export type JsonResponse = {
  status: number;
  body: Record<string, unknown>;
  headers: Headers;
};

export function recordValue(value: unknown, label: string): Record<string, unknown> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${label} should be an object`);
  return value as Record<string, unknown>;
}

export function recordArray(value: unknown, label: string): Array<Record<string, unknown>> {
  assert.ok(Array.isArray(value), `${label} should be an array`);
  return value.map((item, index) => recordValue(item, `${label}[${index}]`));
}

export function objectField(source: Record<string, unknown>, key: string, label = key): Record<string, unknown> {
  return recordValue(source[key], label);
}

export function arrayField(source: Record<string, unknown>, key: string, label = key): Array<Record<string, unknown>> {
  return recordArray(source[key], label);
}

export function stringValue(value: unknown, label: string): string {
  if (typeof value === 'string') return value;
  throw new TypeError(`${label} should be a string`);
}

export function stringField(source: Record<string, unknown>, key: string, label = key): string {
  return stringValue(source[key], label);
}

export function present<T>(value: T | null | undefined, label: string): T {
  assert.ok(value, `${label} should exist`);
  return value;
}

export function readableBody(response: Response, label: string): ReadableStream<Uint8Array> {
  assert.ok(response.body, `${label} should have a response body`);
  return response.body;
}

export function tempRoot(prefix = 'kcw-runtime-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export async function bind(server: HostServer): Promise<string> {
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addressInfo = server.address();
  assert.ok(addressInfo && typeof addressInfo === 'object', 'test server should bind to a TCP port');
  const { address, port } = addressInfo as AddressInfo;
  return `http://${address}:${port}`;
}

export async function close(server: HostServer): Promise<void> {
  await closeTestServer(server);
}

export async function jsonRequest(
  base: string,
  route: string,
  { method = 'GET', body, headers = {} }: JsonRequestOptions = {},
): Promise<JsonResponse> {
  const init: RequestInit = {
    method,
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
  };
  if (body != null) {
    init.body = JSON.stringify(body);
  }
  const response = await fetch(`${base}${route}`, init);
  const text = await response.text();
  let parsed: unknown = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text };
  }
  return { status: response.status, body: recordValue(parsed, `${method} ${route} response`), headers: response.headers };
}
