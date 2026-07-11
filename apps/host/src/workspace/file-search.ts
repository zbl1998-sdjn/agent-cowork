// 文件名/内容搜索(host · L1 领域层 · workspace)
// ---------------------------------------------------------------------------
// 职责:在工作区内按「文件名」或可选的「文件内容」做关键词命中,返回命中文件及内容摘录。
//       与 index/ 的 RAG 检索不同,这里是即时线性扫描;单文件解析失败不影响整体。
// 依赖:同层 file-tree / document-extractor。导出:searchWorkspace。
import path from 'node:path';
import { listWorkspaceTree } from './file-tree.js';
import type { WorkspaceFileEntry } from './file-tree.js';
import { extractDocumentText, isExtractableDocument } from './document-extractor.js';

const DEFAULT_MAX_CONTENT_BYTES = 1024 * 1024;

export type SearchOptions = {
  trustedRoot?: string;
  root?: string;
  query?: unknown;
  maxResults?: number;
  includeContent?: boolean;
  maxContentBytes?: number;
  includeFile?: (fullPath: string) => boolean;
};
export type SearchResult = {
  path: string;
  fullPath: string;
  size: number;
  mtimeMs: number;
  match: 'content' | 'name';
  excerpt: string;
  extension: string;
};

function cap(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.floor(n), min), max);
}

/** 在工作区按文件名(及可选内容)搜索关键词,返回命中结果(含摘录、匹配类型)。 */
export function searchWorkspace(options: SearchOptions = {}): { query: string; results: SearchResult[] } {
  const trustedRoot = options.trustedRoot ?? options.root;
  if (!trustedRoot) {
    throw new Error('trustedRoot is required');
  }
  const query = String(options.query || '').trim().toLowerCase();
  const maxResults = Math.min(Math.max(Number(options.maxResults || 20), 1), 100);
  const includeContent = options.includeContent === true;
  const maxContentBytes = cap(options.maxContentBytes, DEFAULT_MAX_CONTENT_BYTES, 1024, DEFAULT_MAX_CONTENT_BYTES);
  const files = listWorkspaceTree(trustedRoot, {
    includeFiles: true,
    includeDirectories: false,
    includeEntry: (fullPath, kind) => kind !== 'file' || !options.includeFile || options.includeFile(fullPath),
  }).filter((entry): entry is WorkspaceFileEntry => entry.kind === 'file');

  // 空 query:当「引用文件」选择器用——返回最近修改的前 N 个文件,而不是报错。
  // 这样 UI 里点一下「引用文件」按钮(插入裸 @)就能直接弹出文件列表来挑,再继续输入即转为关键词过滤。
  if (!query) {
    const recent = [...files]
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, maxResults)
      .map((file) => ({
        path: file.path,
        fullPath: file.fullPath,
        size: file.size,
        mtimeMs: file.mtimeMs,
        match: 'name' as const,
        excerpt: '',
        extension: path.extname(file.path).toLowerCase(),
      }));
    return { query, results: recent };
  }

  const results: SearchResult[] = [];
  for (const file of files) {
    const nameHit = file.path.toLowerCase().includes(query);
    let contentHit = false;
    let excerpt = '';
    if (includeContent && isExtractableDocument(file.fullPath) && file.size <= maxContentBytes) {
      try {
        const extracted = extractDocumentText(file.fullPath, {
          trustedRoot,
          maxSize: maxContentBytes,
        });
        const content = extracted.content.toLowerCase();
        const index = content.indexOf(query);
        if (index >= 0) {
          contentHit = true;
          excerpt = extracted.content.slice(Math.max(0, index - 60), index + query.length + 100).replace(/\s+/g, ' ').trim();
        }
      } catch {
        // 单个文档无法解析时跳过,搜索整体仍需可用。
      }
    }
    if (nameHit || contentHit) {
      results.push({
        path: file.path,
        fullPath: file.fullPath,
        size: file.size,
        mtimeMs: file.mtimeMs,
        match: contentHit ? 'content' : 'name',
        excerpt,
        extension: path.extname(file.path).toLowerCase(),
      });
    }
    if (results.length >= maxResults) {
      break;
    }
  }
  return {
    query,
    results,
  };
}
