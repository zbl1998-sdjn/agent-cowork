// 工作区检索(host · L1 领域层 · workspace/index)
// ---------------------------------------------------------------------------
// 职责:SearchWorkspace 工具的实现——遍历可信工作区内可提取的文档,抽取文本、切块入检索器,
//       再按查询返回相关文本块与来源(路径/行号/摘要)。单个文件读取/解析失败不影响整体检索。
// 依赖:同层 retriever/chunk + workspace file-tree/document-extractor。导出:searchWorkspaceIndex。
import path from 'node:path';
import { listWorkspaceTree } from '../file-tree.js';
import { extractDocumentText, isExtractableDocument } from '../document-extractor.js';
import { createWorkspaceRetriever } from './retriever.js';

/**
 * @typedef {import('./chunk.js').WorkspaceChunk} WorkspaceChunk
 * @typedef {{ root?: unknown, query?: unknown, limit?: unknown, maxFiles?: unknown, maxFileBytes?: unknown, maxChunkLines?: number, maxChunkBytes?: number }} SearchWorkspaceOptions
 */

const DEFAULT_MAX_FILES = 400;
const DEFAULT_MAX_FILE_BYTES = 512 * 1024;
const DEFAULT_LIMIT = 10;

/** @param {unknown} value @param {number} fallback @param {number} min @param {number} max @returns {number} */
function cap(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.floor(n), min), max);
}

/** @param {string} root @param {WorkspaceChunk} chunk */
function sourceFromChunk(root, chunk) {
  return {
    path: chunk.sourcePath,
    relativePath: path.relative(root, chunk.sourcePath).replace(/\\/g, '/'),
    startLine: chunk.startLine,
    endLine: chunk.endLine,
    excerpt: String(chunk.text || '').replace(/\s+/g, ' ').trim().slice(0, 240),
  };
}

/** 在工作区内做关键词/RAG 检索:列文件→抽取文本→入检索器→查询,返回 { chunks, sources, indexedFiles }。 @param {SearchWorkspaceOptions} [options] */
export function searchWorkspaceIndex({
  root,
  query,
  limit = DEFAULT_LIMIT,
  maxFiles = DEFAULT_MAX_FILES,
  maxFileBytes = DEFAULT_MAX_FILE_BYTES,
  maxChunkLines = 24,
  maxChunkBytes = 4096,
} = {}) {
  const q = String(query || '').trim();
  if (!q) {
    throw new Error('query is required');
  }
  const retriever = createWorkspaceRetriever({ root });
  const trustedRoot = retriever.root;
  const fileLimit = cap(maxFiles, DEFAULT_MAX_FILES, 1, 5000);
  const byteLimit = cap(maxFileBytes, DEFAULT_MAX_FILE_BYTES, 1024, 5 * 1024 * 1024);
  const files = listWorkspaceTree(trustedRoot, {
    includeFiles: true,
    includeDirectories: false,
    maxEntries: fileLimit,
  }).filter((entry) => entry.kind === 'file' && entry.size <= byteLimit && isExtractableDocument(entry.fullPath));

  let indexedFiles = 0;
  for (const file of files.slice(0, fileLimit)) {
    try {
      const extracted = extractDocumentText(file.fullPath, { trustedRoot, maxSize: byteLimit });
      if (!extracted.content) continue;
      retriever.upsert({
        path: file.fullPath,
        text: extracted.content,
        maxChunkLines,
        maxChunkBytes,
      });
      indexedFiles += 1;
    } catch {
      // A single unreadable or unparsable file must not break workspace search.
    }
  }

  const result = retriever.search(q, { limit: cap(limit, DEFAULT_LIMIT, 1, 100) });
  return {
    query: q,
    root: trustedRoot,
    indexedFiles,
    chunks: result.chunks,
    sources: result.chunks.map((chunk) => sourceFromChunk(trustedRoot, chunk)),
  };
}
