// 工作区内存索引(host · L1 领域层 · workspace/index)
// ---------------------------------------------------------------------------
// 职责:按文件维护「分块 + 关键词打分检索」的内存索引。upsert 入块、remove 删文件、search 按词
//       频打分排序返回相关块与来源。路径一律经可信根校验。纯内存、无持久化(随进程生命周期)。
// 依赖:L0 path-policy + 同目录 chunk。导出:createWorkspaceIndex。
import path from 'node:path';
import { assertTrustedPath } from '../../security/path-policy.js';
import { omitUndefined } from '../../util/object.js';
import { chunkText, type WorkspaceChunk } from './chunk.js';

export type UpsertInput = { path?: unknown; text?: unknown; chunks?: WorkspaceChunk[]; maxChunkLines?: number; maxChunkBytes?: number };
export type SearchInput = { query?: unknown; limit?: number };
export type ChunkSource = { path: string; startLine: number; endLine: number };
export type SearchResult = { chunks: WorkspaceChunk[]; sources: ChunkSource[] };
export type WorkspaceIndex = {
  root: string;
  upsert(input?: UpsertInput): WorkspaceChunk[];
  remove(filePath: string): boolean;
  search(input?: SearchInput | string): SearchResult;
  chunks(): WorkspaceChunk[];
};

const DEFAULT_LIMIT = 20;

function tokenize(value: unknown): string[] {
  return String(value || '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter(Boolean);
}

function normalizeQuery(input: SearchInput | string | undefined): SearchInput {
  if (typeof input === 'string') return { query: input };
  return input || {};
}

function chunkScore(chunk: WorkspaceChunk, terms: string[]): number {
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

function sourcesFor(chunks: WorkspaceChunk[]): ChunkSource[] {
  const seen = new Set<string>();
  const sources: ChunkSource[] = [];
  for (const chunk of chunks) {
    const key = `${chunk.sourcePath}:${chunk.startLine}:${chunk.endLine}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sources.push({ path: chunk.sourcePath, startLine: chunk.startLine, endLine: chunk.endLine });
  }
  return sources;
}

/** 创建按文件分块的内存检索索引(root 经可信根校验),返回 { root, upsert, remove, search, chunks }。 */
export function createWorkspaceIndex({ root }: { root?: unknown } = {}): WorkspaceIndex {
  if (typeof root !== 'string' || root.length === 0) {
    throw new Error('root is required');
  }
  const trustedRoot = assertTrustedPath(path.resolve(root), path.resolve(root));
  const byPath = new Map<string, WorkspaceChunk[]>();

  function normalizePath(candidate: unknown): string {
    return assertTrustedPath(String(candidate || ''), trustedRoot);
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
        : chunkText(omitUndefined({ sourcePath, text: String(text || ''), maxChunkLines, maxChunkBytes }));
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

      const scored: Array<{ chunk: WorkspaceChunk; score: number }> = [];
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
