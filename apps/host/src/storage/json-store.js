// @ts-check
// 单文件 JSON 文档存储(原子写)(host · L1 领域层 · storage)
// ---------------------------------------------------------------------------
// 职责:把一份 JSON 文档读写到磁盘——load 读取(空/缺省返回 defaults,坏 JSON 抛错),
//       save 走临时文件+rename 的原子写,update 读-改-写。后端:本地文件系统。
// 依赖:仅标准库(fs/path)。
// 导出:JsonStore(类)。

import fs from 'node:fs';
import path from 'node:path';

/**
 * @typedef {{ defaults?: any }} JsonStoreOptions
 */

/** @param {any} data */
function normalizeData(data) {
  return data === undefined ? {} : data;
}

/**
 * 原子写:先写 .tmp 再 rename 覆盖目标,避免半截写入污染文件。
 * @param {string} filePath
 * @param {string} payload
 */
function writeAtomic(filePath, payload) {
  const dir = path.dirname(filePath);
  const tempPath = `${filePath}.tmp`;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(tempPath, payload, 'utf8');
  fs.renameSync(tempPath, filePath);
}

/** 单文件 JSON 文档存储:提供 load/save/update,save 为原子写。 */
export class JsonStore {
  /**
   * @param {string} filePath
   * @param {JsonStoreOptions} [options]
   */
  constructor(filePath, options = {}) {
    this.filePath = filePath;
    this.defaults = options.defaults ?? {};
  }

  /** 读取文档:文件缺失或空白返回 defaults,JSON 非法则抛错。 @returns {any} */
  load() {
    if (!fs.existsSync(this.filePath)) {
      return normalizeData(this.defaults);
    }

    const raw = fs.readFileSync(this.filePath, 'utf8');
    if (!raw.trim()) {
      return normalizeData(this.defaults);
    }

    try {
      return JSON.parse(raw);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Invalid JSON store at ${this.filePath}: ${message}`);
    }
  }

  /** 原子写入文档(缩进 2),返回规范化后的数据。 @param {any} data */
  save(data) {
    const serializable = normalizeData(data);
    writeAtomic(this.filePath, JSON.stringify(serializable, null, 2));
    return serializable;
  }

  /** 读-改-写:把当前文档的浅拷贝交给 mutator,保存其返回值。 @param {(current: Record<string, any>) => any} mutator */
  update(mutator) {
    const current = this.load();
    const next = mutator({ ...current });
    return this.save(next);
  }
}
