// @ts-check

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
 * @param {CreateMemoryStoreOptions} [options]
 * @returns {FileMemoryStore | SqliteMemoryStore}
 */
export function createMemoryStore({ backend = 'file', dbPath, db, now } = {}) {
  if (backend === 'sqlite') {
    return new SqliteMemoryStore({ dbPath, db, now });
  }
  return new FileMemoryStore();
}
