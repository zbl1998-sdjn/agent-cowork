import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  AuditEventBus,
  createJsonlAuditSubscriber,
  verifyAuditHashChain,
} from '../src/runtime/audit-events.js';
import { createAuditChainRecord } from '../src/storage/audit-events.js';
import { samePathReal } from './helpers/path-swap.js';

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

function auditLine(action: string): string {
  return `${JSON.stringify(createAuditChainRecord({ action }))}\n`;
}

function withTransientPathReplacement<T>({
  targetPath,
  replace,
  restore,
  onSwap,
  action,
}: {
  targetPath: string;
  replace(): void;
  restore(): void;
  onSwap(): void;
  action(): T;
}): T {
  const originalOpen = fs.openSync;
  const originalRead = fs.readFileSync;
  let wasSwapped = false;
  let inReplacement = false;
  const whileReplaced = <R>(operation: () => R): R => {
    inReplacement = true;
    replace();
    try {
      wasSwapped = true;
      onSwap();
      return operation();
    } finally {
      restore();
      inReplacement = false;
    }
  };
  fs.openSync = ((...args: unknown[]) => {
    if (!wasSwapped && !inReplacement && samePathReal(String(args[0]), targetPath)) {
      return whileReplaced(() => Reflect.apply(originalOpen, fs, args));
    }
    return Reflect.apply(originalOpen, fs, args);
  }) as typeof fs.openSync;
  fs.readFileSync = ((...args: unknown[]) => {
    if (!wasSwapped
      && !inReplacement
      && typeof args[0] !== 'number'
      && samePathReal(String(args[0]), targetPath)) {
      return whileReplaced(() => Reflect.apply(originalRead, fs, args));
    }
    return Reflect.apply(originalRead, fs, args);
  }) as typeof fs.readFileSync;
  try {
    return action();
  } finally {
    fs.readFileSync = originalRead;
    fs.openSync = originalOpen;
  }
}

function withTransientParentReplacement<T>({
  targetPath,
  parentPath,
  replace,
  restore,
  onSwap,
  action,
}: {
  targetPath: string;
  parentPath: string;
  replace(): void;
  restore(): void;
  onSwap(): void;
  action(): T;
}): T {
  const originalLstat = fs.lstatSync;
  let writerBoundaryCreated = false;
  let wasSwapped = false;
  fs.lstatSync = ((...args: unknown[]) => {
    const candidate = String(args[0]);
    if (samePathReal(candidate, parentPath) && !writerBoundaryCreated) {
      writerBoundaryCreated = true;
      return Reflect.apply(originalLstat, fs, args);
    }
    if (!wasSwapped
      && writerBoundaryCreated
      && (samePathReal(candidate, parentPath) || samePathReal(candidate, targetPath))) {
      replace();
      try {
        wasSwapped = true;
        onSwap();
        return Reflect.apply(originalLstat, fs, args);
      } finally {
        restore();
      }
    }
    return Reflect.apply(originalLstat, fs, args);
  }) as typeof fs.lstatSync;
  try {
    return action();
  } finally {
    fs.lstatSync = originalLstat;
  }
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

test('Audit JSONL subscriber preserves a legacy prefix when starting the hash chain', () => {
  const root = tempRoot();
  const auditPath = path.join(root, 'audit.jsonl');
  fs.writeFileSync(auditPath, `${JSON.stringify({ action: 'legacy.event' })}\n`, 'utf8');
  const subscriber = createJsonlAuditSubscriber(auditPath);
  subscriber({ action: 'chained.event' });

  const records = fs.readFileSync(auditPath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as JsonRecord);
  assert.equal(records[1]?.prev_hash, null);
  assert.deepEqual(
    verifyAuditHashChain(records, { allowLegacyPrefix: true }),
    { ok: true, checked: 1 },
  );
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

test('Audit JSONL subscriber rejects malformed or tampered persisted chains without changing bytes', () => {
  const valid = createAuditChainRecord({ action: 'policy.decision', decision: 'deny' });
  const cases = [
    '{"event_hash":',
    `${JSON.stringify({ ...valid, decision: 'allow' })}\n`,
  ];

  for (const contents of cases) {
    const root = tempRoot();
    const auditPath = path.join(root, 'audit.jsonl');
    fs.writeFileSync(auditPath, contents, 'utf8');
    const before = fs.readFileSync(auditPath, 'utf8');
    assert.throws(
      () => createJsonlAuditSubscriber(auditPath),
      /audit.*(?:integrity|invalid|malformed)/i,
    );
    assert.equal(fs.readFileSync(auditPath, 'utf8'), before);
  }
});

test('Audit JSONL subscriber rejects a transient ordinary parent replacement while loading the chain head', () => {
  const container = tempRoot();
  const auditDirectory = path.join(container, 'audit');
  const replacementDirectory = path.join(container, 'replacement');
  const displacedDirectory = path.join(container, 'audit-original');
  const auditPath = path.join(auditDirectory, 'audit.jsonl');
  fs.mkdirSync(auditDirectory);
  fs.mkdirSync(replacementDirectory);
  fs.writeFileSync(auditPath, auditLine('original'), 'utf8');
  fs.writeFileSync(path.join(replacementDirectory, 'audit.jsonl'), auditLine('replacement'), 'utf8');
  const originalBytes = fs.readFileSync(auditPath, 'utf8');

  let wasSwapped = false;
  assert.throws(
    () => {
      withTransientParentReplacement({
        targetPath: auditPath,
        parentPath: auditDirectory,
        replace() {
          fs.renameSync(auditDirectory, displacedDirectory);
          fs.renameSync(replacementDirectory, auditDirectory);
        },
        restore() {
          fs.renameSync(auditDirectory, replacementDirectory);
          fs.renameSync(displacedDirectory, auditDirectory);
        },
        onSwap() {
          wasSwapped = true;
        },
        action() {
          const subscriber = createJsonlAuditSubscriber(auditPath);
          subscriber({ action: 'must-not-append' });
        },
      });
    },
    /changed during operation|managed file|audit.*integrity/i,
  );
  assert.equal(wasSwapped, true, 'test must replace the audit parent while the chain head is loaded');
  assert.equal(fs.readFileSync(auditPath, 'utf8'), originalBytes);
});

test('Audit JSONL subscriber rejects a transient audit file identity replacement while loading the chain head', () => {
  const root = tempRoot();
  const auditPath = path.join(root, 'audit.jsonl');
  const replacementPath = path.join(root, 'audit-replacement.jsonl');
  const displacedPath = path.join(root, 'audit-original.jsonl');
  fs.writeFileSync(auditPath, auditLine('original'), 'utf8');
  fs.writeFileSync(replacementPath, auditLine('replacement'), 'utf8');
  const originalBytes = fs.readFileSync(auditPath, 'utf8');

  let wasSwapped = false;
  assert.throws(
    () => {
      withTransientPathReplacement({
        targetPath: auditPath,
        replace() {
          fs.renameSync(auditPath, displacedPath);
          fs.renameSync(replacementPath, auditPath);
        },
        restore() {
          fs.renameSync(auditPath, replacementPath);
          fs.renameSync(displacedPath, auditPath);
        },
        onSwap() {
          wasSwapped = true;
        },
        action() {
          const subscriber = createJsonlAuditSubscriber(auditPath);
          subscriber({ action: 'must-not-append' });
        },
      });
    },
    /changed during operation|managed file|audit.*integrity/i,
  );
  assert.equal(wasSwapped, true, 'test must replace the audit file while the chain head is loaded');
  assert.equal(fs.readFileSync(auditPath, 'utf8'), originalBytes);
});
