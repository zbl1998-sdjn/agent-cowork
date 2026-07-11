// 文件操作回滚(host · L1 领域层 · workspace)
// ---------------------------------------------------------------------------
// 职责:为 apply 过的写/移操作生成「可回滚条目」,并按需逆序回滚:删掉新建文件、从备份还原被覆盖
//       文件、把移动/改名移回去。回滚前校验哈希(目标自 apply 后被改动则拒绝),保证安全。
// 安全:备份落在可信根内的 .AgentCowork/rollback/<batch>;全程经 path-policy 校验。
// 依赖:L0 path-policy + 同层 file-operation-utils。
// 导出:createRollbackBatchId / rollbackEntryForWrite / rollbackEntryForMove / rollbackFileOperations。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { assertExternalWorkspacePath } from '../security/external-workspace-boundary.js';
import { assertTrustedPath, assertTrustedPathForCreate } from '../security/path-policy.js';
import { fileExists, hashFile, pathExists, requiredPath } from './file-operation-utils.js';

export type JournalWriter = { append(event: unknown): unknown };
export type RollbackPreparation = Readonly<{
  beforeMutation?(): void;
  commit(): void;
  abort(): void;
}>;
export type RollbackOptions = {
  trustedRoot?: string;
  rollbackBatchId?: string;
  journalWriter?: JournalWriter;
  prepareDeleteCreated?: (path: string) => RollbackPreparation | null;
  prepareRestoreBackup?: (path: string, backupPath: string) => RollbackPreparation | null;
  prepareRenameBack?: (source: string, target: string) => RollbackPreparation | null;
};
export type OperationPreview = {
  type: string;
  path: string;
  targetPath?: string;
  beforeHash?: string | null;
  afterHash?: string | null;
};
type RollbackInput = {
  type?: unknown;
  rollback?: unknown;
  path?: string;
  backupPath?: string;
  from?: string;
  to?: string;
  beforeHash?: string | null;
  expectedHash?: string | null;
  batchId?: string;
};
export type RollbackEntry = {
  type: string;
  path?: string;
  backupPath?: string;
  from?: string;
  to?: string;
  beforeHash?: string | null;
  expectedHash?: string | null;
  batchId?: string;
};
export type RollbackResult = {
  type: string;
  path?: string;
  backupPath?: string;
  from?: string;
  to?: string;
  status: string;
};

/** 生成一个回滚批次 ID(同批操作的备份归到同一目录)。 */
export function createRollbackBatchId(): string {
  return `rb_${Date.now()}_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
}

function rollbackRootFor(trustedRoot: string, batchId: string): string {
  return assertTrustedPathForCreate(path.join(trustedRoot, '.AgentCowork', 'rollback', batchId), trustedRoot);
}

function backupPathFor(filePath: string, options: RollbackOptions): { batchId: string; backupPath: string } {
  const root = path.resolve(requiredPath(options.trustedRoot, 'trustedRoot'));
  const batchId = options.rollbackBatchId || createRollbackBatchId();
  const relative = path.relative(root, filePath).split(path.sep).join('/');
  const digest = crypto.createHash('sha256').update(relative).digest('hex').slice(0, 20);
  return {
    batchId,
    backupPath: assertTrustedPathForCreate(path.join(rollbackRootFor(root, batchId), `${digest}.bak`), root),
  };
}

function backupExistingFile(filePath: string, options: RollbackOptions): { batchId: string; backupPath: string } {
  const backup = backupPathFor(filePath, options);
  fs.mkdirSync(path.dirname(backup.backupPath), { recursive: true });
  fs.copyFileSync(filePath, backup.backupPath);
  return backup;
}

/** 为写操作造回滚条目:覆盖已有文件则先备份(restore-backup),新建文件则记 delete-created-file。 */
export function rollbackEntryForWrite(op: OperationPreview, options: RollbackOptions): RollbackEntry {
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

/** 为移动/改名造回滚条目(rename-back:把目标移回原路径)。 */
export function rollbackEntryForMove(op: OperationPreview): RollbackEntry {
  return {
    type: 'rename-back',
    from: requiredPath(op.targetPath, 'targetPath'),
    to: op.path,
    expectedHash: op.afterHash ?? null,
  };
}

function normalizeRollbackEntry(entry: unknown): RollbackEntry {
  const wrapper = (entry && typeof entry === 'object' ? entry : {}) as RollbackInput;
  const rollback = wrapper.rollback && typeof wrapper.rollback === 'object' ? wrapper.rollback : entry;
  if (!rollback || typeof rollback !== 'object') {
    throw new Error('Each rollback entry must be an object');
  }
  const record = rollback as RollbackInput;
  const type = String(record.type || '').toLowerCase();
  return { ...record, type };
}

function assertExpectedHash(filePath: string, expectedHash: string | null | undefined): void {
  if (expectedHash && hashFile(filePath) !== expectedHash) {
    throw new Error(`Rollback target changed since apply: ${filePath}`);
  }
}

function applyPrepared<T>(preparation: RollbackPreparation | null, effect: () => T): T {
  try {
    preparation?.beforeMutation?.();
    const result = effect();
    preparation?.commit();
    return result;
  } catch (error) {
    try {
      preparation?.abort();
    } catch (abortError) {
      throw new AggregateError([error, abortError], 'rollback mutation and ownership recovery failed');
    }
    throw error;
  }
}

function rollbackCreatedFile(
  entry: RollbackEntry,
  trustedRoot: string,
  prepare?: RollbackOptions['prepareDeleteCreated'],
): RollbackResult {
  const target = assertExternalWorkspacePath(path.resolve(requiredPath(entry.path, 'path')), trustedRoot);
  const exists = fileExists(target);
  if (exists) assertExpectedHash(target, entry.expectedHash);
  return applyPrepared(prepare?.(target) ?? null, () => {
    if (!exists) return { type: entry.type, path: target, status: 'already-absent' };
    fs.unlinkSync(target);
    return { type: entry.type, path: target, status: 'rolled_back' };
  });
}

function rollbackBackupRestore(
  entry: RollbackEntry,
  trustedRoot: string,
  prepare?: RollbackOptions['prepareRestoreBackup'],
): RollbackResult {
  const target = assertExternalWorkspacePath(path.resolve(requiredPath(entry.path, 'path')), trustedRoot);
  const backupPath = assertTrustedPath(path.resolve(requiredPath(entry.backupPath, 'backupPath')), trustedRoot);
  if (!fileExists(backupPath)) {
    throw new Error(`Rollback backup not found: ${backupPath}`);
  }
  if (fileExists(target)) {
    assertExpectedHash(target, entry.expectedHash);
  }
  return applyPrepared(prepare?.(target, backupPath) ?? null, () => {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(backupPath, target);
    return { type: entry.type, path: target, backupPath, status: 'rolled_back' };
  });
}

function rollbackRenameBack(
  entry: RollbackEntry,
  trustedRoot: string,
  prepare?: RollbackOptions['prepareRenameBack'],
): RollbackResult {
  const from = assertExternalWorkspacePath(path.resolve(requiredPath(entry.from, 'from')), trustedRoot);
  const to = assertExternalWorkspacePath(path.resolve(requiredPath(entry.to, 'to')), trustedRoot);
  if (!fileExists(from)) {
    throw new Error(`Rollback source not found: ${from}`);
  }
  if (pathExists(to)) {
    throw new Error(`Rollback target already exists: ${to}`);
  }
  assertExpectedHash(from, entry.expectedHash);
  const preparation = prepare?.(from, to) ?? null;
  return applyPrepared(preparation, () => {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    preparation?.beforeMutation?.();
    fs.renameSync(from, to);
    return { type: entry.type, from, to, status: 'rolled_back' };
  });
}

/** 逆序回滚一批操作条目(删新建/还原备份/移回);逐条校验哈希并记 journal,返回回滚结果。 */
export function rollbackFileOperations(entries: unknown, options: RollbackOptions = {}): { rolledBack: RollbackResult[] } {
  const trustedRoot = options.trustedRoot;
  const journalWriter = options.journalWriter;
  if (!trustedRoot) {
    throw new Error('trustedRoot is required');
  }
  if (!Array.isArray(entries)) {
    throw new Error('rollback entries must be an array');
  }

  const rolledBack: RollbackResult[] = [];
  for (const raw of [...entries].reverse()) {
    const entry = normalizeRollbackEntry(raw);
    let result: RollbackResult;
    if (entry.type === 'delete-created-file') {
      result = rollbackCreatedFile(entry, trustedRoot, options.prepareDeleteCreated);
    } else if (entry.type === 'restore-backup') {
      result = rollbackBackupRestore(entry, trustedRoot, options.prepareRestoreBackup);
    } else if (entry.type === 'rename-back') {
      result = rollbackRenameBack(entry, trustedRoot, options.prepareRenameBack);
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
