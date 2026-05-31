// 工作区文件树(host · L1 领域层 · workspace)
// ---------------------------------------------------------------------------
// 职责:遍历可信工作区目录树,返回文件/目录条目。遍历有界(深度/条数硬上限)防止超大工作区耗内存或卡 UI;
//       跳过被忽略路径(隐藏/依赖/产物/敏感)与符号链接;单个不可读文件跳过不致命。
// 依赖:L0 path-policy。导出:listWorkspaceTree。
import fs from 'node:fs';
import path from 'node:path';
import { assertTrustedPath, isWorkspaceIgnoredPath } from '../security/path-policy.js';

export type WorkspaceTreeOptions = {
  includeFiles?: boolean;
  includeDirectories?: boolean;
  maxDepth?: number;
  maxEntries?: number;
};
export type WorkspaceDirectoryEntry = { path: string; fullPath: string; kind: 'directory' };
export type WorkspaceFileEntry = { path: string; fullPath: string; kind: 'file'; size: number; mtimeMs: number };
export type WorkspaceTreeEntry = WorkspaceDirectoryEntry | WorkspaceFileEntry;
type PendingTreeNode = { absPath: string; depth: number };

/**
 * 列出工作区文件树(深度优先,深度/条数有上限),返回按路径排序的文件/目录条目。
 */
export function listWorkspaceTree(trustedRoot: string, options: WorkspaceTreeOptions = {}): WorkspaceTreeEntry[] {
  const root = assertTrustedPath(path.resolve(trustedRoot), trustedRoot);
  const includeFiles = options.includeFiles !== false;
  const includeDirs = options.includeDirectories !== false;
  // Bound the traversal so a huge/deep workspace can't exhaust memory or hang the
  // UI (the listing is unbounded otherwise). Caller-overridable, hard-capped.
  const maxDepth = Math.min(Math.max(1, Number(options.maxDepth ?? 8)), 20);
  const maxEntries = Math.min(Math.max(1, Number(options.maxEntries ?? 5000)), 20000);
  const results: WorkspaceTreeEntry[] = [];

  const stack: PendingTreeNode[] = [{ absPath: root, depth: 0 }];

  while (stack.length > 0) {
    if (results.length >= maxEntries) break;
    const nextNode = stack.pop();
    if (!nextNode) break;
    const { absPath, depth } = nextNode;
    const stat = fs.statSync(absPath);
    if (!stat.isDirectory()) {
      throw new Error(`Expected workspace root directory, got file: ${absPath}`);
    }

    if (depth > 0 && includeDirs) {
      results.push({
        path: path.relative(root, absPath) || '.',
        fullPath: absPath,
        kind: 'directory',
      });
    }

    const entries = fs.readdirSync(absPath, { withFileTypes: true });
    for (const entry of entries) {
      const name = entry.name;
      const next = path.join(absPath, name);

      if (isWorkspaceIgnoredPath(next, root)) {
        continue;
      }
      if (entry.isSymbolicLink()) {
        continue;
      }

      if (entry.isDirectory()) {
        if (depth + 1 <= maxDepth) stack.push({ absPath: next, depth: depth + 1 });
        continue;
      }

      if (!includeFiles || !entry.isFile()) {
        continue;
      }
      if (results.length >= maxEntries) break;

      try {
        const fileStat = fs.statSync(next);
        results.push({
          path: path.relative(root, next).replace(/\\/g, '/'),
          fullPath: next,
          kind: 'file',
          size: fileStat.size,
          mtimeMs: fileStat.mtimeMs,
        });
      } catch {
        // Skip unreadable files in tree listing to keep host resilient.
      }
    }
  }

  return results.sort((a, b) => a.path.localeCompare(b.path));
}
