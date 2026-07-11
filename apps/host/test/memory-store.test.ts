import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  appendMemoryFact,
  buildMemorySystemBlock,
  createMemoryStore,
  FileMemoryStore,
  listMemoryNotes,
  loadMemoryContext,
  readMainMemory,
  readMemoryNote,
  writeMemoryNote,
  flushMemoryAuditEvents,
  MEMORY_LIMITS,
} from '../src/memory/memory-store.js';
import {
  buildMemorySystemBlockFromStore,
  buildMemorySystemBlockFromText,
  loadMemoryContextFromStore,
  type SyncMemoryStoreLike,
} from '../src/memory/memory-query.js';

type JsonRecord = Record<string, unknown>;
const owner = { tenantId: 'tenant_test', userId: 'user_test' };

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-mem-'));
}

function requireJsonRecord(value: unknown, label: string): JsonRecord {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${label} should be an object`);
  return value as JsonRecord;
}

function requireText(value: string | null, label: string): string {
  assert.ok(value, `${label} should exist`);
  return value;
}

test('readMainMemory returns empty string when MEMORY.md absent', () => {
  const root = tempRoot();
  assert.equal(readMainMemory(root, owner), '');
});

test('appendMemoryFact bootstraps MEMORY.md and appends bullet', async () => {
  const root = tempRoot();
  const result = appendMemoryFact(
    root,
    { key: '客户简称', value: '阿里 = 阿里巴巴中国区运营' },
    { traceId: 'trace_test', tenantId: 'tenant_test', userId: 'user_test' },
  );
  assert.match(result.file, /MEMORY\.md$/);
  const body = readMainMemory(root, owner);
  assert.match(body, /# Agent Cowork 项目记忆/);
  assert.match(body, /\*\*客户简称\*\* \(project\): 阿里 = 阿里巴巴中国区运营/);
  await flushMemoryAuditEvents(root);
  const auditLines = fs
    .readFileSync(path.join(root, '.AgentCowork', 'audit', 'memory.jsonl'), 'utf8')
    .trim()
    .split('\n');
  const [auditLine] = auditLines;
  assert.ok(auditLine);
  const event = requireJsonRecord(JSON.parse(auditLine), 'memory audit event');
  assert.equal(event.action, 'memory_fact_append');
  assert.equal(event.key, '客户简称');
  assert.equal(event.tenantId, 'tenant_test');
  assert.equal(event.traceId, 'trace_test');
  assert.equal(event.trace_id, 'trace_test');
});

test('appendMemoryFact rejects empty key or value and over-long value', () => {
  const root = tempRoot();
  assert.throws(() => appendMemoryFact(root, { key: '', value: 'x' }, owner), /key is required/);
  assert.throws(() => appendMemoryFact(root, { key: 'k', value: '' }, owner), /value is required/);
  assert.throws(
    () => appendMemoryFact(root, { key: 'k', value: 'x'.repeat(MEMORY_LIMITS.maxFactValueLength + 1) }, owner),
    /value too long/,
  );
});

test('appendMemoryFact normalizes scope to allowed values', () => {
  const root = tempRoot();
  appendMemoryFact(root, { key: 'a', value: 'b', scope: 'INVALID' }, owner);
  appendMemoryFact(root, { key: 'c', value: 'd', scope: 'user' }, owner);
  const body = readMainMemory(root, owner);
  assert.match(body, /\(project\): b/);
  assert.match(body, /\(user\): d/);
});

test('writeMemoryNote stores file under the hashed owner namespace', () => {
  const root = tempRoot();
  const file = writeMemoryNote(root, 'projects.md', '# Projects\n- A: alpha\n', {
    ...owner,
    traceId: 't',
  });
  assert.match(file, /\.AgentCowork[\\/]owners[\\/]v1-[a-f0-9]{64}[\\/]notes[\\/]projects\.md$/);
  const note = requireText(readMemoryNote(root, 'projects.md', owner), 'projects memory note');
  assert.match(note, /# Projects/);
  const notes = listMemoryNotes(root, owner);
  assert.equal(notes.length, 1);
  const [firstNote] = notes;
  assert.ok(firstNote);
  assert.equal(firstNote.name, 'projects.md');
});

test('writeMemoryNote rejects invalid note names', () => {
  const root = tempRoot();
  assert.throws(() => writeMemoryNote(root, '../escape.md', 'x'), /Invalid memory note name/);
  assert.throws(() => writeMemoryNote(root, 'foo.txt', 'x'), /Invalid memory note name/);
});

test('buildMemorySystemBlock returns empty when MEMORY.md missing', () => {
  const root = tempRoot();
  assert.equal(buildMemorySystemBlock(root, { context: owner }), '');
});

test('buildMemorySystemBlock returns clipped text up to maxBytes', () => {
  const root = tempRoot();
  appendMemoryFact(root, { key: '客户简称', value: '阿里 = 阿里巴巴' }, owner);
  const block = buildMemorySystemBlock(root, { maxBytes: 4096, context: owner });
  assert.match(block, /客户简称/);
  assert.ok(Buffer.byteLength(block, 'utf8') <= 4096);
});

test('loadMemoryContext exposes enabled flag, bytes and notes', () => {
  const root = tempRoot();
  appendMemoryFact(root, { key: '术语', value: 'OKR = Objectives and Key Results' }, owner);
  writeMemoryNote(root, 'glossary.md', '# Glossary\nKPI = Key Performance Indicator\n', owner);
  const ctx = loadMemoryContext(root, { context: owner });
  assert.equal(ctx.enabled, true);
  assert.ok(ctx.bytes > 0);
  assert.ok(ctx.text.includes('术语'));
  assert.equal(ctx.notes.length, 1);
  const [firstNote] = ctx.notes;
  assert.ok(firstNote);
  assert.equal(firstNote.name, 'glossary.md');
});

test('loadMemoryContext disabled when MEMORY.md absent', () => {
  const root = tempRoot();
  const ctx = loadMemoryContext(root, { context: owner });
  assert.equal(ctx.enabled, false);
  assert.equal(ctx.bytes, 0);
});

test('createMemoryStore keeps the default file backend compatible', () => {
  const root = tempRoot();
  const store = createMemoryStore();
  assert.ok(store instanceof FileMemoryStore);
  store.appendMemoryFact(root, { key: '默认后端', value: 'file memory store' }, owner);
  assert.match(store.readMainMemory(root, owner), /默认后端/);
});

test('memory query helpers trim, clamp, and fail closed across stores', () => {
  assert.equal(buildMemorySystemBlockFromText('   '), '');
  const clipped = buildMemorySystemBlockFromText(`  ${'x'.repeat(700)}`, { maxBytes: 16 });
  assert.ok(Buffer.byteLength(clipped, 'utf8') <= 512);
  assert.match(clipped, /^x+$/);

  const failingStore: SyncMemoryStoreLike = {
    readMainMemory() {
      throw new Error('memory backend unavailable');
    },
    buildMemorySystemBlock() {
      return 'unused';
    },
    listMemoryNotes() {
      return [];
    },
  };

  assert.equal(buildMemorySystemBlockFromStore(failingStore, tempRoot()), '');
});

test('memory query context summary forwards context and hides note paths', () => {
  const root = tempRoot();
  const calls: Array<{ kind: string; context?: Record<string, unknown> | undefined; maxBytes?: number | undefined }> = [];
  const store: SyncMemoryStoreLike = {
    readMainMemory(_trustedRoot, context = {}) {
      calls.push({ kind: 'read', context });
      return `tenant=${context.tenantId || 'none'}`;
    },
    buildMemorySystemBlock(_trustedRoot, options = {}) {
      calls.push({ kind: 'block', context: options.context, maxBytes: options.maxBytes });
      return `marker=${options.context?.marker || ''}`;
    },
    listMemoryNotes(_trustedRoot, context = {}) {
      calls.push({ kind: 'notes', context });
      return [{ name: 'projects.md', size: 9, modifiedAt: '2026-06-19T00:00:00.000Z', path: 'internal/path' }];
    },
  };

  const block = buildMemorySystemBlockFromStore(store, root, { maxBytes: 2048, context: { tenantId: 'tenant_a' } });
  assert.equal(block, 'tenant=tenant_a');

  const summary = loadMemoryContextFromStore(store, root, { maxBytes: 1234, context: { tenantId: 'tenant_a', marker: 'm1' } });
  assert.deepEqual(summary, {
    enabled: true,
    bytes: Buffer.byteLength('marker=m1', 'utf8'),
    text: 'marker=m1',
    notes: [{ name: 'projects.md', size: 9, modifiedAt: '2026-06-19T00:00:00.000Z' }],
  });
  assert.deepEqual(calls.map((call) => call.kind), ['read', 'block', 'notes']);
  assert.equal(calls[1]?.maxBytes, 1234);
  assert.equal(calls[2]?.context?.tenantId, 'tenant_a');
});
