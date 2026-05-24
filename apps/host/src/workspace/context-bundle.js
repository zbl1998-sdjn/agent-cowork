// @ts-check

import path from 'node:path';
import { readTextFile } from './file-reader.js';
import { listWorkspaceTree } from './file-tree.js';
import { assertTrustedPath } from '../security/path-policy.js';
import fs from 'node:fs';

/**
 * @typedef {{ path: string, size: number, sha256: string, content: string }} BundledTextFile
 * @typedef {{ path: string, reason: string }} SkippedPath
 * @typedef {{
 *   root?: string,
 *   trustedRoot?: string,
 *   paths?: string[],
 *   maxTextSize?: number,
 *   maxTotalBytes?: number,
 *   maxFiles?: number,
 *   fsStatFn?: (candidate: string) => import('node:fs').Stats
 * }} ContextBundleInput
 * @typedef {{
 *   root: string,
 *   files: BundledTextFile[],
 *   skipped: SkippedPath[],
 *   generatedAt: string,
 *   count: number
 * }} ContextBundle
 */

/**
 * @param {unknown} error
 * @returns {string}
 */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * @param {ContextBundleInput} input
 * @returns {ContextBundle}
 */
export function buildContextBundle(input) {
  const trustedRoot = input.root ?? input.trustedRoot;
  const paths = input.paths ?? [];
  const maxTextSize = input.maxTextSize ?? 256 * 1024;
  // Global budget across all bundled files (not just per-file) so a big directory
  // can't blow up the model context window or host memory.
  const maxTotalBytes = input.maxTotalBytes ?? 4 * 1024 * 1024;
  const maxFiles = input.maxFiles ?? 200;
  const fsStat = input.fsStatFn || ((candidate) => fs.statSync(candidate));
  if (!trustedRoot) {
    throw new Error('trustedRoot is required');
  }

  /** @type {Set<string>} */
  const fileTargets = new Set();
  /** @type {SkippedPath[]} */
  const skipped = [];

  for (const raw of paths) {
    let resolved;
    try {
      resolved = assertTrustedPath(raw, trustedRoot);
    } catch (err) {
      skipped.push({ path: raw, reason: errorMessage(err) });
      continue;
    }

    let stats;
    try {
      stats = fsStat(resolved);
    } catch (err) {
      skipped.push({ path: resolved, reason: errorMessage(err) });
      continue;
    }
    const isDirectory = stats ? stats.isDirectory() : false;
    const isFile = stats ? stats.isFile() : false;

    if (!isDirectory && !isFile) {
      // For compatibility in tests/CLI usage, attempt direct read and mark skip on failure.
      fileTargets.add(resolved);
      continue;
    }

    if (stats.isDirectory()) {
      const entries = listWorkspaceTree(resolved, { includeDirectories: false });
      for (const entry of entries) {
        if (entry.kind === 'file') {
          fileTargets.add(entry.fullPath);
        }
      }
      continue;
    }

    fileTargets.add(resolved);
  }

  const files = [];
  let totalBytes = 0;
  for (const filePath of fileTargets) {
    if (files.length >= maxFiles || totalBytes >= maxTotalBytes) {
      skipped.push({ path: filePath, reason: 'context budget exceeded' });
      continue;
    }
    try {
      const file = /** @type {BundledTextFile} */ (readTextFile(filePath, { trustedRoot, maxSize: maxTextSize }));
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
