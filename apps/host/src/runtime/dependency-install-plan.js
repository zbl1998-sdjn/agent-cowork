import path from 'node:path';
import { RUNTIME_DEPENDENCY_CATALOG } from './dependencies.js';

function finiteBytes(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

function dependencyById() {
  return new Map(RUNTIME_DEPENDENCY_CATALOG.map((item) => [item.id, item]));
}

function defaultAppDataRoot() {
  const base = process.env.APPDATA || process.env.LOCALAPPDATA || process.cwd();
  return path.resolve(base, 'AgentCowork');
}

function normalizeAgentCoworkRoot(value) {
  const root = path.resolve(value || defaultAppDataRoot());
  if (path.basename(root).toLowerCase() !== 'agentcowork') {
    throw new Error('Agent Cowork cleanup root must end with AgentCowork');
  }
  return root;
}

function safeChild(root, relativePath) {
  const target = path.resolve(root, relativePath);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Cleanup target escaped AgentCowork root: ${relativePath}`);
  }
  return target;
}

function onDemandDependencyIds() {
  return RUNTIME_DEPENDENCY_CATALOG
    .filter((item) => item.installMode === 'on-demand')
    .map((item) => item.id);
}

function hasValidSha256(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
}

function buildSupplyChainPrecheck(item) {
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

function retainedPath(appDataRoot, relativePath) {
  return relativePath === '.' ? appDataRoot : safeChild(appDataRoot, relativePath);
}

export function buildRuntimeDependencyInstallPlan(options = {}) {
  const selectedIds = Array.isArray(options.selectedIds) ? options.selectedIds : [];
  const catalog = dependencyById();
  const components = [];
  const unknownIds = [];
  for (const id of selectedIds) {
    const key = String(id || '').trim();
    if (!key) continue;
    const item = catalog.get(key);
    if (!item) {
      unknownIds.push(key);
      continue;
    }
    components.push({
      id: item.id,
      section: item.section,
      label: item.label,
      installMode: item.installMode,
      required: item.required,
      estimatedDownloadBytes: item.estimatedDownloadBytes || 0,
      needsDownload: item.installMode === 'on-demand',
      sourceKind: item.sourceKind || null,
      sourceUrl: item.sourceUrl || null,
      sha256: item.sha256 || null,
      signaturePolicy: item.signaturePolicy || null,
      supplyChain: buildSupplyChainPrecheck(item),
    });
  }

  const requiredBytes = components
    .filter((item) => item.needsDownload)
    .reduce((sum, item) => sum + item.estimatedDownloadBytes, 0);
  const availableBytes = finiteBytes(options.freeBytes);
  const missingBytes = availableBytes == null ? 0 : Math.max(0, requiredBytes - availableBytes);
  const diskStatus = availableBytes == null ? 'unknown' : missingBytes > 0 ? 'insufficient' : 'ok';
  const supplyChainIssues = components
    .filter((item) => item.needsDownload && !item.supplyChain.ok)
    .map((item) => ({
      id: item.id,
      label: item.label,
      reasons: item.supplyChain.reasons,
    }));
  const ok = unknownIds.length === 0 && diskStatus !== 'insufficient' && supplyChainIssues.length === 0;
  return {
    ok,
    components,
    unknownIds,
    supplyChain: {
      status: supplyChainIssues.length ? 'blocked' : 'ok',
      issues: supplyChainIssues,
      message: supplyChainIssues.length
        ? '按需下载组件缺少可验证来源、哈希或签名策略，禁止下载。'
        : '按需下载供应链预检通过。',
    },
    disk: {
      status: diskStatus,
      availableBytes,
      requiredBytes,
      missingBytes,
      message: diskStatus === 'insufficient'
        ? `磁盘空间不足，还需要至少 ${missingBytes} 字节。`
        : diskStatus === 'unknown'
          ? '未提供可用磁盘空间，安装前仍需预检。'
          : '磁盘空间满足本次安装/下载预检。',
    },
  };
}

export function buildRuntimeDependencyCleanupPlan(options = {}) {
  const catalog = dependencyById();
  const appDataRoot = normalizeAgentCoworkRoot(options.appDataRoot);
  const selectedIds = Array.isArray(options.selectedIds) ? options.selectedIds : onDemandDependencyIds();
  const keepUserData = options.keepUserData !== false;
  const components = [];
  const unknownIds = [];
  for (const rawId of selectedIds) {
    const id = String(rawId || '').trim();
    if (!id) continue;
    const item = catalog.get(id);
    if (!item) {
      unknownIds.push(id);
      continue;
    }
    if (item.installMode !== 'on-demand' || !item.cleanup?.relativePath) {
      continue;
    }
    components.push({
      id: item.id,
      section: item.section,
      label: item.label,
      relativePath: item.cleanup.relativePath,
      path: safeChild(appDataRoot, item.cleanup.relativePath),
      action: 'remove',
      kind: 'component-cache',
    });
  }

  const targets = [
    ...components,
    {
      id: 'runtime-cache',
      label: '运行时下载缓存',
      relativePath: 'cache',
      path: safeChild(appDataRoot, 'cache'),
      action: 'remove',
      kind: 'download-cache',
    },
  ];
  if (!keepUserData) {
    targets.push({
      id: 'user-data',
      label: '本机用户数据',
      relativePath: '.',
      path: appDataRoot,
      action: 'remove',
      kind: 'user-data',
      requiresConfirmation: true,
    });
  }

  return {
    ok: unknownIds.length === 0,
    mode: keepUserData ? 'preserve-user-data' : 'remove-user-data',
    appDataRoot,
    keepUserData,
    unknownIds,
    targets,
    retained: keepUserData
      ? [{
        id: 'user-data',
        label: '本机用户数据',
        path: appDataRoot,
        reason: '用户选择保留对话、记忆、鉴权和配置数据。',
      }]
      : [],
    warnings: keepUserData
      ? []
      : ['将删除本机 AgentCowork 用户数据，必须在卸载界面二次确认。'],
  };
}

export function buildRuntimeDependencyUpdatePlan(options = {}) {
  const catalog = dependencyById();
  const appDataRoot = normalizeAgentCoworkRoot(options.appDataRoot);
  const selectedIds = Array.isArray(options.selectedIds) ? options.selectedIds : onDemandDependencyIds();
  const components = [];
  const unknownIds = [];
  for (const rawId of selectedIds) {
    const id = String(rawId || '').trim();
    if (!id) continue;
    const item = catalog.get(id);
    if (!item) {
      unknownIds.push(id);
      continue;
    }
    if (item.installMode !== 'on-demand' || !item.cleanup?.relativePath) {
      continue;
    }
    components.push({
      id: item.id,
      section: item.section,
      label: item.label,
      relativePath: item.cleanup.relativePath,
      path: safeChild(appDataRoot, item.cleanup.relativePath),
      action: 'preserve',
      kind: 'downloaded-component',
      reason: '升级应用本体时保留已下载组件，避免重复下载。',
    });
  }

  const retained = [
    {
      id: 'user-data',
      label: '本机用户数据',
      relativePath: '.',
      kind: 'user-data',
      reason: '保留对话、记忆、鉴权、配置和本地状态。',
    },
    {
      id: 'python-venv',
      label: 'Python 虚拟环境',
      relativePath: 'venv',
      kind: 'python-venv',
      reason: '保留按需安装的 Python 运行环境和 wheel 缓存。',
    },
    {
      id: 'components-root',
      label: '按需组件目录',
      relativePath: 'components',
      kind: 'downloaded-components-root',
      reason: '保留 OCR、Chromium、Pandoc、MinGit 等按需组件。',
    },
    {
      id: 'runtime-cache',
      label: '运行时下载缓存',
      relativePath: 'cache',
      kind: 'download-cache',
      reason: '保留可复用下载缓存，减少升级后的重复下载。',
    },
  ].map((item) => ({
    ...item,
    path: retainedPath(appDataRoot, item.relativePath),
    action: 'preserve',
  }));

  return {
    ok: unknownIds.length === 0,
    mode: 'preserve-on-update',
    currentVersion: options.currentVersion || null,
    targetVersion: options.targetVersion || null,
    appDataRoot,
    unknownIds,
    components,
    retained,
    destructiveActions: [],
    installerInvariant: '更新只替换安装目录中的应用本体，不删除 AppData\\AgentCowork。',
  };
}
