import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createClarificationStore } from '../src/runtime/clarifications.js';
import { FileScheduleStore } from '../src/runtime/scheduler.js';
import { createServer } from '../src/server.js';
import {
  arrayField,
  bind,
  close,
  jsonRequest,
  objectField,
  stringField,
  tempRoot,
} from './helpers/host-http.js';

const TENANT_ID = 'tenant_shared';
const USER_A = 'user_a';
const USER_B = 'user_b';

function identityHeaders(userId: string): Record<string, string> {
  return { 'x-tenant-id': TENANT_ID, 'x-user-id': userId };
}

test('schedules reject same-tenant sibling list, query override, cancel, delete, and manual tick', async () => {
  const trustedRoot = tempRoot('kcw-schedule-owner-');
  const fired: string[] = [];
  const server = createServer({
    trustedRoot,
    scheduleStore: new FileScheduleStore({
      storeDir: path.join(trustedRoot, '.AgentCowork', 'schedules'),
    }),
    requireAuth: false,
    trustIdentityHeaders: true,
    enableScheduler: true,
    startScheduler: false,
    scheduleExecutor: async (record) => {
      fired.push(record.id);
      return { runId: `run_${record.id}` };
    },
  });
  const base = await bind(server);
  try {
    async function createOwnedSchedule(name: string, idempotencyKey: string): Promise<string> {
      const response = await jsonRequest(base, '/api/schedules', {
        method: 'POST',
        headers: { ...identityHeaders(USER_B), 'idempotency-key': idempotencyKey },
        body: {
          name,
          fireAt: new Date(Date.now() + 60_000).toISOString(),
          payload: {},
        },
      });
      assert.equal(response.status, 200);
      return stringField(objectField(response.body, 'schedule'), 'id');
    }

    const cancelId = await createOwnedSchedule('cancel target', 'owner-create-cancel');
    const deleteId = await createOwnedSchedule('delete target', 'owner-create-delete');
    const tickId = await createOwnedSchedule('tick target', 'owner-create-tick');
    const tickFile = path.join(trustedRoot, '.AgentCowork', 'schedules', `${tickId}.json`);
    const tickRecord = JSON.parse(fs.readFileSync(tickFile, 'utf8')) as Record<string, unknown>;
    tickRecord.nextFireAt = new Date(Date.now() - 60_000).toISOString();
    fs.writeFileSync(tickFile, `${JSON.stringify(tickRecord, null, 2)}\n`, 'utf8');

    const siblingList = await jsonRequest(base, '/api/schedules', {
      headers: identityHeaders(USER_A),
    });
    assert.equal(siblingList.status, 200);
    assert.equal(arrayField(siblingList.body, 'schedules').length, 0);

    const queryOverride = await jsonRequest(base, `/api/schedules?userId=${USER_B}`, {
      headers: identityHeaders(USER_A),
    });
    assert.equal(queryOverride.status, 403);

    const siblingCancel = await jsonRequest(base, `/api/schedules/${cancelId}/cancel`, {
      method: 'POST',
      headers: { ...identityHeaders(USER_A), 'idempotency-key': 'sibling-cancel' },
    });
    const siblingDelete = await jsonRequest(base, `/api/schedules/${deleteId}`, {
      method: 'DELETE',
      headers: { ...identityHeaders(USER_A), 'idempotency-key': 'sibling-delete' },
    });
    const siblingTick = await jsonRequest(base, '/api/schedules/_tick', {
      method: 'POST',
      headers: { ...identityHeaders(USER_A), 'idempotency-key': 'sibling-tick' },
    });

    assert.deepEqual(
      [siblingCancel.status, siblingDelete.status, siblingTick.status],
      [404, 404, 200],
    );
    assert.equal(siblingTick.body.fired, 0);
    assert.equal(fired.length, 0, 'sibling tick must be rejected before invoking the executor');
    const cancelFile = path.join(trustedRoot, '.AgentCowork', 'schedules', `${cancelId}.json`);
    const deleteFile = path.join(trustedRoot, '.AgentCowork', 'schedules', `${deleteId}.json`);
    const cancelRecord = JSON.parse(fs.readFileSync(cancelFile, 'utf8')) as Record<string, unknown>;
    assert.equal(cancelRecord.status, 'pending', 'sibling cancel must not mutate the record');
    assert.equal(fs.existsSync(deleteFile), true, 'sibling delete must not remove the record');

    const ownerList = await jsonRequest(base, '/api/schedules', {
      headers: identityHeaders(USER_B),
    });
    assert.equal(arrayField(ownerList.body, 'schedules').length, 3);
    const ownerTick = await jsonRequest(base, '/api/schedules/_tick', {
      method: 'POST',
      headers: { ...identityHeaders(USER_B), 'idempotency-key': 'owner-tick' },
    });
    assert.equal(ownerTick.status, 200);
    assert.equal(ownerTick.body.fired, 1);
    assert.deepEqual(fired, [tickId]);
  } finally {
    await close(server);
  }
});

test('clarification store rejects same-tenant sibling reads and answers without changing state', () => {
  const store = createClarificationStore();
  const ownerContext = { tenantId: TENANT_ID, userId: USER_B };
  const siblingContext = { tenantId: TENANT_ID, userId: USER_A };
  const clarification = store.create({
    question: 'Deploy now?',
    options: ['yes', 'no'],
    context: ownerContext,
  });

  assert.equal(store.get(clarification.id, siblingContext), null);
  assert.throws(
    () => store.answer(clarification.id, 'yes', siblingContext),
    (error) => {
      assert.equal((error as Error & { statusCode?: number }).statusCode, 404);
      return true;
    },
  );
  assert.equal(store.get(clarification.id, ownerContext)?.status, 'pending');
});

test('clarification routes reject same-tenant sibling reads and answers before owner state changes', async () => {
  const server = createServer({
    trustedRoot: tempRoot('kcw-clarification-owner-'),
    requireAuth: false,
    trustIdentityHeaders: true,
    enableScheduler: false,
  });
  const base = await bind(server);
  try {
    const created = await jsonRequest(base, '/api/clarify', {
      method: 'POST',
      headers: identityHeaders(USER_B),
      body: { question: 'Choose export', options: ['xlsx', 'csv'] },
    });
    assert.equal(created.status, 200);
    const clarificationId = stringField(objectField(created.body, 'clarification'), 'id');

    const siblingGet = await jsonRequest(base, `/api/clarify/${clarificationId}`, {
      headers: identityHeaders(USER_A),
    });
    const siblingAnswer = await jsonRequest(base, `/api/clarify/${clarificationId}/answer`, {
      method: 'POST',
      headers: identityHeaders(USER_A),
      body: { value: 'csv' },
    });
    assert.deepEqual([siblingGet.status, siblingAnswer.status], [404, 404]);

    const ownerGet = await jsonRequest(base, `/api/clarify/${clarificationId}`, {
      headers: identityHeaders(USER_B),
    });
    assert.equal(objectField(ownerGet.body, 'clarification').status, 'pending');
    const ownerAnswer = await jsonRequest(base, `/api/clarify/${clarificationId}/answer`, {
      method: 'POST',
      headers: identityHeaders(USER_B),
      body: { value: 'xlsx' },
    });
    assert.equal(ownerAnswer.status, 200);
    assert.equal(objectField(ownerAnswer.body, 'clarification').answer, 'xlsx');
  } finally {
    await close(server);
  }
});
