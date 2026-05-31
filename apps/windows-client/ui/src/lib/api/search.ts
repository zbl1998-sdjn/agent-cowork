// 搜索 API(UI · lib/api 传输层):封装 /api/search/* —— 在可信工作区内做文件名/内容或 RAG 检索。
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
