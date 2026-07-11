import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { FileScheduleStore, type ScheduleRecord } from '../src/runtime/scheduler-store.js';
import { ensureRunOwnerClaim, runOwnerClaimPath } from '../src/util/run-owner.js';

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-schedule-operation-'));
}

function record(id: string): ScheduleRecord {
  return {
    id,
    tenantId: 'tenant_a',
    userId: 'user_a',
    traceId: null,
    name: 'daily',
    kind: 'cron',
    status: 'pending',
    cron: '0 9 * * *',
    fireAt: null,
    nextFireAt: '2026-07-12T09:00:00.000Z',
    lastFiredAt: null,
    lastRunId: null,
    lastError: null,
    payload: {},
    version: 1,
    runs: 0,
    createdAt: '2026-07-11T00:00:00.000Z',
    updatedAt: '2026-07-11T00:00:00.000Z',
  };
}

test('schedule save keeps one guard from owner claim through record publish', () => {
  const container = tempRoot();
  const root = path.join(container, 'schedules');
  const owners = path.join(root, '.owners');
  const displaced = path.join(root, '.owners-original');
  fs.mkdirSync(root);
  const store = new FileScheduleStore({ storeDir: root });
  const id = 'sched_claim_then_swap';
  const claimName = `${crypto.createHash('sha256').update(id).digest('hex')}.json`;
  const claimPath = path.join(root, '.owners', claimName);
  const originalLstatSync = fs.lstatSync;
  let swapped = false;
  fs.lstatSync = ((...args: unknown[]) => {
    const result = Reflect.apply(originalLstatSync, fs, args);
    if (!swapped && path.resolve(String(args[0])) === path.resolve(claimPath) && result.isFile()) {
      fs.renameSync(owners, displaced);
      fs.mkdirSync(owners);
      swapped = true;
    }
    return result;
  }) as typeof fs.lstatSync;

  try {
    assert.throws(
      () => store.save(record(id)),
      /changed during operation|managed/i,
    );
  } finally {
    fs.lstatSync = originalLstatSync;
  }
  assert.equal(swapped, true);
  assert.deepEqual(fs.readdirSync(owners), [], 'replacement owner directory must remain empty');
  assert.equal(fs.existsSync(path.join(root, `${id}.json`)), false);
});

test('schedule save does not trust a claim read through a transient .owners replacement', () => {
  const container = tempRoot();
  const root = path.join(container, 'schedules');
  const owners = path.join(root, '.owners');
  const displaced = path.join(root, '.owners-original');
  const attackerRoot = path.join(container, 'attacker');
  const attackerOwners = path.join(attackerRoot, '.owners');
  const id = 'sched_existing_claim_read_swap';
  const claimPath = runOwnerClaimPath(root, id);
  ensureRunOwnerClaim({
    claimPath,
    owner: { tenantId: 'tenant_original', userId: 'user_original' },
  });
  ensureRunOwnerClaim({
    claimPath: runOwnerClaimPath(attackerRoot, id),
    owner: { tenantId: 'tenant_a', userId: 'user_a' },
  });
  const store = new FileScheduleStore({ storeDir: root });
  const originalReadFileSync = fs.readFileSync;
  const originalOpenSync = fs.openSync;
  let swapped = false;
  const whileOwnersAreReplaced = <T>(operation: () => T): T => {
    fs.renameSync(owners, displaced);
    fs.renameSync(attackerOwners, owners);
    try {
      swapped = true;
      return operation();
    } finally {
      fs.renameSync(owners, attackerOwners);
      fs.renameSync(displaced, owners);
    }
  };
  fs.openSync = ((...args: unknown[]) => {
    if (!swapped && path.resolve(String(args[0])) === path.resolve(claimPath)) {
      return whileOwnersAreReplaced(() => Reflect.apply(originalOpenSync, fs, args));
    }
    return Reflect.apply(originalOpenSync, fs, args);
  }) as typeof fs.openSync;
  fs.readFileSync = ((...args: unknown[]) => {
    const target = args[0];
    const readingClaim = typeof target === 'number'
      || path.resolve(String(target)) === path.resolve(claimPath);
    if (!swapped && readingClaim) {
      return whileOwnersAreReplaced(() => Reflect.apply(originalReadFileSync, fs, args));
    }
    return Reflect.apply(originalReadFileSync, fs, args);
  }) as typeof fs.readFileSync;

  try {
    assert.throws(
      () => store.save(record(id)),
      /owner mismatch|could not be verified|changed during operation|managed/i,
    );
  } finally {
    fs.readFileSync = originalReadFileSync;
    fs.openSync = originalOpenSync;
  }
  assert.equal(swapped, true, 'test must replace .owners while the claim is read');
  assert.equal(fs.existsSync(path.join(root, `${id}.json`)), false);
});
