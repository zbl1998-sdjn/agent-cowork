import crypto from 'node:crypto';
import path from 'node:path';

import { assertTrustedPath } from '../security/path-policy.js';

export const ART_PARTS = ['.AgentCowork', 'artifacts'];
export const CHART_KINDS = new Set(['bar', 'line', 'pie', 'doughnut']);

const ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

export function fail(message, statusCode = 400) {
  const error = new Error(`artifact: ${message}`);
  error.statusCode = statusCode;
  return error;
}

export function createArtifactId(now = new Date()) {
  const ts = now.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `viz_${ts}_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
}

export function assertArtifactId(id) {
  if (!ID_RE.test(id || '')) {
    throw fail('invalid artifact id');
  }
  return id;
}

export function artifactDir(trustedRoot) {
  const safeRoot = assertTrustedPath(path.resolve(trustedRoot), path.resolve(trustedRoot));
  return { safeRoot, dir: path.join(safeRoot, ...ART_PARTS) };
}

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
      type,
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
    type,
    path: sourcePath.replace(/\\/g, '/'),
  };
}

export function resolveLiveArtifactDataSourcePath({ trustedRoot, dataSource }) {
  const source = normalizeLiveArtifactDataSource(dataSource);
  if (!source || source.type !== 'file-json') {
    return null;
  }
  const root = path.resolve(trustedRoot);
  return assertTrustedPath(path.join(root, source.path), root);
}

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
