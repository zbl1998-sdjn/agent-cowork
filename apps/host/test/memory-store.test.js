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

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-mem-'));
}

test('readMainMemory returns empty string when MEMORY.md absent', () => {
  const root = tempRoot();
  assert.equal(readMainMemory(root), '');
});

test('appendMemoryFact bootstraps MEMORY.md and appends bullet', async () => {
  const root = tempRoot();
  const result = appendMemoryFact(
    root,
    { key: '客户简称', value: '阿里 = 阿里巴巴中国区运营' },
    { traceId: 'trace_test', tenantId: 'tenant_test', userId: 'user_test' },
  );
  assert.match(result.file, /MEMORY\.md$/);
  const body = readMainMemory(root);
  assert.match(body, /# Agent Cowork 项目记忆/);
  assert.match(body, /\*\*客户简称\*\* \(project\): 阿里 = 阿里巴巴中国区运营/);
  await flushMemoryAuditEvents(root);
  const auditLines = fs
    .readFileSync(path.join(root, '.AgentCowork', 'audit', 'memory.jsonl'), 'utf8')
    .trim()
    .split('\n');
  const event = JSON.parse(auditLines[0]);
  assert.equal(event.action, 'memory_fact_append');
  assert.equal(event.key, '客户简称');
  assert.equal(event.tenantId, 'tenant_test');
  assert.equal(event.traceId, 'trace_test');
  assert.equal(event.trace_id, 'trace_test');
});

test('appendMemoryFact rejects empty key or value and over-long value', () => {
  const root = tempRoot();
  assert.throws(() => appendMemoryFact(root, { key: '', value: 'x' }), /key is required/);
  assert.throws(() => appendMemoryFact(root, { key: 'k', value: '' }), /value is required/);
  assert.throws(
    () => appendMemoryFact(root, { key: 'k', value: 'x'.repeat(MEMORY_LIMITS.maxFactValueLength + 1) }),
    /value too long/,
  );
});

test('appendMemoryFact normalizes scope to allowed values', () => {
  const root = tempRoot();
  appendMemoryFact(root, { key: 'a', value: 'b', scope: 'INVALID' });
  appendMemoryFact(root, { key: 'c', value: 'd', scope: 'user' });
  const body = readMainMemory(root);
  assert.match(body, /\(project\): b/);
  assert.match(body, /\(user\): d/);
});

test('writeMemoryNote stores file under .AgentCowork/memory/', () => {
  const root = tempRoot();
  const file = writeMemoryNote(root, 'projects.md', '# Projects\n- A: alpha\n', {
    traceId: 't',
    tenantId: 'T',
    userId: 'U',
  });
  assert.match(file, /\.AgentCowork[\\/]memory[\\/]projects\.md$/);
  const note = readMemoryNote(root, 'projects.md');
  assert.match(note, /# Projects/);
  const notes = listMemoryNotes(root);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].name, 'projects.md');
});

test('writeMemoryNote rejects invalid note names', () => {
  const root = tempRoot();
  assert.throws(() => writeMemoryNote(root, '../escape.md', 'x'), /Invalid memory note name/);
  assert.throws(() => writeMemoryNote(root, 'foo.txt', 'x'), /Invalid memory note name/);
});

test('buildMemorySystemBlock returns empty when MEMORY.md missing', () => {
  const root = tempRoot();
  assert.equal(buildMemorySystemBlock(root), '');
});

test('buildMemorySystemBlock returns clipped text up to maxBytes', () => {
  const root = tempRoot();
  appendMemoryFact(root, { key: '客户简称', value: '阿里 = 阿里巴巴' });
  const block = buildMemorySystemBlock(root, { maxBytes: 4096 });
  assert.match(block, /客户简称/);
  assert.ok(Buffer.byteLength(block, 'utf8') <= 4096);
});

test('loadMemoryContext exposes enabled flag, bytes and notes', () => {
  const root = tempRoot();
  appendMemoryFact(root, { key: '术语', value: 'OKR = Objectives and Key Results' });
  writeMemoryNote(root, 'glossary.md', '# Glossary\nKPI = Key Performance Indicator\n');
  const ctx = loadMemoryContext(root);
  assert.equal(ctx.enabled, true);
  assert.ok(ctx.bytes > 0);
  assert.ok(ctx.text.includes('术语'));
  assert.equal(ctx.notes.length, 1);
  assert.equal(ctx.notes[0].name, 'glossary.md');
});

test('loadMemoryContext disabled when MEMORY.md absent', () => {
  const root = tempRoot();
  const ctx = loadMemoryContext(root);
  assert.equal(ctx.enabled, false);
  assert.equal(ctx.bytes, 0);
});

test('createMemoryStore keeps the default file backend compatible', () => {
  const root = tempRoot();
  const store = createMemoryStore();
  assert.ok(store instanceof FileMemoryStore);
  store.appendMemoryFact(root, { key: '默认后端', value: 'file memory store' });
  assert.match(store.readMainMemory(root), /默认后端/);
});
