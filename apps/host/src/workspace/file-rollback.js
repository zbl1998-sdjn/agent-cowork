import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { assertTrustedPath, assertTrustedPathForCreate } from '../security/path-policy.js';
import { fileExists, hashFile, pathExists, requiredPath } from './file-operation-utils.js';

/**
 * @typedef {{ append(event: unknown): unknown }} JournalWriter
 * @typedef {{ trustedRoot?: string, rollbackBatchId?: string, journalWriter?: JournalWriter }} RollbackOptions
 * @typedef {{ type: string, path: string, targetPath?: string, beforeHash?: string | null, afterHash?: string | null }} OperationPreview
 * @typedef {{ type?: unknown, rollback?: unknown, path?: string, backupPath?: string, from?: string, to?: string, beforeHash?: string | null, expectedHash?: string | null, batchId?: string }} RollbackInput
 * @typedef {{ type: string, path?: string, backupPath?: string, from?: string, to?: string, beforeHash?: string | null, expectedHash?: string | null, batchId?: string }} RollbackEntry
 * @typedef {{ type: string, path?: string, backupPath?: string, from?: string, to?: string, status: string }} RollbackResult
 */

export function createRollbackBatchId() {
  return `rb_${Date.now()}_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
}

/** @param {string} trustedRoot @param {string} batchId @returns {string} */
function rollbackRootFor(trustedRoot, batchId) {
  return assertTrustedPathForCreate(path.join(trustedRoot, '.AgentCowork', 'rollback', batchId), trustedRoot);
}

/** @param {string} filePath @param {RollbackOptions} options @returns {{ batchId: string, backupPath: string }} */
function backupPathFor(filePath, options) {
  const root = path.resolve(requiredPath(options.trustedRoot, 'trustedRoot'));
  const batchId = options.rollbackBatchId || createRollbackBatchId();
  const relative = path.relative(root, filePath).split(path.sep).join('/');
  const digest = crypto.createHash('sha256').update(relative).digest('hex').slice(0, 20);
  return {
    batchId,
    backupPath: assertTrustedPathForCreate(path.join(rollbackRootFor(root, batchId), `${digest}.bak`), root),
  };
}

/** @param {string} filePath @param {RollbackOptions} options @returns {{ batchId: string, backupPath: string }} */
function backupExistingFile(filePath, options) {
  const backup = backupPathFor(filePath, options);
  fs.mkdirSync(path.dirname(backup.backupPath), { recursive: true });
  fs.copyFileSync(filePath, backup.backupPath);
  return backup;
}

/** @param {OperationPreview} op @param {RollbackOptions} options @returns {RollbackEntry} */
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

/** @param {OperationPreview} op @returns {RollbackEntry} */
export function rollbackEntryForMove(op) {
  return {
    type: 'rename-back',
    from: requiredPath(op.targetPath, 'targetPath'),
    to: op.path,
    expectedHash: op.afterHash,
  };
}

/** @param {unknown} entry @returns {RollbackEntry} */
function normalizeRollbackEntry(entry) {
  const wrapper = /** @type {RollbackInput} */ (entry && typeof entry === 'object' ? entry : {});
  const rollback = wrapper.rollback && typeof wrapper.rollback === 'object' ? wrapper.rollback : entry;
  if (!rollback || typeof rollback !== 'object') {
    throw new Error('Each rollback entry must be an object');
  }
  const record = /** @type {RollbackInput} */ (rollback);
  const type = String(record.type || '').toLowerCase();
  return { ...record, type };
}

/** @param {string} filePath @param {string | null | undefined} expectedHash */
function assertExpectedHash(filePath, expectedHash) {
  if (expectedHash && hashFile(filePath) !== expectedHash) {
    throw new Error(`Rollback target changed since apply: ${filePath}`);
  }
}

/** @param {RollbackEntry} entry @param {string} trustedRoot @returns {RollbackResult} */
function rollbackCreatedFile(entry, trustedRoot) {
  const target = assertTrustedPath(path.resolve(requiredPath(entry.path, 'path')), trustedRoot);
  if (!fileExists(target)) {
    return { type: entry.type, path: target, status: 'already-absent' };
  }
  assertExpectedHash(target, entry.expectedHash);
  fs.unlinkSync(target);
  return { type: entry.type, path: target, status: 'rolled_back' };
}

/** @param {RollbackEntry} entry @param {string} trustedRoot @returns {RollbackResult} */
function rollbackBackupRestore(entry, trustedRoot) {
  const target = assertTrustedPath(path.resolve(requiredPath(entry.path, 'path')), trustedRoot);
  const backupPath = assertTrustedPath(path.resolve(requiredPath(entry.backupPath, 'backupPath')), trustedRoot);
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

/** @param {RollbackEntry} entry @param {string} trustedRoot @returns {RollbackResult} */
function rollbackRenameBack(entry, trustedRoot) {
  const from = assertTrustedPath(path.resolve(requiredPath(entry.from, 'from')), trustedRoot);
  const to = assertTrustedPathForCreate(path.resolve(requiredPath(entry.to, 'to')), trustedRoot);
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

/** @param {unknown} entries @param {RollbackOptions} [options] @returns {{ rolledBack: RollbackResult[] }} */
export function rollbackFileOperations(entries, options = {}) {
  const trustedRoot = options.trustedRoot;
  const journalWriter = options.journalWriter;
  if (!trustedRoot) {
    throw new Error('trustedRoot is required');
  }
  if (!Array.isArray(entries)) {
    throw new Error('rollback entries must be an array');
  }

  /** @type {RollbackResult[]} */
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
