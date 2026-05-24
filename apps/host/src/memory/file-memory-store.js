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

export function readMainMemory(trustedRoot) {
  const memoryFile = mainMemoryPath(trustedRoot);
  if (!fs.existsSync(memoryFile)) {
    return '';
  }
  return fs.readFileSync(memoryFile, 'utf8');
}

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

export function buildMemorySystemBlock(trustedRoot, options = {}) {
  return buildMemorySystemBlockFromStore(fileMemoryApi, trustedRoot, options);
}

export function loadMemoryContext(trustedRoot, options = {}) {
  return loadMemoryContextFromStore(fileMemoryApi, trustedRoot, options);
}

const fileMemoryApi = {
  readMainMemory,
  listMemoryNotes,
  buildMemorySystemBlock,
};

export class FileMemoryStore {
  readMainMemory(trustedRoot) {
    return readMainMemory(trustedRoot);
  }

  listMemoryNotes(trustedRoot) {
    return listMemoryNotes(trustedRoot);
  }

  readMemoryNote(trustedRoot, noteName) {
    return readMemoryNote(trustedRoot, noteName);
  }

  writeMemoryNote(trustedRoot, noteName, body, context = {}) {
    return writeMemoryNote(trustedRoot, noteName, body, context);
  }

  appendMemoryFact(trustedRoot, fact, context = {}) {
    return appendMemoryFact(trustedRoot, fact, context);
  }

  buildMemorySystemBlock(trustedRoot, options = {}) {
    return buildMemorySystemBlock(trustedRoot, options);
  }

  loadMemoryContext(trustedRoot, options = {}) {
    return loadMemoryContext(trustedRoot, options);
  }
}
