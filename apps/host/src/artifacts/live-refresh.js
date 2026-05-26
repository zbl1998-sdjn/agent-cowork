// @ts-check
import fs from 'node:fs';

import { renderViz } from './viz.js';
import {
  artifactPaths,
  fail,
  normalizeLiveArtifactDataSource,
  resolveLiveArtifactDataSourcePath,
} from './live-spec.js';

/**
 * @typedef {import('./live-spec.js').LiveArtifactDataSource} LiveArtifactDataSource
 * @typedef {import('./viz.js').VizSpec} VizSpec
 * @typedef {{ id: string, title: string, viz: VizSpec, dataSource?: unknown }} ArtifactManifest
 * @typedef {{ id: string, title: string, viz: VizSpec, dataSource?: unknown, refreshedAt?: string }} ArtifactData
 * @typedef {{ source?: string, name?: string, risk?: unknown, mutating?: boolean, requiresApproval?: boolean }} ToolDescriptor
 * @typedef {{ descriptor(name: string): ToolDescriptor | null | undefined, call(name: string, args: Record<string, unknown>, ctx: { trustedRoot: string, context?: unknown }): unknown | Promise<unknown> }} ToolRegistryLike
 */

/** @param {{ trustedRoot: string, id: string }} options @returns {ArtifactManifest} */
export function readArtifactManifest({ trustedRoot, id }) {
  const { manifestPath } = artifactPaths({ trustedRoot, id });
  if (!fs.existsSync(manifestPath)) {
    throw fail('artifact not found', 404);
  }
  return /** @type {ArtifactManifest} */ (JSON.parse(fs.readFileSync(manifestPath, 'utf8')));
}

/** @param {{ trustedRoot: string, id: string }} options @returns {string} */
export function readLiveArtifactHtml({ trustedRoot, id }) {
  const { htmlPath } = artifactPaths({ trustedRoot, id });
  if (!fs.existsSync(htmlPath)) {
    throw fail('artifact not found', 404);
  }
  return fs.readFileSync(htmlPath, 'utf8');
}

/** @param {string} filePath @returns {unknown} */
function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    const error = /** @type {{ code?: unknown }} */ (err);
    if (error && error.code === 'ENOENT') {
      throw fail('artifact data source not found', 404);
    }
    throw fail('artifact data source is not valid JSON');
  }
}

/** @param {unknown} payload @returns {VizSpec} */
function vizFromSourcePayload(payload) {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const record = /** @type {Record<string, unknown>} */ (payload);
    if (record.viz && typeof record.viz === 'object' && !Array.isArray(record.viz)) {
      return /** @type {VizSpec} */ (record.viz);
    }
    return /** @type {VizSpec} */ (record);
  }
  throw fail('artifact data source must contain a viz object');
}

/** @param {{ trustedRoot: string, manifest: ArtifactManifest, dataSource: LiveArtifactDataSource }} options @returns {ArtifactData} */
function refreshFromFileJson({ trustedRoot, manifest, dataSource }) {
  const filePath = resolveLiveArtifactDataSourcePath({ trustedRoot, dataSource });
  if (!filePath || !fs.existsSync(filePath)) {
    throw fail('artifact data source not found', 404);
  }
  const payload = readJsonFile(filePath);
  const viz = vizFromSourcePayload(payload);
  renderViz(viz);
  return {
    id: manifest.id,
    title: manifest.title,
    viz,
    dataSource,
  };
}

/** @param {ToolDescriptor | null | undefined} descriptor @returns {boolean} */
function connectorDataSourceAllowed(descriptor) {
  if (!descriptor) {
    return false;
  }
  if (descriptor.source === 'mcp:fs' && descriptor.name === 'mcp__fs__read_text') {
    return true;
  }
  const risk = String(descriptor.risk || '').toLowerCase();
  return descriptor.mutating !== true
    && descriptor.requiresApproval !== true
    && !['high', 'critical'].includes(risk);
}

/** @param {unknown} result @returns {Record<string, unknown>} */
function parseConnectorToolPayload(result) {
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    const record = /** @type {{ content?: unknown }} */ (result);
    if (Array.isArray(record.content)) {
      const textPart = record.content.find((part) => {
        const item = /** @type {{ type?: unknown, text?: unknown }} */ (part || {});
        return item.type === 'text' && typeof item.text === 'string';
      });
      if (!textPart) {
        throw fail('artifact connector data source must return text JSON');
      }
      try {
        return /** @type {Record<string, unknown>} */ (JSON.parse(/** @type {{ text: string }} */ (textPart).text));
      } catch {
        throw fail('artifact connector data source text is not valid JSON');
      }
    }
    return /** @type {Record<string, unknown>} */ (result);
  }
  throw fail('artifact connector data source must return a JSON object');
}

/** @param {{ trustedRoot: string, manifest: ArtifactManifest, dataSource: Extract<LiveArtifactDataSource, { type: 'connector-tool' }>, toolRegistry?: ToolRegistryLike | null, context?: unknown }} options @returns {Promise<ArtifactData>} */
async function refreshFromConnectorTool({ trustedRoot, manifest, dataSource, toolRegistry, context }) {
  if (!toolRegistry) {
    throw fail('artifact connector data source is unavailable', 503);
  }
  const descriptor = toolRegistry.descriptor(dataSource.tool);
  if (!descriptor) {
    throw fail('artifact connector tool is not connected', 409);
  }
  if (!connectorDataSourceAllowed(descriptor)) {
    throw fail('artifact connector tool is not allowed as a live data source', 403);
  }
  const payload = parseConnectorToolPayload(await toolRegistry.call(dataSource.tool, dataSource.args || {}, {
    trustedRoot,
    context,
  }));
  const viz = vizFromSourcePayload(payload);
  renderViz(viz);
  return {
    id: manifest.id,
    title: manifest.title,
    viz,
    dataSource,
  };
}

/** @param {{ trustedRoot: string, id: string, now?: Date }} options @returns {ArtifactData} */
export function refreshLiveArtifactData({ trustedRoot, id, now = new Date() }) {
  const manifest = readArtifactManifest({ trustedRoot, id });
  const dataSource = normalizeLiveArtifactDataSource(manifest.dataSource);
  if (dataSource?.type === 'connector-tool') {
    throw fail('artifact connector data source requires async refresh', 503);
  }
  const base = dataSource
    ? refreshFromFileJson({ trustedRoot, manifest, dataSource })
    : {
        id: manifest.id,
        title: manifest.title,
        viz: manifest.viz,
      };
  return {
    ...base,
    refreshedAt: now.toISOString(),
  };
}

/** @param {{ trustedRoot: string, id: string, now?: Date, toolRegistry?: ToolRegistryLike | null, context?: unknown }} options @returns {Promise<ArtifactData>} */
export async function refreshLiveArtifactDataAsync({ trustedRoot, id, now = new Date(), toolRegistry, context }) {
  const manifest = readArtifactManifest({ trustedRoot, id });
  const dataSource = normalizeLiveArtifactDataSource(manifest.dataSource);
  const base = dataSource?.type === 'connector-tool'
    ? await refreshFromConnectorTool({ trustedRoot, manifest, dataSource, toolRegistry, context })
    : dataSource
      ? refreshFromFileJson({ trustedRoot, manifest, dataSource })
      : {
          id: manifest.id,
          title: manifest.title,
          viz: manifest.viz,
        };
  return {
    ...base,
    refreshedAt: now.toISOString(),
  };
}
