import assert from 'node:assert/strict';
import test from 'node:test';
import { indexHostRun } from '../src/runtime/host-run-indexing.js';

test('indexHostRun summarizes records with explicit or embedded request context', () => {
  const writes: Array<{ summary: unknown; context: unknown }> = [];
  const runsIndex = {
    upsert(summary: unknown, context?: Record<string, unknown>) {
      writes.push({ summary, context });
    },
  };
  const record = {
    id: 'run_index_helper',
    status: 'succeeded',
    input: { prompt: 'index me' },
    context: { tenantId: 'tenant_embedded', userId: 'user_embedded' },
  };

  indexHostRun(runsIndex, record);
  indexHostRun(runsIndex, record, {
    tenantId: 'tenant_explicit',
    userId: 'user_explicit',
    traceId: 'trace_explicit',
  });

  assert.equal(writes.length, 2);
  const embedded = writes[0]?.summary as Record<string, unknown>;
  assert.equal(embedded.id, 'run_index_helper');
  assert.equal(embedded.tenantId, 'tenant_embedded');
  assert.equal(embedded.userId, 'user_embedded');
  assert.equal(embedded.promptPreview, 'index me');
  assert.equal(embedded.runPath, null);
  assert.deepEqual(writes[0]?.context, record.context);

  const explicit = writes[1]?.summary as Record<string, unknown>;
  assert.equal(explicit.id, 'run_index_helper');
  assert.equal(explicit.tenantId, 'tenant_explicit');
  assert.equal(explicit.userId, 'user_explicit');
  assert.equal(explicit.traceId, 'trace_explicit');
  assert.equal(explicit.promptPreview, 'index me');
  assert.equal(explicit.runPath, null);
  assert.deepEqual(writes[1]?.context, {
    tenantId: 'tenant_explicit',
    userId: 'user_explicit',
    traceId: 'trace_explicit',
  });
});

test('indexHostRun keeps synchronous index failures off the request path', () => {
  assert.doesNotThrow(() => indexHostRun({
    upsert() {
      throw new Error('index unavailable');
    },
  }, { id: 'run_index_failure' }));
});
