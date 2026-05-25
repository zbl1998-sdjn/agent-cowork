import { RUNTIME_DEPENDENCY_CATALOG } from './dependencies.js';

function finiteBytes(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

function dependencyById() {
  return new Map(RUNTIME_DEPENDENCY_CATALOG.map((item) => [item.id, item]));
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
