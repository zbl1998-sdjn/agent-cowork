import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { createServer } from '../src/server.js';
import { FileScheduleStore } from '../src/runtime/scheduler.js';
import {
  arrayField,
  bind,
  close,
  jsonRequest,
  objectField,
  present,
  recordValue,
  stringField,
  tempRoot,
} from './helpers/host-http.js';

const OWNER_HEADERS = { 'x-tenant-id': 'tenant_alice', 'x-user-id': 'user_alice' };

function forceScheduleDue(file: string): void {
  const record = recordValue(JSON.parse(fs.readFileSync(file, 'utf8')) as unknown, 'schedule file');
  record.nextFireAt = new Date(Date.now() - 60_000).toISOString();
  fs.writeFileSync(file, JSON.stringify(record, null, 2), 'utf8');
}

test('scheduled connected-folder work revalidates its persisted grant before every execution', async () => {
  const trustedRoot = tempRoot('kcw-schedule-grant-');
  const connectedRoot = path.join(trustedRoot, 'connected');
  fs.mkdirSync(connectedRoot);
  const sourcePath = path.join(connectedRoot, 'meeting-notes.md');
  fs.writeFileSync(sourcePath, '# 会议纪要\n- 跟进采购合同\n', 'utf8');
  const server = createServer({
    trustedRoot,
    scheduleStore: new FileScheduleStore({
      storeDir: path.join(trustedRoot, '.AgentCowork', 'schedules'),
    }),
    enableScheduler: true,
    startScheduler: false,
  });
  const base = await bind(server);

  try {
    const granted = await jsonRequest(base, '/api/folder-grants', {
      method: 'POST',
      headers: { ...OWNER_HEADERS, 'idempotency-key': 'grant-for-schedule' },
      body: { path: connectedRoot, displayName: 'Scheduled workspace' },
    });
    assert.equal(granted.status, 201);
    const grantId = stringField(objectField(granted.body, 'grant', 'folder grant'), 'id', 'grant id');

    const bodyOnlyGrant = await jsonRequest(base, '/api/schedules', {
      method: 'POST',
      headers: { ...OWNER_HEADERS, 'idempotency-key': 'forged-body-only-grant' },
      body: {
        name: 'body-only grant must fail',
        cron: '0 9 * * 1',
        payload: { recipeId: 'meeting-actions', trustedRoot: connectedRoot, folderGrantId: grantId },
      },
    });
    assert.equal(bodyOnlyGrant.status, 403, 'an untrusted payload cannot replace the grant header');

    const createSchedule = async (key: string, name: string) => {
      const response = await jsonRequest(base, '/api/schedules', {
        method: 'POST',
        headers: {
          ...OWNER_HEADERS,
          'idempotency-key': key,
          'x-workspace-grant-id': grantId,
        },
        body: {
          name,
          fireAt: new Date(Date.now() + 60_000).toISOString(),
          payload: {
            recipeId: 'meeting-actions',
            trustedRoot: connectedRoot,
            files: [sourcePath],
          },
        },
      });
      assert.equal(response.status, 200);
      const schedule = objectField(response.body, 'schedule', name);
      const payload = objectField(schedule, 'payload', `${name} payload`);
      assert.equal(payload.folderGrantId, grantId, 'the authoritative header grant must be persisted');
      return stringField(schedule, 'id', `${name} id`);
    };

    const activeId = await createSchedule('schedule-active-grant', 'active grant run');
    forceScheduleDue(path.join(trustedRoot, '.AgentCowork', 'schedules', `${activeId}.json`));
    const activeTick = await jsonRequest(base, '/api/schedules/_tick', {
      method: 'POST',
      headers: { ...OWNER_HEADERS, 'idempotency-key': 'tick-active-grant' },
    });
    assert.equal(activeTick.status, 200);
    assert.equal(present(arrayField(activeTick.body, 'results')[0], 'active tick result').ok, true);

    const revokedId = await createSchedule('schedule-revoked-grant', 'revoked grant run');
    const revoked = await jsonRequest(base, `/api/folder-grants/${encodeURIComponent(grantId)}`, {
      method: 'DELETE',
      headers: { ...OWNER_HEADERS, 'idempotency-key': 'revoke-schedule-grant' },
      body: {},
    });
    assert.equal(revoked.status, 200);
    const revokedFile = path.join(trustedRoot, '.AgentCowork', 'schedules', `${revokedId}.json`);
    forceScheduleDue(revokedFile);

    const revokedTick = await jsonRequest(base, '/api/schedules/_tick', {
      method: 'POST',
      headers: { ...OWNER_HEADERS, 'idempotency-key': 'tick-revoked-grant' },
    });
    assert.equal(revokedTick.status, 200);
    assert.equal(present(arrayField(revokedTick.body, 'results')[0], 'revoked tick result').ok, false);
    const failed = recordValue(JSON.parse(fs.readFileSync(revokedFile, 'utf8')) as unknown, 'failed schedule');
    assert.match(String(failed.lastError), /active connected-folder grant is required/);

    const runs = await jsonRequest(base, '/api/runs/index', { headers: OWNER_HEADERS });
    assert.equal(arrayField(runs.body, 'runs').length, 1, 'revoked grant must not create another run');
  } finally {
    await close(server);
  }
});
