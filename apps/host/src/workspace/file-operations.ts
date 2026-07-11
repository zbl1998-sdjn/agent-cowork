// 文件批操作(host · L1 领域层 · workspace)
// ---------------------------------------------------------------------------
// 职责:在可信根内安全地执行 write/rename/move 批量文件操作。先 preview(算前后哈希、查冲突)
//       再 apply(写后回读校验哈希、记账到 journal、生成可回滚条目)。delete 一律禁止。
// 安全:写目标用 create-aware 路径校验(防 junction/symlink 越界);每步写入 journal 便于审计/回滚。
// 依赖:L0 path-policy + 同层 file-rollback / file-operation-utils。
// 导出:previewFileOperations / applyFileOperations,并转出 rollbackFileOperations。
import fs from 'node:fs';
import path from 'node:path';
import { assertExternalWorkspacePath } from '../security/external-workspace-boundary.js';
import { omitUndefined } from '../util/object.js';
import { createRollbackBatchId, rollbackEntryForMove, rollbackEntryForWrite, rollbackFileOperations as rollbackEntries } from './file-rollback.js';
import { fileExists, hashBuffer, hashFile, pathExists, requiredPath } from './file-operation-utils.js';
import type { RollbackEntry } from './file-rollback.js';
import type {
  FileOperation,
  FileOperationEvent,
  FileOperationInput,
  FileOperationOptions,
  OperationPreview,
} from './file-operation-types.js';

export { rollbackEntries as rollbackFileOperations };
export type {
  FileOperation,
  FileOperationEvent,
  FileOperationInput,
  FileOperationOptions,
  OperationPreview,
} from './file-operation-types.js';

function normalizeOp(op: unknown): FileOperation {
  if (!op || typeof op !== 'object') {
    throw new Error('Each file operation must be an object');
  }
  const record = op as FileOperationInput;
  const type = String(record.type || '').toLowerCase();
  return { ...record, type };
}

function operationContentBuffer(op: FileOperation): Buffer {
  if (op.encoding === 'base64' || typeof op.contentBase64 === 'string') {
    return Buffer.from(String(op.contentBase64 ?? op.content ?? ''), 'base64');
  }
  return Buffer.from(String(op.content ?? ''), 'utf8');
}

function previewWrite(op: FileOperation, trustedRoot: string, inspectWrite?: (path: string, content: Buffer) => void): OperationPreview {
  // 写目标可能尚不存在,因此校验其真实父目录,防止 junction/symlink 越界。
  const target = assertExternalWorkspacePath(path.resolve(requiredPath(op.path, 'path')), trustedRoot);
  const content = operationContentBuffer(op);
  inspectWrite?.(target, content);
  const overwrite = op.overwrite === true;
  const beforeExists = fileExists(target);
  if (beforeExists && !overwrite) {
    throw new Error(`Overwrite disabled: ${target}`);
  }

  const beforeHash = beforeExists ? hashFile(target) : null;
  const afterHash = hashBuffer(content);

  return {
    type: 'write',
    path: target,
    beforeHash,
    afterHash,
  };
}

function previewRename(op: FileOperation, trustedRoot: string, inspectMove?: (source: string, target: string) => void): OperationPreview {
  const source = assertExternalWorkspacePath(path.resolve(requiredPath(op.path, 'path')), trustedRoot);
  const base = path.dirname(source);
  const target = assertExternalWorkspacePath(path.resolve(base, requiredPath(op.newName, 'newName')), trustedRoot);
  inspectMove?.(source, target);
  if (source === target) {
    throw new Error(`Rename target equals source: ${source}`);
  }
  if (!fileExists(source)) {
    throw new Error(`Source not found: ${source}`);
  }
  if (pathExists(target)) {
    throw new Error(`Target already exists: ${target}`);
  }
  const beforeHash = hashFile(source);
  return {
    type: 'rename',
    path: source,
    targetPath: target,
    beforeHash,
    afterHash: beforeHash,
  };
}

function previewMove(op: FileOperation, trustedRoot: string, inspectMove?: (source: string, target: string) => void): OperationPreview {
  const source = assertExternalWorkspacePath(path.resolve(requiredPath(op.from, 'from')), trustedRoot);
  const target = assertExternalWorkspacePath(path.resolve(requiredPath(op.to, 'to')), trustedRoot);
  inspectMove?.(source, target);
  if (source === target) {
    throw new Error(`Move target equals source: ${source}`);
  }
  if (!fileExists(source)) {
    throw new Error(`Source not found: ${source}`);
  }
  if (pathExists(target)) {
    throw new Error(`Target already exists: ${target}`);
  }
  const beforeHash = hashFile(source);
  return {
    type: 'move',
    path: source,
    targetPath: target,
    beforeHash,
    afterHash: beforeHash,
  };
}

/** 预览批操作:逐条算前后哈希、查冲突(禁 delete、禁覆盖/重名),返回操作预案但不落盘。 */
export function previewFileOperations(operations: unknown, options: FileOperationOptions = {}): { operations: OperationPreview[] } {
  const trustedRoot = options.trustedRoot;
  if (!trustedRoot) {
    throw new Error('trustedRoot is required');
  }
  if (!Array.isArray(operations)) {
    throw new Error('operations must be an array');
  }

  const previews: OperationPreview[] = [];
  for (const rawOp of operations) {
    const op = normalizeOp(rawOp);
    if (op.type === 'delete') {
      throw new Error('delete is forbidden');
    }
    if (op.type === 'write') {
      previews.push(previewWrite(op, trustedRoot, options.inspectWrite));
      continue;
    }
    if (op.type === 'rename') {
      previews.push(previewRename(op, trustedRoot, options.inspectMove));
      continue;
    }
    if (op.type === 'move') {
      previews.push(previewMove(op, trustedRoot, options.inspectMove));
      continue;
    }
    throw new Error(`Unsupported operation type: ${op.type}`);
  }
  return { operations: previews };
}

function applyWrite(op: FileOperation): void {
  const targetPath = requiredPath(op.path, 'path');
  const parentDir = path.dirname(targetPath);
  fs.mkdirSync(parentDir, { recursive: true });
  fs.writeFileSync(targetPath, operationContentBuffer(op));
}

function applyRename(op: OperationPreview): void {
  fs.renameSync(op.path, requiredPath(op.targetPath, 'targetPath'));
}

function applyMove(op: OperationPreview): void {
  const targetPath = requiredPath(op.targetPath, 'targetPath');
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.renameSync(op.path, targetPath);
}

/** 执行批操作:先 preview,再逐条落盘——写入前后均记 journal,写后回读校验哈希,并生成可回滚条目。 */
export function applyFileOperations(operations: unknown, options: FileOperationOptions = {}): { applied: FileOperationEvent[] } {
  const trustedRoot = options.trustedRoot;
  if (!trustedRoot) {
    throw new Error('trustedRoot is required');
  }
  const journalWriter = options.journalWriter;
  const rollbackBatchId = options.rollbackBatchId || createRollbackBatchId();
  const requestedOperations = Array.isArray(operations) ? operations.map(normalizeOp) : operations;
  const preview = previewFileOperations(requestedOperations, options);
  const appliedOperations = requestedOperations as FileOperation[];
  const results: FileOperationEvent[] = [];

  for (const [index, op] of preview.operations.entries()) {
    const requested = appliedOperations[index] || {};
    let rollback: RollbackEntry | null = null;
    if (op.type === 'write') {
      rollback = rollbackEntryForWrite(op, { trustedRoot, rollbackBatchId });
    } else if (op.type === 'rename' || op.type === 'move') {
      rollback = rollbackEntryForMove(op);
    }
    const event: FileOperationEvent = omitUndefined({
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      at: new Date().toISOString(),
      action: op.type,
      path: op.path,
      targetPath: op.targetPath,
      beforeHash: op.beforeHash,
      afterHash: op.afterHash,
      rollback,
      status: 'pending',
    });
    if (journalWriter?.append) {
      journalWriter.append(event);
    }

    if (op.type === 'write') {
      const preparation = options.prepareWrite?.(op.path) || null;
      try {
        applyWrite({ ...requested, type: 'write', path: op.path });
        const afterStat = fs.statSync(op.path);
        event.status = 'applied';
        event.afterHash = hashFile(op.path);
        if (event.rollback) event.rollback.expectedHash = event.afterHash;
        event.size = afterStat.size;
        if (journalWriter?.append) {
          journalWriter.append({ ...event, stage: 'after' });
        }
        results.push({ ...event, status: 'applied' });
      } catch (error) {
        preparation?.abort();
        throw error;
      }
      continue;
    }

    if (op.type === 'rename') {
      applyRename(op);
      event.status = 'applied';
      if (journalWriter?.append) {
        journalWriter.append({ ...event, stage: 'after' });
      }
      results.push({ ...event, status: 'applied' });
      continue;
    }

    if (op.type === 'move') {
      applyMove(op);
      event.status = 'applied';
      if (journalWriter?.append) {
        journalWriter.append({ ...event, stage: 'after' });
      }
      results.push({ ...event, status: 'applied' });
    }
  }

  return { applied: results };
}
