import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { captureRun } from '../src/recipes/capture.js';
import { readRunRecord, writeRunRecord } from '../src/runtime/run-store.js';
import { REDACTED_VALUE } from '../src/security/redaction.js';

test('captureRun key-redacts nested sensitive tool arguments', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-capture-redaction-'));
  const runStoreRoot = path.join(root, 'runs');
  const runId = 'run_capture_nested_secret';
  const secret = 'test-short-capture-secret';
  writeRunRecord(runStoreRoot, {
    id: runId,
    type: 'agent-chat',
    provider: 'kimi-api',
    mode: 'agent',
    status: 'succeeded',
    startedAt: '2026-05-24T00:00:00.000Z',
    finishedAt: '2026-05-24T00:00:01.000Z',
    input: { prompt: 'write report' },
    result: { ok: true, text: 'done' },
    events: [{
      type: 'tool_call',
      name: 'Write',
      args: { path: 'report.md', auth: { accessToken: secret } },
    }],
  });

  const draft = (await captureRun({
    runId,
    recordReader: (id) => readRunRecord(runStoreRoot, id),
  })).recipe;

  assert.deepEqual(draft.steps[0]?.args, {
    path: 'report.md',
    auth: { accessToken: REDACTED_VALUE },
  });
  assert.equal(JSON.stringify(draft).includes(secret), false);
});
