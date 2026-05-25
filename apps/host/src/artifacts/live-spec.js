// @ts-check

import crypto from 'node:crypto';
import path from 'node:path';

import { assertTrustedPath } from '../security/path-policy.js';

/**
 * @typedef {Error & { statusCode?: number }} HttpError
 * @typedef {{ type: 'file-json', path: string } | { type: 'connector-tool', tool: string, args: Record<string, unknown> }} LiveArtifactDataSource
 * @typedef {{ kind?: string, [key: string]: any }} VizSpec
 * @typedef {{ id?: string, title?: string, viz?: VizSpec, dataUrl?: string, dataSource?: any }} LiveArtifactSpecInput
 */

export const ART_PARTS = ['.AgentCowork', 'artifacts'];
export const CHART_KINDS = new Set(['bar', 'line', 'pie', 'doughnut']);

const ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * @param {string} message
 * @param {number} [statusCode]
 * @returns {HttpError}
 */
export function fail(message, statusCode = 400) {
  const error = /** @type {HttpError} */ (new Error(`artifact: ${message}`));
  error.statusCode = statusCode;
  return error;
}

/** @param {Date} [now] */
export function createArtifactId(now = new Date()) {
  const ts = now.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `viz_${ts}_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
}

/** @param {string} id */
export function assertArtifactId(id) {
  if (!ID_RE.test(id || '')) {
    throw fail('invalid artifact id');
  }
  return id;
}

/** @param {string} trustedRoot */
export function artifactDir(trustedRoot) {
  const safeRoot = assertTrustedPath(path.resolve(trustedRoot), path.resolve(trustedRoot));
  return { safeRoot, dir: path.join(safeRoot, ...ART_PARTS) };
}

/** @param {{ trustedRoot: string, id: string }} options */
export function artifactPaths({ trustedRoot, id }) {
  const artifactId = assertArtifactId(id);
  const { dir } = artifactDir(trustedRoot);
  const root = path.resolve(trustedRoot);
  return {
    artifactId,
    dir,
    htmlPath: assertTrustedPath(path.join(dir, `${artifactId}.html`), root),
    manifestPath: assertTrustedPath(path.join(dir, `${artifactId}.json`), root),
    relativePath: [...ART_PARTS, `${artifactId}.html`].join('/'),
  };
}

/**
 * @param {any} dataSource
 * @returns {LiveArtifactDataSource | null}
 */
export function normalizeLiveArtifactDataSource(dataSource) {
  if (dataSource == null) {
    return null;
  }
  if (!dataSource || typeof dataSource !== 'object' || Array.isArray(dataSource)) {
    throw fail('dataSource must be an object');
  }
  const type = String(dataSource.type || dataSource.kind || '').toLowerCase();
  if (type === 'connector-tool') {
    const tool = String(dataSource.tool || dataSource.name || '').trim();
    if (!/^mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_.-]+$/.test(tool)) {
      throw fail('dataSource.tool must be a connected MCP tool name');
    }
    const args = dataSource.args == null ? {} : dataSource.args;
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      throw fail('dataSource.args must be an object');
    }
    return {
      type: 'connector-tool',
      tool,
      args: JSON.parse(JSON.stringify(args)),
    };
  }
  if (type !== 'file-json') {
    throw fail(`unsupported artifact data source "${type || '(empty)'}"`);
  }
  const sourcePath = String(dataSource.path || '').trim();
  if (!sourcePath) {
    throw fail('dataSource.path is required');
  }
  if (path.isAbsolute(sourcePath)) {
    throw fail('dataSource.path must be relative to trustedRoot');
  }
  return {
    type: 'file-json',
    path: sourcePath.replace(/\\/g, '/'),
  };
}

/** @param {{ trustedRoot: string, dataSource: any }} options */
export function resolveLiveArtifactDataSourcePath({ trustedRoot, dataSource }) {
  const source = normalizeLiveArtifactDataSource(dataSource);
  if (!source || source.type !== 'file-json') {
    return null;
  }
  const root = path.resolve(trustedRoot);
  return assertTrustedPath(path.join(root, source.path), root);
}

/** @param {LiveArtifactSpecInput} [input] */
export function normalizeLiveArtifactSpec({ id, title, viz, dataUrl, dataSource } = {}) {
  if (!viz || typeof viz !== 'object') {
    throw fail('viz spec is required');
  }
  const artifactId = id ? assertArtifactId(id) : createArtifactId();
  const resolvedDataUrl = dataUrl || `/api/artifacts/data/${artifactId}`;
  return {
    id: artifactId,
    title: title || '活页 Artifact',
    kind: viz.kind,
    viz,
    dataUrl: resolvedDataUrl,
    dataSource: normalizeLiveArtifactDataSource(dataSource),
  };
}
