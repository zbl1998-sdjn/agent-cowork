// @ts-check

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

export class JsonStore {
  /**
   * @param {string} filePath
   * @param {JsonStoreOptions} [options]
   */
  constructor(filePath, options = {}) {
    this.filePath = filePath;
    this.defaults = options.defaults ?? {};
  }

  /** @returns {any} */
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

  /** @param {any} data */
  save(data) {
    const serializable = normalizeData(data);
    writeAtomic(this.filePath, JSON.stringify(serializable, null, 2));
    return serializable;
  }

  /** @param {(current: Record<string, any>) => any} mutator */
  update(mutator) {
    const current = this.load();
    const next = mutator({ ...current });
    return this.save(next);
  }
}
