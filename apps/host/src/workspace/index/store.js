import path from 'node:path';
import { assertTrustedPath } from '../../security/path-policy.js';
import { chunkText } from './chunk.js';

const DEFAULT_LIMIT = 20;

function tokenize(value) {
  return String(value || '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter(Boolean);
}

function normalizeQuery(input) {
  if (typeof input === 'string') return { query: input };
  return input || {};
}

function chunkScore(chunk, terms) {
  const haystack = `${chunk.text}\n${path.basename(chunk.sourcePath)}`.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (!term) continue;
    let pos = haystack.indexOf(term);
    while (pos !== -1) {
      score += 1;
      pos = haystack.indexOf(term, pos + term.length);
    }
  }
  return score;
}

function sourcesFor(chunks) {
  const seen = new Set();
  const sources = [];
  for (const chunk of chunks) {
    const key = `${chunk.sourcePath}:${chunk.startLine}:${chunk.endLine}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sources.push({ path: chunk.sourcePath, startLine: chunk.startLine, endLine: chunk.endLine });
  }
  return sources;
}

export function createWorkspaceIndex({ root } = {}) {
  if (typeof root !== 'string' || root.length === 0) {
    throw new Error('root is required');
  }
  const trustedRoot = assertTrustedPath(path.resolve(root), path.resolve(root));
  const byPath = new Map();

  function normalizePath(candidate) {
    return assertTrustedPath(candidate, trustedRoot);
  }

  return {
    root: trustedRoot,

    upsert({ path: filePath, text, chunks, maxChunkLines, maxChunkBytes } = {}) {
      const sourcePath = normalizePath(filePath);
      const nextChunks = Array.isArray(chunks)
        ? chunks.map((chunk, index) => ({
          ...chunk,
          id: chunk.id || `${sourcePath}:${chunk.startLine}-${chunk.endLine}:${index}`,
          sourcePath,
        }))
        : chunkText({ sourcePath, text: String(text || ''), maxChunkLines, maxChunkBytes });
      byPath.set(sourcePath, nextChunks);
      return nextChunks;
    },

    remove(filePath) {
      const sourcePath = normalizePath(filePath);
      return byPath.delete(sourcePath);
    },

    search(input = {}) {
      const { query, limit = DEFAULT_LIMIT } = normalizeQuery(input);
      const terms = tokenize(query);
      if (!terms.length) return { chunks: [], sources: [] };

      const scored = [];
      for (const chunks of byPath.values()) {
        for (const chunk of chunks) {
          const score = chunkScore(chunk, terms);
          if (score > 0) scored.push({ chunk, score });
        }
      }

      scored.sort((a, b) =>
        b.score - a.score ||
        a.chunk.sourcePath.localeCompare(b.chunk.sourcePath) ||
        a.chunk.startLine - b.chunk.startLine);

      const chunks = scored.slice(0, Math.max(1, limit)).map(({ chunk }) => ({ ...chunk }));
      return { chunks, sources: sourcesFor(chunks) };
    },

    chunks() {
      return [...byPath.values()].flat().map((chunk) => ({ ...chunk }));
    },
  };
}
