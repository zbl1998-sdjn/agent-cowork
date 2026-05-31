// 依赖安装计划·工具(host · L2 运行时 · runtime)
// ---------------------------------------------------------------------------
// 职责:dependency-install-plan 用到的纯工具——按 id 查目录项、供应链预检、归一化 AgentCowork 根、
//       字节数校验、保留路径与安全子路径拼装。便于单测。依赖:同层 dependencies-catalog。
import path from 'node:path';
import { RUNTIME_DEPENDENCY_CATALOG } from './dependencies-catalog.js';
import type { RuntimeDependencyCatalogItem } from './dependencies-catalog.js';

export type SupplyChainPrecheck = {
  ok: boolean;
  status: 'not_required' | 'ready' | 'blocked';
  reasons: string[];
};

export function finiteBytes(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

export function dependencyById(): Map<string, RuntimeDependencyCatalogItem> {
  return new Map(RUNTIME_DEPENDENCY_CATALOG.map((item) => [item.id, item]));
}

export function defaultAppDataRoot(): string {
  const base = process.env.APPDATA || process.env.LOCALAPPDATA || process.cwd();
  return path.resolve(base, 'AgentCowork');
}

export function normalizeAgentCoworkRoot(value: string | null | undefined): string {
  const root = path.resolve(value || defaultAppDataRoot());
  if (path.basename(root).toLowerCase() !== 'agentcowork') {
    throw new Error('Agent Cowork cleanup root must end with AgentCowork');
  }
  return root;
}

export function safeChild(root: string, relativePath: string): string {
  const target = path.resolve(root, relativePath);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Cleanup target escaped AgentCowork root: ${relativePath}`);
  }
  return target;
}

export function onDemandDependencyIds(): string[] {
  return RUNTIME_DEPENDENCY_CATALOG
    .filter((item) => item.installMode === 'on-demand')
    .map((item) => item.id);
}

export function hasValidSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
}

export function buildSupplyChainPrecheck(item: RuntimeDependencyCatalogItem): SupplyChainPrecheck {
  if (item.installMode !== 'on-demand') {
    return { ok: true, status: 'not_required', reasons: [] };
  }
  const reasons: string[] = [];
  if (!item.sourceKind) reasons.push('缺少下载来源类型。');
  if (!item.sourceUrl) reasons.push('缺少下载来源 URL。');
  if (!hasValidSha256(item.sha256)) reasons.push('缺少有效 sha256 校验值。');
  if (!item.signaturePolicy) reasons.push('缺少签名策略。');
  return {
    ok: reasons.length === 0,
    status: reasons.length === 0 ? 'ready' : 'blocked',
    reasons,
  };
}

export function retainedPath(appDataRoot: string, relativePath: string): string {
  return relativePath === '.' ? appDataRoot : safeChild(appDataRoot, relativePath);
}
