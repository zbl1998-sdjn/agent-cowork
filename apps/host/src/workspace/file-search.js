import path from 'node:path';
import { listWorkspaceTree } from './file-tree.js';
import { extractDocumentText, isExtractableDocument } from './document-extractor.js';

const DEFAULT_MAX_CONTENT_BYTES = 1024 * 1024;

/**
 * @typedef {{ trustedRoot?: string, root?: string, query?: unknown, maxResults?: number, includeContent?: boolean, maxContentBytes?: number }} SearchOptions
 * @typedef {{ path: string, fullPath: string, size: number, mtimeMs: number, match: 'content' | 'name', excerpt: string, extension: string }} SearchResult
 */

/** @param {unknown} value @param {number} fallback @param {number} min @param {number} max @returns {number} */
function cap(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.floor(n), min), max);
}

/** @param {SearchOptions} [options] @returns {{ query: string, results: SearchResult[] }} */
export function searchWorkspace(options = {}) {
  const trustedRoot = options.trustedRoot ?? options.root;
  if (!trustedRoot) {
    throw new Error('trustedRoot is required');
  }
  const query = String(options.query || '').trim().toLowerCase();
  if (!query) {
    throw new Error('query is required');
  }
  const maxResults = Math.min(Math.max(Number(options.maxResults || 20), 1), 100);
  const includeContent = options.includeContent === true;
  const maxContentBytes = cap(options.maxContentBytes, DEFAULT_MAX_CONTENT_BYTES, 1024, DEFAULT_MAX_CONTENT_BYTES);
  const files = listWorkspaceTree(trustedRoot, {
    includeFiles: true,
    includeDirectories: false,
  }).filter((entry) => entry.kind === 'file');

  /** @type {SearchResult[]} */
  const results = [];
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
        // Search should stay resilient when one document cannot be parsed.
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
