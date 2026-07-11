import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  readEgressAuditRecords,
  writeEgressAuditRecord,
  type EgressAuditRecord,
} from '../src/security/egress-audit.js';

type SymlinkSync = (target: string, linkPath: string, type?: 'file' | 'dir' | 'junction') => void;
const symlinkSync = (fs as unknown as { symlinkSync: SymlinkSync }).symlinkSync;

function record(id: string): EgressAuditRecord {
  return {
    id, timestamp: '2026-07-11T01:00:00.000Z', kind: 'model_inference',
    decision: 'allow', reasonCode: 'model_provider_allowed', securityMode: 'local_strict',
    destination: 'http://127.0.0.1:11434/v1', provider: 'ollama', model: 'test',
    contentBytes: 4, sensitivity: 'public', tags: [], approved: true,
  };
}

test('egress audit append fails before writing when its directory is swapped after open', {
  skip: process.platform !== 'win32',
}, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-egress-swap-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-egress-outside-'));
  const auditFile = writeEgressAuditRecord(root, record('seed'));
  const securityDir = path.dirname(auditFile);
  const displaced = path.join(root, '.AgentCowork', 'security-original');
  const outsideFile = path.join(outside, path.basename(auditFile));
  fs.writeFileSync(outsideFile, 'outside-sentinel\n', 'utf8');
  const originalBytes = fs.readFileSync(auditFile, 'utf8');
  const originalOpen = fs.openSync;
  let swapped = false;
  fs.openSync = ((target: string, flags: string | number, mode?: number) => {
    if (!swapped && path.resolve(String(target)) === path.resolve(auditFile)) {
      fs.renameSync(securityDir, displaced);
      try { symlinkSync(outside, securityDir, 'junction'); } catch (error) {
        fs.renameSync(displaced, securityDir);
        t.skip(`junction unavailable: ${String(error)}`);
      }
      swapped = true;
    }
    return originalOpen(target, flags, mode);
  }) as typeof fs.openSync;
  try {
    assert.throws(() => writeEgressAuditRecord(root, record('blocked')), /changed|junction|reparse/i);
  } finally {
    fs.openSync = originalOpen;
  }
  assert.equal(swapped, true);
  assert.equal(fs.readFileSync(path.join(displaced, path.basename(auditFile)), 'utf8'), originalBytes);
  assert.equal(fs.readFileSync(outsideFile, 'utf8'), 'outside-sentinel\n');
});

test('egress audit append rejects an ordinary replacement directory before writing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-egress-dir-swap-'));
  const auditFile = writeEgressAuditRecord(root, record('seed'));
  const securityDir = path.dirname(auditFile);
  const displaced = path.join(root, '.AgentCowork', 'security-original');
  const replacement = path.join(root, '.AgentCowork', 'security-replacement');
  fs.mkdirSync(replacement);
  fs.writeFileSync(path.join(replacement, path.basename(auditFile)), 'replacement-sentinel\n', 'utf8');
  const originalBytes = fs.readFileSync(auditFile, 'utf8');
  const originalOpen = fs.openSync;
  fs.openSync = ((target: string, flags: string | number, mode?: number) => {
    if (path.resolve(target) === path.resolve(auditFile)) {
      fs.renameSync(securityDir, displaced);
      fs.renameSync(replacement, securityDir);
    }
    return originalOpen(target, flags, mode);
  }) as typeof fs.openSync;
  try {
    assert.throws(() => writeEgressAuditRecord(root, record('blocked')), /changed/i);
  } finally {
    fs.openSync = originalOpen;
  }
  assert.equal(fs.readFileSync(path.join(displaced, path.basename(auditFile)), 'utf8'), originalBytes);
  assert.equal(fs.readFileSync(auditFile, 'utf8'), 'replacement-sentinel\n');
});

test('egress audit read rejects an ordinary replacement directory during descriptor read', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-egress-read-dir-swap-'));
  const auditFile = writeEgressAuditRecord(root, record('seed'));
  const securityDir = path.dirname(auditFile);
  const displaced = path.join(root, '.AgentCowork', 'security-original');
  const replacement = path.join(root, '.AgentCowork', 'security-replacement');
  fs.mkdirSync(replacement);
  fs.writeFileSync(
    path.join(replacement, path.basename(auditFile)),
    `${JSON.stringify(record('replacement'))}\n`,
    'utf8',
  );
  const originalRead = fs.readFileSync;
  let attempted = false;
  let swapped = false;
  fs.readFileSync = ((target: fs.PathOrFileDescriptor, options?: unknown) => {
    if (!swapped && (typeof target === 'number' || path.resolve(String(target)) === path.resolve(auditFile))) {
      attempted = true;
      fs.renameSync(securityDir, displaced);
      fs.renameSync(replacement, securityDir);
      swapped = true;
    }
    return (originalRead as (file: fs.PathOrFileDescriptor, readOptions?: unknown) => unknown)(target, options);
  }) as typeof fs.readFileSync;
  try {
    assert.throws(
      () => readEgressAuditRecords(root),
      /changed during operation|managed file|boundary|EPERM|operation not permitted/i,
    );
  } finally {
    fs.readFileSync = originalRead;
  }
  assert.equal(attempted, true, 'test must attempt to replace the managed audit directory during read');
});

test('egress audit read rejects an ordinary file identity replacement during descriptor read', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-egress-read-file-swap-'));
  const auditFile = writeEgressAuditRecord(root, record('seed'));
  const displaced = `${auditFile}.original`;
  const replacement = `${auditFile}.replacement`;
  fs.writeFileSync(replacement, `${JSON.stringify(record('replacement'))}\n`, 'utf8');
  const originalRead = fs.readFileSync;
  let swapped = false;
  fs.readFileSync = ((target: fs.PathOrFileDescriptor, options?: unknown) => {
    if (!swapped && (typeof target === 'number' || path.resolve(String(target)) === path.resolve(auditFile))) {
      fs.renameSync(auditFile, displaced);
      fs.renameSync(replacement, auditFile);
      swapped = true;
    }
    return (originalRead as (file: fs.PathOrFileDescriptor, readOptions?: unknown) => unknown)(target, options);
  }) as typeof fs.readFileSync;
  try {
    assert.throws(() => readEgressAuditRecords(root), /changed during operation|managed file|boundary/i);
  } finally {
    fs.readFileSync = originalRead;
  }
  assert.equal(swapped, true, 'test must replace the audit file during read');
});
