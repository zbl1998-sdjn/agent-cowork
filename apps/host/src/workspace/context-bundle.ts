// 上下文打包(host · L1 领域层 · workspace)
// ---------------------------------------------------------------------------
// 职责:把一组路径(文件或目录)收集成「文本文件包」供模型上下文使用。目录会展开为其下文件;
//       受单文件大小、全局总字节、最大文件数三重预算约束,超额或读失败的路径记入 skipped。
// 依赖:L0 path-policy + 同层 file-reader / file-tree。导出:buildContextBundle。
import path from 'node:path';
import { readTextFile } from './file-reader.js';
import { listWorkspaceTree } from './file-tree.js';
import { assertTrustedPath } from '../security/path-policy.js';
import fs from 'node:fs';
import type { Stats } from 'node:fs';

export type BundledTextFile = { path: string; size: number; sha256: string; content: string };
export type SkippedPath = { path: string; reason: string };
export type ContextBundleInput = {
  root?: string;
  trustedRoot?: string;
  paths?: string[];
  maxTextSize?: number;
  maxTotalBytes?: number;
  maxFiles?: number;
  fsStatFn?: (candidate: string) => Stats;
  includeFile?: (fullPath: string) => boolean;
};
export type ContextBundle = {
  root: string;
  files: BundledTextFile[];
  skipped: SkippedPath[];
  generatedAt: string;
  count: number;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 把给定路径(文件/目录展开)打包成文本文件集合,受大小/总量/数量预算约束,返回 { files, skipped, … }。
 */
export function buildContextBundle(input: ContextBundleInput): ContextBundle {
  const trustedRoot = input.root ?? input.trustedRoot;
  const paths = input.paths ?? [];
  const maxTextSize = input.maxTextSize ?? 256 * 1024;
  // 全局预算覆盖所有打包文件,防止大目录撑爆模型上下文或 host 内存。
  const maxTotalBytes = input.maxTotalBytes ?? 4 * 1024 * 1024;
  const maxFiles = input.maxFiles ?? 200;
  const fsStat = input.fsStatFn || ((candidate: string) => fs.statSync(candidate));
  if (!trustedRoot) {
    throw new Error('trustedRoot is required');
  }

  const fileTargets = new Set<string>();
  const skipped: SkippedPath[] = [];

  for (const raw of paths) {
    let resolved: string;
    try {
      resolved = assertTrustedPath(raw, trustedRoot);
    } catch (err) {
      skipped.push({ path: raw, reason: errorMessage(err) });
      continue;
    }

    let stats: Stats;
    try {
      stats = fsStat(resolved);
    } catch (err) {
      skipped.push({ path: resolved, reason: errorMessage(err) });
      continue;
    }
    const isDirectory = stats ? stats.isDirectory() : false;
    const isFile = stats ? stats.isFile() : false;

    if (!isDirectory && !isFile) {
      // 兼容测试/CLI 场景:非普通文件也尝试直接读,失败再记入 skipped。
      fileTargets.add(resolved);
      continue;
    }

    if (stats.isDirectory()) {
      const entries = listWorkspaceTree(resolved, {
        includeDirectories: false,
        includeEntry: (fullPath, kind) => kind !== 'file' || !input.includeFile || input.includeFile(fullPath),
      });
      for (const entry of entries) {
        if (entry.kind === 'file') {
          fileTargets.add(entry.fullPath);
        }
      }
      continue;
    }

    if (!input.includeFile || input.includeFile(resolved)) fileTargets.add(resolved);
  }

  const files: BundledTextFile[] = [];
  let totalBytes = 0;
  for (const filePath of fileTargets) {
    if (files.length >= maxFiles || totalBytes >= maxTotalBytes) {
      skipped.push({ path: filePath, reason: 'context budget exceeded' });
      continue;
    }
    try {
      const file = readTextFile(filePath, { trustedRoot, maxSize: maxTextSize }) as BundledTextFile;
      totalBytes += Buffer.byteLength(file.content || '', 'utf8');
      files.push(file);
    } catch (err) {
      skipped.push({ path: filePath, reason: errorMessage(err) });
    }
  }

  return {
    root: path.resolve(trustedRoot),
    files,
    skipped,
    generatedAt: new Date().toISOString(),
    count: files.length,
  };
}
