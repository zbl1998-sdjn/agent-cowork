import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AuditEventBus, createJsonlAuditSubscriber } from '../src/runtime/audit-events.js';

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-audit-'));
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
  const line = JSON.parse(fs.readFileSync(auditPath, 'utf8').trim());
  assert.equal(line.ts, '2026-05-21T00:00:00.000Z');
  assert.equal(line.trace_id, 'trace_test');
  assert.equal(line.tenant_id, 'tenant_test');
  assert.equal(line.user_id, 'user_test');
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
      assert.equal(error.name, 'AggregateError');
      assert.match(error.message, /AuditEventBus subscriber failed/);
      assert.equal(error.errors.length, 1);
      assert.match(error.errors[0].message, /audit sink failed/);
      return true;
    },
  );
});
