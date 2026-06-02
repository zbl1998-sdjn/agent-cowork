// 工作区搜索 API(UI · 传输层 · lib/api)
// ---------------------------------------------------------------------------
// 职责:在可信工作区根目录内检索文件内容,返回命中分块与来源引用。
// 对应路由:/api/workspace/search。导出:searchWorkspace、WorkspaceSearchResult/Chunk 类型。
import { postJson } from './transport';
import type { SourceRef } from '../types';

export interface WorkspaceSearchChunk {
  id: string;
  sourcePath: string;
  startLine: number;
  endLine: number;
  text: string;
}

export interface WorkspaceSearchResult {
  query: string;
  root: string;
  indexedFiles: number;
  chunks: WorkspaceSearchChunk[];
  sources: SourceRef[];
}

export function searchWorkspace(
  query: string,
  opts: { trustedRoot?: string; limit?: number; maxFiles?: number; maxFileBytes?: number } = {},
): Promise<WorkspaceSearchResult> {
  return postJson('/api/workspace/search', {
    query,
    trustedRoot: opts.trustedRoot,
    limit: opts.limit,
    maxFiles: opts.maxFiles,
    maxFileBytes: opts.maxFileBytes,
  });
}
