// @ts-check

import fs from 'node:fs';
import path from 'node:path';
import { assertTrustedPath, isWorkspaceIgnoredPath } from '../security/path-policy.js';

/**
 * @typedef {{ includeFiles?: boolean, includeDirectories?: boolean, maxDepth?: number, maxEntries?: number }} WorkspaceTreeOptions
 * @typedef {{ path: string, fullPath: string, kind: 'directory' }} WorkspaceDirectoryEntry
 * @typedef {{ path: string, fullPath: string, kind: 'file', size: number, mtimeMs: number }} WorkspaceFileEntry
 * @typedef {WorkspaceDirectoryEntry | WorkspaceFileEntry} WorkspaceTreeEntry
 * @typedef {{ absPath: string, depth: number }} PendingTreeNode
 */

/**
 * @param {string} trustedRoot
 * @param {WorkspaceTreeOptions} [options]
 * @returns {WorkspaceTreeEntry[]}
 */
export function listWorkspaceTree(trustedRoot, options = {}) {
  const root = assertTrustedPath(path.resolve(trustedRoot), trustedRoot);
  const includeFiles = options.includeFiles !== false;
  const includeDirs = options.includeDirectories !== false;
  // Bound the traversal so a huge/deep workspace can't exhaust memory or hang the
  // UI (the listing is unbounded otherwise). Caller-overridable, hard-capped.
  const maxDepth = Math.min(Math.max(1, Number(options.maxDepth ?? 8)), 20);
  const maxEntries = Math.min(Math.max(1, Number(options.maxEntries ?? 5000)), 20000);
  /** @type {WorkspaceTreeEntry[]} */
  const results = [];

  /** @type {PendingTreeNode[]} */
  const stack = [{ absPath: root, depth: 0 }];

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
