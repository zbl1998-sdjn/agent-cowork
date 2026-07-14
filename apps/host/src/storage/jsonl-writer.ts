// 追加式 JSONL 写入器(按大小轮转)(host · L1 领域层 · storage)
// ---------------------------------------------------------------------------
// 职责:逐行追加 JSON 记录到日志文件;文件将超过 maxBytes 时按 file→file.1→file.2…
//       轮转(超出 maxFiles 的最旧代丢弃),防止审计/事件日志无限膨胀。
// 依赖:仅标准库(fs/path)。后端:本地文件系统。
// 导出:JsonlWriter(类)。
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { readCompatEnv } from '../util/env-compat.js';
import {
  createManagedDirectoryBoundary,
  type ManagedDirectoryBoundary,
  type ManagedPathInspection,
} from '../security/managed-directory-boundary.js';
import {
  appendPrivateManagedFile,
  readPrivateManagedFile,
  syncPrivateManagedFile,
  writePrivateManagedFile,
} from '../security/managed-private-file.js';

export type JsonlWriterOptions = {
  maxBytes?: unknown;
  maxFiles?: unknown;
};

// 审计/事件日志会持续增长,因此写入前按大小轮转:当前文件进入 .1,旧代后移,超出 maxFiles 的最旧代丢弃。
// 默认阈值可通过环境变量调优。
const DEFAULT_MAX_BYTES = Number(readCompatEnv(process.env, 'ACW_LOG_MAX_BYTES', 'KCW_LOG_MAX_BYTES') || 8 * 1024 * 1024);
const DEFAULT_MAX_FILES = Math.max(1, Number(readCompatEnv(process.env, 'ACW_LOG_MAX_FILES', 'KCW_LOG_MAX_FILES') || 3));

function isNotFound(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'ENOENT';
}

function temporarySibling(filePath: string, label: string): string {
  return path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${label}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
}

function sameFileNode(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino
    && left.isFile() && right.isFile();
}

/** 追加式 JSONL 写入器:append 逐行写入,超阈值时按代轮转。 */
export class JsonlWriter {
  readonly filePath: string;
  readonly maxBytes: number;
  readonly maxFiles: number;
  private readonly boundary: ManagedDirectoryBoundary;

  constructor(filePath: string, { maxBytes = DEFAULT_MAX_BYTES, maxFiles = DEFAULT_MAX_FILES }: JsonlWriterOptions = {}) {
    this.filePath = path.resolve(filePath);
    this.maxBytes = Math.max(1, Number(maxBytes) || DEFAULT_MAX_BYTES);
    this.maxFiles = Math.max(1, Number(maxFiles) || DEFAULT_MAX_FILES);
    this.boundary = createManagedDirectoryBoundary(path.dirname(this.filePath), {
      create: true,
      label: 'JSONL writer directory',
    });
  }

  private inspect(filePath: string, guard: (candidatePath: string) => void): ManagedPathInspection | null {
    guard(filePath);
    return this.boundary.inspectPath(filePath, { allowMissing: true, kind: 'file' });
  }

  private renameManaged(source: string, destination: string, guard: (candidatePath: string) => void): void {
    const before = this.inspect(source, guard);
    if (!before) throw new Error('JSONL rotation source disappeared');
    this.inspect(destination, guard);
    guard(source);
    this.boundary.revalidatePath(source, before, { kind: 'file' });
    guard(destination);
    fs.renameSync(before.canonicalPath, destination);
    guard(destination);
    const after = this.boundary.inspectPath(destination, { kind: 'file' });
    if (!after || !sameFileNode(before.stats, after.stats)) {
      throw new Error('JSONL rotation destination changed during operation');
    }
  }

  private unlinkManaged(filePath: string, guard: (candidatePath: string) => void): void {
    const before = this.inspect(filePath, guard);
    if (!before) return;
    this.boundary.revalidatePath(filePath, before, { kind: 'file' });
    fs.unlinkSync(before.canonicalPath);
    guard(filePath);
    if (this.boundary.inspectPath(filePath, { allowMissing: true, kind: 'file' })) {
      throw new Error('JSONL temporary file survived cleanup');
    }
  }

  _rotateIfNeeded(line: string, guard = this.boundary.createMutationGuard()): boolean {
    const live = this.inspect(this.filePath, guard);
    if (!live) return false;
    if (live.stats.size + Buffer.byteLength(line, 'utf8') <= this.maxBytes) return false;

    const staged: Array<{ tempPath: string; destination: string }> = [];
    try {
      for (let i = this.maxFiles - 1; i >= 1; i -= 1) {
        const source = i === 1 ? this.filePath : `${this.filePath}.${i - 1}`;
        const sourceIdentity = this.inspect(source, guard);
        if (!sourceIdentity) continue;
        const destination = `${this.filePath}.${i}`;
        this.inspect(destination, guard);
        const tempPath = temporarySibling(destination, `rotate-${i}`);
        staged.push({ tempPath, destination });
        if (this.inspect(tempPath, guard)) throw new Error('JSONL rotation temp already exists');
        this.boundary.revalidatePath(source, sourceIdentity, { kind: 'file' });
        guard(tempPath);
        fs.copyFileSync(sourceIdentity.canonicalPath, tempPath);
        guard(source);
        this.boundary.revalidatePath(source, sourceIdentity, { kind: 'file' });
        if (!this.inspect(tempPath, guard)) throw new Error('JSONL rotation copy disappeared');
        syncPrivateManagedFile(this.boundary, tempPath, guard);
      }

      const liveTemp = temporarySibling(this.filePath, 'live');
      staged.push({ tempPath: liveTemp, destination: this.filePath });
      writePrivateManagedFile(this.boundary, liveTemp, line, guard);

      for (const item of staged.slice(0, -1)) {
        this.renameManaged(item.tempPath, item.destination, guard);
      }
      this.renameManaged(liveTemp, this.filePath, guard);
      return true;
    } catch (error) {
      for (const item of staged) {
        try { this.unlinkManaged(item.tempPath, guard); } catch (cleanupError) {
          if (!isNotFound(cleanupError)) {
            Object.defineProperty(error as object, 'cleanupFailure', {
              value: cleanupError,
              enumerable: false,
              configurable: true,
            });
          }
        }
      }
      throw error;
    }
  }

  /**
   * 通过写入器已固定的目录边界读取当前文件。
   */
  readCurrentText(): string | null {
    const guard = this.boundary.createMutationGuard();
    return readPrivateManagedFile(this.boundary, this.filePath, guard);
  }

  /**
   * 将一条记录序列化为一行 JSON 追加写入(必要时先轮转、自动建目录)。
   */
  append(record: unknown): void {
    const serialized = JSON.stringify(record);
    if (typeof serialized !== 'string') {
      throw new TypeError('JSONL record must be JSON serializable');
    }
    const line = `${serialized}\n`;
    const guard = this.boundary.createMutationGuard();
    if (!this._rotateIfNeeded(line, guard)) {
      appendPrivateManagedFile(this.boundary, this.filePath, line, guard);
    }
  }
}
