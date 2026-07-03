import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AuditEventBus, createJsonlAuditSubscriber, verifyAuditHashChain } from '../src/runtime/audit-events.js';

type JsonRecord = Record<string, unknown>;

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-audit-'));
}

function requireJsonRecord(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be a JSON object`);
  }
  return value as JsonRecord;
}

test('AuditEventBus writes structured JSONL asynchronously with trace_id', async () => {
  const root = tempRoot();
  const auditPath = path.join(root, 'audit.jsonl');
  const bus = new AuditEventBus({
    now: () => new Date('2026-05-21T00:00:00Z'),
  });
  bus.subscribe(createJsonlAuditSubscriber(auditPath));

  const event = bus.publish({
    action: 'memory_fact_append',
    traceId: 'trace_test',
    tenantId: 'tenant_test',
    userId: 'user_test',
  });
  assert.equal(event.trace_id, 'trace_test');
  assert.equal(fs.existsSync(auditPath), false, 'subscriber should not run inline');

  await bus.flush();
  const line = requireJsonRecord(JSON.parse(fs.readFileSync(auditPath, 'utf8').trim()), 'audit line');
  assert.equal(line.ts, '2026-05-21T00:00:00.000Z');
  assert.equal(line.trace_id, 'trace_test');
  assert.equal(line.tenant_id, 'tenant_test');
  assert.equal(line.user_id, 'user_test');
  assert.equal(line.chain_version, 1);
  assert.equal(line.hash_algorithm, 'sha256');
  assert.equal(line.prev_hash, null);
  assert.equal(typeof line.event_hash, 'string');
  assert.equal(verifyAuditHashChain([line]).ok, true);
});

test('Audit JSONL subscriber creates a tamper-evident hash chain', async () => {
  const root = tempRoot();
  const auditPath = path.join(root, 'audit.jsonl');
  const bus = new AuditEventBus({
    now: () => new Date('2026-07-02T00:00:00Z'),
  });
  bus.subscribe(createJsonlAuditSubscriber(auditPath));

  bus.publish({ action: 'policy.decision', tool: 'WebFetch', decision: 'deny' });
  bus.publish({ action: 'tool.rejected', tool: 'Shell', risk: 'high' });
  await bus.flush();

  const records = fs.readFileSync(auditPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as JsonRecord);
  assert.equal(records.length, 2);
  assert.equal(records[1]?.prev_hash, records[0]?.event_hash);
  assert.deepEqual(verifyAuditHashChain(records), { ok: true, checked: 2 });

  const tampered = records.map((record) => ({ ...record }));
  const firstTampered = tampered[0];
  assert.ok(firstTampered);
  firstTampered.decision = 'allow';
  assert.deepEqual(verifyAuditHashChain(tampered), {
    ok: false,
    checked: 0,
    failureIndex: 0,
    reason: 'event_hash mismatch',
  });
});

test('AuditEventBus flush reports subscriber failures', async () => {
  const bus = new AuditEventBus();
  bus.subscribe(() => {
    throw new Error('audit sink failed');
  });

  bus.publish({ action: 'will_fail', traceId: 'trace_fail' });

  await assert.rejects(
    () => bus.flush(),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.name, 'AggregateError');
      assert.match(error.message, /AuditEventBus subscriber failed/);
      assert.equal(error.errors.length, 1);
      const [firstError] = error.errors as unknown[];
      assert.ok(firstError instanceof Error);
      assert.match(firstError.message, /audit sink failed/);
      return true;
    },
  );
});
