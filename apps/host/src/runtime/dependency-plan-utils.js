import path from 'node:path';
import { RUNTIME_DEPENDENCY_CATALOG } from './dependencies.js';

export function finiteBytes(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

export function dependencyById() {
  return new Map(RUNTIME_DEPENDENCY_CATALOG.map((item) => [item.id, item]));
}

export function defaultAppDataRoot() {
  const base = process.env.APPDATA || process.env.LOCALAPPDATA || process.cwd();
  return path.resolve(base, 'AgentCowork');
}

export function normalizeAgentCoworkRoot(value) {
  const root = path.resolve(value || defaultAppDataRoot());
  if (path.basename(root).toLowerCase() !== 'agentcowork') {
    throw new Error('Agent Cowork cleanup root must end with AgentCowork');
  }
  return root;
}

export function safeChild(root, relativePath) {
  const target = path.resolve(root, relativePath);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Cleanup target escaped AgentCowork root: ${relativePath}`);
  }
  return target;
}

export function onDemandDependencyIds() {
  return RUNTIME_DEPENDENCY_CATALOG
    .filter((item) => item.installMode === 'on-demand')
    .map((item) => item.id);
}

export function hasValidSha256(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
}

export function buildSupplyChainPrecheck(item) {
  if (item.installMode !== 'on-demand') {
    return { ok: true, status: 'not_required', reasons: [] };
  }
  const reasons = [];
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

export function retainedPath(appDataRoot, relativePath) {
  return relativePath === '.' ? appDataRoot : safeChild(appDataRoot, relativePath);
}
