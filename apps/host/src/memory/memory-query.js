// @ts-check

import { MAX_MEMORY_BYTES } from './memory-constants.js';
import { clipUtf8 } from './memory-utils.js';

/**
 * @typedef {{ name: string, size: number, modifiedAt: string, path?: string }} MemoryNote
 * @typedef {{ readMainMemory(trustedRoot: unknown, context?: Record<string, unknown>): string, buildMemorySystemBlock(trustedRoot: unknown, options?: MemoryQueryOptions): string, listMemoryNotes(trustedRoot: unknown, context?: Record<string, unknown>): MemoryNote[] }} SyncMemoryStoreLike
 * @typedef {{ maxBytes?: number, context?: Record<string, unknown> }} MemoryQueryOptions
 */

/**
 * @param {string} main
 * @param {{ maxBytes?: number }} [options]
 * @returns {string}
 */
export function buildMemorySystemBlockFromText(main, { maxBytes = 4096 } = {}) {
  if (!main.trim()) {
    return '';
  }
  const clipped = clipUtf8(main, Math.max(512, Math.min(MAX_MEMORY_BYTES, maxBytes)));
  return clipped.trim();
}

/**
 * @param {SyncMemoryStoreLike} store
 * @param {unknown} trustedRoot
 * @param {MemoryQueryOptions} [options]
 * @returns {string}
 */
export function buildMemorySystemBlockFromStore(store, trustedRoot, options = {}) {
  try {
    return buildMemorySystemBlockFromText(store.readMainMemory(trustedRoot, options.context || {}), options);
  } catch {
    return '';
  }
}

/**
 * @param {SyncMemoryStoreLike} store
 * @param {unknown} trustedRoot
 * @param {MemoryQueryOptions} [options]
 * @returns {{ enabled: boolean, bytes: number, text: string, notes: MemoryNote[] }}
 */
export function loadMemoryContextFromStore(store, trustedRoot, { maxBytes = 4096, context = {} } = {}) {
  const block = store.buildMemorySystemBlock(trustedRoot, { maxBytes, context });
  const notes = store.listMemoryNotes(trustedRoot, context).map((note) => ({
    name: note.name,
    size: note.size,
    modifiedAt: note.modifiedAt,
  }));
  return {
    enabled: Boolean(block),
    bytes: Buffer.byteLength(block, 'utf8'),
    text: block,
    notes,
  };
}
