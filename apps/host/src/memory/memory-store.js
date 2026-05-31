// @ts-check
// 记忆层对外门面:聚合再导出 + 后端工厂(host · L1 领域层 · memory)
// ---------------------------------------------------------------------------
// 职责:作为 memory 模块对上层(runtime/routes)的唯一入口,再导出常量/审计/
//       file 后端函数族/sqlite 后端/用户 profile,并提供 createMemoryStore 按后端
//       选型装配。这是 P0 拆分上帝类后保留的薄门面,自身不含业务逻辑。
// 依赖:同目录子模块(memory-constants/memory-audit/file-memory-store/
//       sqlite-memory-store/profile)。
// 导出:MEMORY_LIMITS、flushMemoryAuditEvents、File 后端函数族、SqliteMemoryStore、
//       UserProfile/createUserProfile、createMemoryStore。

export { MEMORY_LIMITS } from './memory-constants.js';
export { flushMemoryAuditEvents } from './memory-audit.js';
export {
  FileMemoryStore,
  appendMemoryFact,
  buildMemorySystemBlock,
  listMemoryNotes,
  loadMemoryContext,
  readMainMemory,
  readMemoryNote,
  writeMemoryNote,
} from './file-memory-store.js';
export { SqliteMemoryStore } from './sqlite-memory-store.js';
export { UserProfile, createUserProfile } from './profile.js';

import { FileMemoryStore } from './file-memory-store.js';
import { SqliteMemoryStore } from './sqlite-memory-store.js';

/**
 * @typedef {{ backend?: 'file' | 'sqlite' | string, dbPath?: string, db?: import('../storage/sqlite.js').SqliteDatabase | null, now?: () => Date }} CreateMemoryStoreOptions
 */

/**
 * 按 backend 选项装配记忆后端:sqlite 走数据库实现,其余一律回落到文件实现。
 * @param {CreateMemoryStoreOptions} [options]
 * @returns {FileMemoryStore | SqliteMemoryStore}
 */
export function createMemoryStore({ backend = 'file', dbPath, db, now } = {}) {
  if (backend === 'sqlite') {
    return new SqliteMemoryStore({ dbPath, db, now });
  }
  return new FileMemoryStore();
}
