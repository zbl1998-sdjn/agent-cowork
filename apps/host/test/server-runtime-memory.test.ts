import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { flushMemoryAuditEvents } from '../src/memory/memory-store.js';
import { createServer } from '../src/server.js';
import {
  bind,
  close,
  jsonRequest,
  objectField,
  recordValue,
  stringField,
  tempRoot,
} from './helpers/host-http.js';

test('memory routes: append fact, list notes, read back, inject in workspace info', async () => {
  const trustedRoot = tempRoot();
  const server = createServer({ trustedRoot, enableScheduler: false });
  const base = await bind(server);
  try {
    const empty = await jsonRequest(base, '/api/memory');
    assert.equal(empty.status, 200);
    const emptyMemory = objectField(empty.body, 'memory', 'empty memory state');
    assert.equal(emptyMemory.enabled, false);

    const factResp = await jsonRequest(base, '/api/memory/facts', {
      method: 'POST',
      headers: {
        'x-tenant-id': 'tenant_alice',
        'x-user-id': 'user_alice',
        'x-trace-id': 'trace_memory_route',
        'idempotency-key': 'k1',
      },
      body: { key: '客户简称', value: '阿里 = 阿里巴巴中国区运营' },
    });
    assert.equal(factResp.status, 200);
    const fact = objectField(factResp.body, 'fact', 'memory fact');
    assert.equal(fact.key, '客户简称');

    const filled = await jsonRequest(base, '/api/memory');
    assert.equal(filled.status, 200);
    const filledMemory = objectField(filled.body, 'memory', 'filled memory state');
    assert.equal(filledMemory.enabled, true);
    assert.ok(stringField(filledMemory, 'text', 'memory text').includes('客户简称'));

    const noteResp = await jsonRequest(base, '/api/memory/notes', {
      method: 'POST',
      body: { name: 'projects.md', body: '# Projects\n- Alpha: launched\n' },
    });
    assert.equal(noteResp.status, 200);

    const noteRead = await jsonRequest(base, '/api/memory/notes/projects.md');
    assert.equal(noteRead.status, 200);
    const note = objectField(noteRead.body, 'note', 'memory note');
    assert.ok(stringField(note, 'body', 'memory note body').includes('Alpha'));

    const audit = path.join(trustedRoot, '.AgentCowork', 'audit', 'memory.jsonl');
    await flushMemoryAuditEvents(trustedRoot);
    assert.ok(fs.existsSync(audit), 'memory audit JSONL must exist');
    const auditLines = fs.readFileSync(audit, 'utf8').trim().split('\n')
      .map((line) => recordValue(JSON.parse(line) as unknown, 'memory audit line'));
    assert.ok(auditLines.some((line) => line.trace_id === 'trace_memory_route'), 'audit line must include trace_id');
  } finally {
    await close(server);
  }
});

test('memory routes reject invalid input', async () => {
  const trustedRoot = tempRoot();
  const server = createServer({ trustedRoot, enableScheduler: false });
  const base = await bind(server);
  try {
    const badFact = await jsonRequest(base, '/api/memory/facts', {
      method: 'POST',
      body: { key: '', value: 'x' },
    });
    assert.equal(badFact.status, 400);
    assert.match(String(badFact.body.error), /key is required/);

    const malformedFact = await jsonRequest(base, '/api/memory/facts', {
      method: 'POST',
      body: { key: ['not-valid'], value: 'x' },
    });
    assert.equal(malformedFact.status, 400);

    const badNote = await jsonRequest(base, '/api/memory/notes', {
      method: 'POST',
      body: { name: '../escape.md', body: 'x' },
    });
    assert.equal(badNote.status, 400);
    assert.match(String(badNote.body.error), /Invalid memory note name/);

    const malformedNote = await jsonRequest(base, '/api/memory/notes', {
      method: 'POST',
      body: { name: 'projects.md', body: ['not-valid'] },
    });
    assert.equal(malformedNote.status, 400);

    const missing = await jsonRequest(base, '/api/memory/notes/missing.md');
    assert.equal(missing.status, 404);
  } finally {
    await close(server);
  }
});
