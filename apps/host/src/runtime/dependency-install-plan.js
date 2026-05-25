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
    });
  }

  const requiredBytes = components
    .filter((item) => item.needsDownload)
    .reduce((sum, item) => sum + item.estimatedDownloadBytes, 0);
  const availableBytes = finiteBytes(options.freeBytes);
  const missingBytes = availableBytes == null ? 0 : Math.max(0, requiredBytes - availableBytes);
  const diskStatus = availableBytes == null ? 'unknown' : missingBytes > 0 ? 'insufficient' : 'ok';
  const ok = unknownIds.length === 0 && diskStatus !== 'insufficient';
  return {
    ok,
    components,
    unknownIds,
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
