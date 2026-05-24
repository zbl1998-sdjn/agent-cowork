import { MAX_MEMORY_BYTES } from './memory-constants.js';
import { clipUtf8 } from './memory-utils.js';

export function buildMemorySystemBlockFromText(main, { maxBytes = 4096 } = {}) {
  if (!main.trim()) {
    return '';
  }
  const clipped = clipUtf8(main, Math.max(512, Math.min(MAX_MEMORY_BYTES, maxBytes)));
  return clipped.trim();
}

export function buildMemorySystemBlockFromStore(store, trustedRoot, options = {}) {
  try {
    return buildMemorySystemBlockFromText(store.readMainMemory(trustedRoot, options.context || {}), options);
  } catch {
    return '';
  }
}

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
