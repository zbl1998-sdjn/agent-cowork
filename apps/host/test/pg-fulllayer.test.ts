import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { AddressInfo } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CachedPostgresScheduleStore } from '../src/storage/cached-pg-schedule-store.js';
import type { ScheduleListOptions, ScheduleRecord } from '../src/storage/postgres-schedule-store.js';
import { createServer, type HostServer } from '../src/server.js';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-full-'));
}

async function bind(server: HostServer): Promise<string> {
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object', 'test server should bind to a TCP port');
  const { port } = address as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

test('CachedPostgresScheduleStore hydrates from PG, serves sync, writes through', async () => {
  const saved: ScheduleRecord[] = [];
  const removed: string[] = [];
  const initialSchedule: ScheduleRecord = { id: 's1', tenantId: 't1', nextFireAt: '2026-05-24T06:00:00Z' };
  const fakePg = {
    list: async (_options: ScheduleListOptions = {}): Promise<ScheduleRecord[]> => [initialSchedule],
    get: async (id: string): Promise<ScheduleRecord | null> => (id === initialSchedule.id ? initialSchedule : null),
    save: async (record: ScheduleRecord): Promise<ScheduleRecord> => {
      saved.push(record);
      return record;
    },
    remove: async (id: string): Promise<boolean> => {
      removed.push(id);
      return true;
    },
  };
  const store = new CachedPostgresScheduleStore({ pg: fakePg });
  await store.hydrate();
  // Sync reads are served from the hydrated cache; writes update cache before async PG write-through.
  assert.equal(store.list({}).length, 1);
  assert.equal(store.get('s1')?.tenantId, 't1');
  assert.equal(store.list({ tenantId: 't2' }).length, 0, 'tenant filter');
  store.save({ id: 's2', tenantId: 't1', nextFireAt: '2026-05-25T06:00:00Z' });
  assert.ok(store.get('s2'), 'cache updated synchronously');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(saved.some((record) => record.id === 's2'), 'written through to PG');
  assert.equal(store.remove('s1'), true);
  assert.equal(store.get('s1'), null);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(removed, ['s1']);
});

test('E2E: /api/memory works with an async (Postgres-style) memory store', async () => {
  const root = tmp();
  const asyncMemory = {
    async readMainMemory(): Promise<string> { return '# 记忆\n- **部署** (project): 用 PostgreSQL\n'; },
    async listMemoryNotes(): Promise<Array<{ name: string; size: number; modifiedAt: string }>> {
      return [{ name: 'guide.md', size: 12, modifiedAt: '2026-05-23T00:00:00Z' }];
    },
    async appendMemoryFact(): Promise<{ fact: { key: string; value: string; scope: 'project' }; file: string }> {
      return { fact: { key: 'k', value: 'v', scope: 'project' }, file: 'postgres://x' };
    },
    async writeMemoryNote(): Promise<string> { return 'postgres://memory_notes/n1'; },
    async readMemoryNote(): Promise<string> { return '# 指南'; },
  };
  const server = createServer({ trustedRoot: root, enableScheduler: false, memoryStore: asyncMemory });
  const base = await bind(server);
  try {
    const response = await fetch(`${base}/api/memory`);
    assert.equal(response.status, 200);
    const body = await response.json() as { memory: { text: string; notes: Array<{ name: string }> } };
    assert.match(body.memory.text, /部署/, 'async readMainMemory awaited (not a Promise)');
    assert.equal(body.memory.notes.length, 1);
    assert.equal(body.memory.notes[0]?.name, 'guide.md');
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
});
