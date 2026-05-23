import fs from 'node:fs';
import path from 'node:path';

// Append-only JSONL writer with size-based rotation. Audit/event logs grow
// without bound otherwise; here, once the file would exceed `maxBytes` we shift
// `file -> file.1 -> file.2 ...` (dropping the oldest beyond `maxFiles`) and
// start a fresh file. Defaults are overridable via env for ops tuning.
const DEFAULT_MAX_BYTES = Number(process.env.KCW_LOG_MAX_BYTES || 8 * 1024 * 1024);
const DEFAULT_MAX_FILES = Math.max(1, Number(process.env.KCW_LOG_MAX_FILES || 3));

export class JsonlWriter {
  constructor(filePath, { maxBytes = DEFAULT_MAX_BYTES, maxFiles = DEFAULT_MAX_FILES } = {}) {
    this.filePath = filePath;
    this.maxBytes = Math.max(1, Number(maxBytes) || DEFAULT_MAX_BYTES);
    this.maxFiles = Math.max(1, Number(maxFiles) || DEFAULT_MAX_FILES);
  }

  _rotateIfNeeded(incomingBytes) {
    let size = 0;
    try { size = fs.statSync(this.filePath).size; } catch { return; } // not created yet
    if (size + incomingBytes <= this.maxBytes) return;
    // Shift older generations (.N-1 -> .N), then copy current -> .1 and truncate
    // it. We copy+truncate rather than rename because on Windows rename can't
    // overwrite and its delete is async (rename-after-delete races); copyFileSync
    // overwrites cleanly and is deterministic.
    for (let i = this.maxFiles - 1; i >= 1; i -= 1) {
      const src = i === 1 ? this.filePath : `${this.filePath}.${i - 1}`;
      const dst = `${this.filePath}.${i}`;
      try { if (fs.existsSync(src)) fs.copyFileSync(src, dst); } catch { /* best-effort */ }
    }
    try { fs.writeFileSync(this.filePath, ''); } catch { /* best-effort */ }
  }

  append(record) {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const line = `${JSON.stringify(record)}\n`;
    this._rotateIfNeeded(Buffer.byteLength(line, 'utf8'));
    fs.appendFileSync(this.filePath, line, 'utf8');
  }
}
