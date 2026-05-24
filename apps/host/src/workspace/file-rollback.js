import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { assertTrustedPath, assertTrustedPathForCreate } from '../security/path-policy.js';

function hashFile(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function fileExists(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function pathExists(p) {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
}

export function createRollbackBatchId() {
  return `rb_${Date.now()}_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
}

function rollbackRootFor(trustedRoot, batchId) {
  return assertTrustedPathForCreate(path.join(trustedRoot, '.AgentCowork', 'rollback', batchId), trustedRoot);
}

function backupPathFor(filePath, options) {
  const root = path.resolve(options.trustedRoot);
  const batchId = options.rollbackBatchId || createRollbackBatchId();
  const relative = path.relative(root, filePath).split(path.sep).join('/');
  const digest = crypto.createHash('sha256').update(relative).digest('hex').slice(0, 20);
  return {
    batchId,
    backupPath: assertTrustedPathForCreate(path.join(rollbackRootFor(root, batchId), `${digest}.bak`), root),
  };
}

function backupExistingFile(filePath, options) {
  const backup = backupPathFor(filePath, options);
  fs.mkdirSync(path.dirname(backup.backupPath), { recursive: true });
  fs.copyFileSync(filePath, backup.backupPath);
  return backup;
}

export function rollbackEntryForWrite(op, options) {
  if (op.beforeHash) {
    const backup = backupExistingFile(op.path, options);
    return {
      type: 'restore-backup',
      path: op.path,
      backupPath: backup.backupPath,
      beforeHash: op.beforeHash,
      expectedHash: null,
      batchId: backup.batchId,
    };
  }
  return {
    type: 'delete-created-file',
    path: op.path,
    expectedHash: null,
  };
}

export function rollbackEntryForMove(op) {
  return {
    type: 'rename-back',
    from: op.targetPath,
    to: op.path,
    expectedHash: op.afterHash,
  };
}

function normalizeRollbackEntry(entry) {
  const rollback = entry?.rollback || entry;
  if (!rollback || typeof rollback !== 'object') {
    throw new Error('Each rollback entry must be an object');
  }
  const type = String(rollback.type || '').toLowerCase();
  return { ...rollback, type };
}

function assertExpectedHash(filePath, expectedHash) {
  if (expectedHash && hashFile(filePath) !== expectedHash) {
    throw new Error(`Rollback target changed since apply: ${filePath}`);
  }
}

function rollbackCreatedFile(entry, trustedRoot) {
  const target = assertTrustedPath(path.resolve(entry.path), trustedRoot);
  if (!fileExists(target)) {
    return { type: entry.type, path: target, status: 'already-absent' };
  }
  assertExpectedHash(target, entry.expectedHash);
  fs.unlinkSync(target);
  return { type: entry.type, path: target, status: 'rolled_back' };
}

function rollbackBackupRestore(entry, trustedRoot) {
  const target = assertTrustedPath(path.resolve(entry.path), trustedRoot);
  const backupPath = assertTrustedPath(path.resolve(entry.backupPath), trustedRoot);
  if (!fileExists(backupPath)) {
    throw new Error(`Rollback backup not found: ${backupPath}`);
  }
  if (fileExists(target)) {
    assertExpectedHash(target, entry.expectedHash);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(backupPath, target);
  return { type: entry.type, path: target, backupPath, status: 'rolled_back' };
}

function rollbackRenameBack(entry, trustedRoot) {
  const from = assertTrustedPath(path.resolve(entry.from), trustedRoot);
  const to = assertTrustedPathForCreate(path.resolve(entry.to), trustedRoot);
  if (!fileExists(from)) {
    throw new Error(`Rollback source not found: ${from}`);
  }
  if (pathExists(to)) {
    throw new Error(`Rollback target already exists: ${to}`);
  }
  assertExpectedHash(from, entry.expectedHash);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.renameSync(from, to);
  return { type: entry.type, from, to, status: 'rolled_back' };
}

export function rollbackFileOperations(entries, options = {}) {
  const trustedRoot = options.trustedRoot;
  const journalWriter = options.journalWriter;
  if (!trustedRoot) {
    throw new Error('trustedRoot is required');
  }
  if (!Array.isArray(entries)) {
    throw new Error('rollback entries must be an array');
  }

  const rolledBack = [];
  for (const raw of [...entries].reverse()) {
    const entry = normalizeRollbackEntry(raw);
    let result;
    if (entry.type === 'delete-created-file') {
      result = rollbackCreatedFile(entry, trustedRoot);
    } else if (entry.type === 'restore-backup') {
      result = rollbackBackupRestore(entry, trustedRoot);
    } else if (entry.type === 'rename-back') {
      result = rollbackRenameBack(entry, trustedRoot);
    } else {
      throw new Error(`Unsupported rollback type: ${entry.type}`);
    }
    if (journalWriter?.append) {
      journalWriter.append({ ...result, at: new Date().toISOString(), action: 'rollback' });
    }
    rolledBack.push(result);
  }
  return { rolledBack };
}
