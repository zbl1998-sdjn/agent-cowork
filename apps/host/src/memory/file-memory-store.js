// @ts-check

import fs from 'node:fs';
import path from 'node:path';
import { assertTrustedPath } from '../security/path-policy.js';
import {
  MAX_MEMORY_BYTES,
  MEMORY_HEADER,
  NOTE_NAME_RE,
} from './memory-constants.js';
import { appendAuditEvent } from './memory-audit.js';
import {
  cleanFactKey,
  cleanFactValue,
  cleanScope,
  clipUtf8,
  ensureTrustedRoot,
  mainMemoryPath,
  notesDir,
  safeWriteSync,
} from './memory-utils.js';
import {
  buildMemorySystemBlockFromStore,
  loadMemoryContextFromStore,
} from './memory-query.js';

/**
 * @typedef {'project' | 'user' | 'session'} MemoryScope
 * @typedef {{ key?: unknown, value?: unknown, scope?: unknown }} MemoryFactInput
 * @typedef {{ key: string, value: string, scope: MemoryScope }} MemoryFact
 * @typedef {{ traceId?: unknown, tenantId?: unknown, userId?: unknown, idempotencyKey?: unknown, auditBus?: import('../storage/audit-events.js').AuditEventBus }} MemoryContext
 * @typedef {{ maxBytes?: number, context?: MemoryContext }} MemoryQueryOptions
 * @typedef {{ name: string, size: number, modifiedAt: string, path?: string }} MemoryNote
 */

/**
 * @param {unknown} trustedRoot
 * @returns {string}
 */
export function readMainMemory(trustedRoot) {
  const memoryFile = mainMemoryPath(trustedRoot);
  if (!fs.existsSync(memoryFile)) {
    return '';
  }
  return fs.readFileSync(memoryFile, 'utf8');
}

/**
 * @param {unknown} trustedRoot
 * @returns {MemoryNote[]}
 */
export function listMemoryNotes(trustedRoot) {
  const dir = notesDir(trustedRoot);
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir)
    .filter((name) => NOTE_NAME_RE.test(name))
    .map((name) => {
      const full = path.join(dir, name);
      const stat = fs.statSync(full);
      return {
        name,
        size: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        path: full,
      };
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * @param {unknown} trustedRoot
 * @param {string} noteName
 * @returns {string | null}
 */
export function readMemoryNote(trustedRoot, noteName) {
  if (!NOTE_NAME_RE.test(String(noteName || ''))) {
    throw new Error('Invalid memory note name');
  }
  const file = path.join(notesDir(trustedRoot), noteName);
  if (!fs.existsSync(file)) {
    return null;
  }
  return fs.readFileSync(file, 'utf8');
}

/**
 * @param {unknown} trustedRoot
 * @param {string} noteName
 * @param {unknown} body
 * @param {MemoryContext} [context]
 * @returns {string}
 */
export function writeMemoryNote(trustedRoot, noteName, body, context = {}) {
  if (!NOTE_NAME_RE.test(String(noteName || ''))) {
    throw new Error('Invalid memory note name');
  }
  const root = ensureTrustedRoot(trustedRoot);
  const file = path.join(notesDir(root), noteName);
  assertTrustedPath(file, root);
  const safeBody = clipUtf8(String(body == null ? '' : body), MAX_MEMORY_BYTES);
  safeWriteSync(file, safeBody);
  appendAuditEvent(root, {
    action: 'memory_note_write',
    note: noteName,
    size: Buffer.byteLength(safeBody, 'utf8'),
    traceId: context.traceId,
    tenantId: context.tenantId,
    userId: context.userId,
  }, context);
  return file;
}

/**
 * @param {unknown} trustedRoot
 * @param {MemoryFactInput} fact
 * @param {MemoryContext} [context]
 * @returns {{ file: string, fact: MemoryFact }}
 */
export function appendMemoryFact(trustedRoot, fact, context = {}) {
  const root = ensureTrustedRoot(trustedRoot);
  const file = mainMemoryPath(root);
  assertTrustedPath(file, root);
  const key = cleanFactKey(fact?.key);
  const value = cleanFactValue(fact?.value);
  const scope = cleanScope(fact?.scope);
  const line = `- **${key}** (${scope}): ${value}\n`;
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const seed = current
    ? current.endsWith('\n')
      ? current
      : `${current}\n`
    : MEMORY_HEADER;
  const next = clipUtf8(`${seed}${line}`, MAX_MEMORY_BYTES);
  safeWriteSync(file, next);
  appendAuditEvent(root, {
    action: 'memory_fact_append',
    key,
    scope,
    size: Buffer.byteLength(value, 'utf8'),
    traceId: context.traceId,
    tenantId: context.tenantId,
    userId: context.userId,
    idempotencyKey: context.idempotencyKey,
  }, context);
  return {
    file,
    fact: { key, value, scope },
  };
}

/**
 * @param {unknown} trustedRoot
 * @param {MemoryQueryOptions} [options]
 * @returns {string}
 */
export function buildMemorySystemBlock(trustedRoot, options = {}) {
  return buildMemorySystemBlockFromStore(fileMemoryApi, trustedRoot, options);
}

/**
 * @param {unknown} trustedRoot
 * @param {MemoryQueryOptions} [options]
 * @returns {{ enabled: boolean, bytes: number, text: string, notes: MemoryNote[] }}
 */
export function loadMemoryContext(trustedRoot, options = {}) {
  return loadMemoryContextFromStore(fileMemoryApi, trustedRoot, options);
}

/** @type {import('./memory-query.js').SyncMemoryStoreLike} */
const fileMemoryApi = {
  readMainMemory,
  listMemoryNotes,
  buildMemorySystemBlock,
};

export class FileMemoryStore {
  /** @param {unknown} trustedRoot @returns {string} */
  readMainMemory(trustedRoot) {
    return readMainMemory(trustedRoot);
  }

  /** @param {unknown} trustedRoot @returns {MemoryNote[]} */
  listMemoryNotes(trustedRoot) {
    return listMemoryNotes(trustedRoot);
  }

  /** @param {unknown} trustedRoot @param {string} noteName @returns {string | null} */
  readMemoryNote(trustedRoot, noteName) {
    return readMemoryNote(trustedRoot, noteName);
  }

  /** @param {unknown} trustedRoot @param {string} noteName @param {unknown} body @param {MemoryContext} [context] @returns {string} */
  writeMemoryNote(trustedRoot, noteName, body, context = {}) {
    return writeMemoryNote(trustedRoot, noteName, body, context);
  }

  /** @param {unknown} trustedRoot @param {MemoryFactInput} fact @param {MemoryContext} [context] @returns {{ file: string, fact: MemoryFact }} */
  appendMemoryFact(trustedRoot, fact, context = {}) {
    return appendMemoryFact(trustedRoot, fact, context);
  }

  /** @param {unknown} trustedRoot @param {MemoryQueryOptions} [options] @returns {string} */
  buildMemorySystemBlock(trustedRoot, options = {}) {
    return buildMemorySystemBlock(trustedRoot, options);
  }

  /** @param {unknown} trustedRoot @param {MemoryQueryOptions} [options] @returns {{ enabled: boolean, bytes: number, text: string, notes: MemoryNote[] }} */
  loadMemoryContext(trustedRoot, options = {}) {
    return loadMemoryContext(trustedRoot, options);
  }
}
