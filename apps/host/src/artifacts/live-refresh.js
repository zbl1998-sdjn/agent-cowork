// @ts-check
// 实时制品·刷新阶段:读 manifest/html,并按数据源拉取最新 viz 数据(host · L1 领域层 · artifacts)
// ---------------------------------------------------------------------------
// 职责:实时制品流水线「规格→渲染→刷新」的末环——读取已落盘的 manifest/html,
//       再依数据源类型刷新数据:file-json 走同步读文件,connector-tool 走异步调用
//       受限的 MCP 工具(校验通过才放行),刷新后的数据交回前端重绘。
// 依赖:node:fs、viz(renderViz 校验数据)、live-spec(路径/数据源规范化与 fail)
// 导出:readArtifactManifest / readLiveArtifactHtml / refreshLiveArtifactData(同步) /
//       refreshLiveArtifactDataAsync(支持 connector-tool 的异步刷新)
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

/** 读取并解析制品 manifest(JSON);文件不存在抛 404。 @param {{ trustedRoot: string, id: string }} options @returns {ArtifactManifest} */
export function readArtifactManifest({ trustedRoot, id }) {
  const { manifestPath } = artifactPaths({ trustedRoot, id });
  if (!fs.existsSync(manifestPath)) {
    throw fail('artifact not found', 404);
  }
  return /** @type {ArtifactManifest} */ (JSON.parse(fs.readFileSync(manifestPath, 'utf8')));
}

/** 读取制品已落盘的活页 HTML 快照;文件不存在抛 404。 @param {{ trustedRoot: string, id: string }} options @returns {string} */
export function readLiveArtifactHtml({ trustedRoot, id }) {
  const { htmlPath } = artifactPaths({ trustedRoot, id });
  if (!fs.existsSync(htmlPath)) {
    throw fail('artifact not found', 404);
  }
  return fs.readFileSync(htmlPath, 'utf8');
}

/** 读取并解析 JSON 文件;区分「文件缺失(404)」与「内容非法 JSON(400)」两类错误。 @param {string} filePath @returns {unknown} */
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

/** 从数据源载荷里取出 viz:优先取 payload.viz,否则把整个对象当作 viz。 @param {unknown} payload @returns {VizSpec} */
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

/** file-json 数据源刷新:读本地 JSON 文件取 viz 并用 renderViz 验一遍后返回。 @param {{ trustedRoot: string, manifest: ArtifactManifest, dataSource: LiveArtifactDataSource }} options @returns {ArtifactData} */
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

/** 判定某 MCP 工具能否当实时数据源:放行只读 fs 读取,否则要求非变更、免审批、风险不高。 @param {ToolDescriptor | null | undefined} descriptor @returns {boolean} */
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

/** 解析 MCP 工具返回:若是 content 数组则取其中的 text 片段当 JSON 解析,否则直接当对象。 @param {unknown} result @returns {Record<string, unknown>} */
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

/** connector-tool 数据源刷新:校验工具已连接且被允许后调用它,解析返回里的 viz 并验证。 @param {{ trustedRoot: string, manifest: ArtifactManifest, dataSource: Extract<LiveArtifactDataSource, { type: 'connector-tool' }>, toolRegistry?: ToolRegistryLike | null, context?: unknown }} options @returns {Promise<ArtifactData>} */
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

/** 同步刷新制品数据:connector-tool 需异步刷新故在此拒绝(503),file-json 读文件,无数据源回退 manifest 自带 viz。 @param {{ trustedRoot: string, id: string, now?: Date }} options @returns {ArtifactData} */
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

/** 异步刷新制品数据:三路分发——connector-tool 调工具、file-json 读文件、无数据源回退 manifest viz。 @param {{ trustedRoot: string, id: string, now?: Date, toolRegistry?: ToolRegistryLike | null, context?: unknown }} options @returns {Promise<ArtifactData>} */
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
