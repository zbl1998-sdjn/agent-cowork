// 追加式 JSONL 写入器(按大小轮转)(host · L1 领域层 · storage)
// ---------------------------------------------------------------------------
// 职责:逐行追加 JSON 记录到日志文件;文件将超过 maxBytes 时按 file→file.1→file.2…
//       轮转(超出 maxFiles 的最旧代丢弃),防止审计/事件日志无限膨胀。
// 依赖:仅标准库(fs/path)。后端:本地文件系统。
// 导出:JsonlWriter(类)。
import fs from 'node:fs';
import path from 'node:path';

export type JsonlWriterOptions = {
  maxBytes?: unknown;
  maxFiles?: unknown;
};

// 审计/事件日志会持续增长,因此写入前按大小轮转:当前文件进入 .1,旧代后移,超出 maxFiles 的最旧代丢弃。
// 默认阈值可通过环境变量调优。
const DEFAULT_MAX_BYTES = Number(process.env.KCW_LOG_MAX_BYTES || 8 * 1024 * 1024);
const DEFAULT_MAX_FILES = Math.max(1, Number(process.env.KCW_LOG_MAX_FILES || 3));

/** 追加式 JSONL 写入器:append 逐行写入,超阈值时按代轮转。 */
export class JsonlWriter {
  readonly filePath: string;
  readonly maxBytes: number;
  readonly maxFiles: number;

  constructor(filePath: string, { maxBytes = DEFAULT_MAX_BYTES, maxFiles = DEFAULT_MAX_FILES }: JsonlWriterOptions = {}) {
    this.filePath = filePath;
    this.maxBytes = Math.max(1, Number(maxBytes) || DEFAULT_MAX_BYTES);
    this.maxFiles = Math.max(1, Number(maxFiles) || DEFAULT_MAX_FILES);
  }

  _rotateIfNeeded(incomingBytes: number): void {
    let size = 0;
    try { size = fs.statSync(this.filePath).size; } catch { return; } // 文件尚未创建。
    if (size + incomingBytes <= this.maxBytes) return;
    // 先移动旧代(.N-1 -> .N),再复制当前文件为 .1 并截断。
    // Windows rename 覆盖/删除存在竞态,copy+truncate 更确定。
    for (let i = this.maxFiles - 1; i >= 1; i -= 1) {
      const src = i === 1 ? this.filePath : `${this.filePath}.${i - 1}`;
      const dst = `${this.filePath}.${i}`;
      try { if (fs.existsSync(src)) fs.copyFileSync(src, dst); } catch { /* 尽力轮转 */ }
    }
    try { fs.writeFileSync(this.filePath, ''); } catch { /* 尽力轮转 */ }
  }

  /**
   * 将一条记录序列化为一行 JSON 追加写入(必要时先轮转、自动建目录)。
   */
  append(record: unknown): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const line = `${JSON.stringify(record)}\n`;
    this._rotateIfNeeded(Buffer.byteLength(line, 'utf8'));
    fs.appendFileSync(this.filePath, line, 'utf8');
  }
}
