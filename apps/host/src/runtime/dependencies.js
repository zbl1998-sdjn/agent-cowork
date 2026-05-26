// @ts-check
import { redactText } from '../security/redaction.js';
import { detectChromiumRuntime } from './chromium-runtime.js';
import { detectDataScienceRuntime } from './data-science-runtime.js';
import { RUNTIME_DEPENDENCY_CATALOG } from './dependencies-catalog.js';
import { detectCjkFonts } from './font-runtime.js';
import { detectGitRuntime } from './git-runtime.js';
import { detectOcrRuntime } from './ocr-runtime.js';
import { detectPandocRuntime } from './pandoc-runtime.js';
import { detectVcRuntime } from './windows-runtime.js';

export { RUNTIME_DEPENDENCY_CATALOG } from './dependencies-catalog.js';

/**
 * @typedef {import('./dependencies-catalog.js').RuntimeDependencyCatalogItem} RuntimeDependencyCatalogItem
 * @typedef {Record<string, string | undefined>} EnvLike
 * @typedef {{ info?: { backend?: string, networkIsolated?: boolean, userMessage?: string } }} SandboxStartup
 * @typedef {{ env?: EnvLike, platform?: string, sandboxStartup?: SandboxStartup | null, fsImpl?: any, spawnSync?: any, now?: Date }} RuntimeDependencyStatusOptions
 * @typedef {{ status: string, source?: string, version?: unknown, detail?: unknown }} RuntimeDependencyDetection
 * @typedef {RuntimeDependencyCatalogItem & RuntimeDependencyDetection} RuntimeDependencyStatusItem
 */

/**
 * @param {EnvLike} env
 * @param {string[]} keys
 * @returns {{ key: string, value: string } | null}
 */
function envValue(env, keys) {
  for (const key of keys) {
    const value = env?.[key];
    if (typeof value === 'string' && value.trim()) {
      return { key, value: value.trim() };
    }
  }
  return null;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function redactProxyUrl(value) {
  const text = redactText(value) || '';
  return text.replace(/^([a-z][a-z0-9+.-]*:\/\/)([^:@/\s]+):([^@/\s]+)@/i, '$1$2:[REDACTED]@');
}

/**
 * @param {EnvLike} env
 * @param {string[]} keys
 * @param {string} detail
 * @returns {RuntimeDependencyDetection}
 */
function configuredFromEnv(env, keys, detail) {
  const match = envValue(env, keys);
  if (!match) return { status: 'missing', detail };
  return { status: 'configured', source: match.key, detail };
}

/**
 * @param {RuntimeDependencyCatalogItem} item
 * @param {RuntimeDependencyStatusOptions} options
 * @returns {RuntimeDependencyDetection}
 */
function detectDependency(item, options) {
  const env = options.env || {};
  const platform = options.platform || process.platform;
  const sandboxStartup = options.sandboxStartup || null;

  if (item.id === 'node') {
    return {
      status: 'available',
      version: process.version,
      detail: process.execPath ? 'host 进程正在使用该运行时' : '当前进程运行时可用',
    };
  }

  if (item.id === 'sqlite') {
    return process.versions?.sqlite
      ? { status: 'available', version: process.versions.sqlite, detail: 'node:sqlite 可用' }
      : { status: 'unknown', detail: '当前端点未探测 SQLite 绑定' };
  }

  if (item.id === 'webview2') {
    const configured = envValue(env, ['KCW_WEBVIEW2_MODE', 'WEBVIEW2_RELEASE_CHANNEL_PREFERENCE']);
    if (configured) return { status: 'configured', source: configured.key, detail: `WebView2 模式: ${configured.value}` };
    return platform === 'win32'
      ? { status: 'unknown', detail: '需要安装器或 Windows 运行时探测确认' }
      : { status: 'not_applicable', detail: '仅 Windows 需要' };
  }

  if (item.id === 'python-embedded') {
    return configuredFromEnv(env, ['KCW_EMBEDDED_PYTHON', 'KCW_PYTHON_HOME'], '内置 Python 路径已配置');
  }

  if (item.id === 'cjk-fonts') return detectCjkFonts({ env, fsImpl: options.fsImpl });

  if (item.id === 'vc-runtime') return detectVcRuntime({ env, platform, spawnSync: options.spawnSync });

  if (item.id === 'proxy') {
    const proxy = envValue(env, ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'https_proxy', 'http_proxy', 'all_proxy']);
    if (!proxy) return { status: 'unknown', detail: '未配置代理环境变量' };
    return { status: 'configured', source: proxy.key, detail: redactProxyUrl(proxy.value) };
  }

  if (item.id === 'sandbox-isolation') {
    if (sandboxStartup?.info?.backend) {
      return {
        status: sandboxStartup.info.networkIsolated ? 'available' : 'degraded',
        detail: redactText(sandboxStartup.info.userMessage || sandboxStartup.info.backend),
      };
    }
    return { status: 'unknown', detail: '尚未接入沙箱启动探测' };
  }

  if (item.id === 'data-science') return detectDataScienceRuntime({ env, fsImpl: options.fsImpl });

  if (item.id === 'playwright-chromium') return detectChromiumRuntime({ env, fsImpl: options.fsImpl });

  if (item.id === 'tesseract-ocr') return detectOcrRuntime({ env, fsImpl: options.fsImpl });

  if (item.id === 'pandoc') return detectPandocRuntime({ env, fsImpl: options.fsImpl });

  if (item.id === 'mingit') return detectGitRuntime({ env, spawnSync: options.spawnSync });

  const marker = envValue(env, [`KCW_${item.id.toUpperCase().replace(/-/g, '_')}_HOME`]);
  if (marker) return { status: 'configured', source: marker.key, detail: `${item.label} 路径已配置` };
  return { status: 'missing', detail: '可选按需组件尚未安装' };
}

/**
 * @param {RuntimeDependencyStatusItem[]} dependencies
 * @returns {{ total: number, requiredMissing: number, byStatus: Record<string, number> }}
 */
function summarize(dependencies) {
  /** @type {Record<string, number>} */
  const byStatus = {};
  let requiredMissing = 0;
  for (const item of dependencies) {
    byStatus[item.status] = (byStatus[item.status] || 0) + 1;
    if (item.required && (item.status === 'missing' || item.status === 'degraded')) {
      requiredMissing += 1;
    }
  }
  return {
    total: dependencies.length,
    requiredMissing,
    byStatus,
  };
}

/**
 * @param {RuntimeDependencyStatusOptions} [options]
 */
export function getRuntimeDependencyStatus(options = {}) {
  const dependencies = RUNTIME_DEPENDENCY_CATALOG.map((item) => ({
    ...item,
    ...detectDependency(item, options),
  }));
  return {
    ok: true,
    service: 'agent-cowork-host',
    generatedAt: (options.now || new Date()).toISOString(),
    platform: options.platform || process.platform,
    arch: process.arch,
    dependencies,
    summary: summarize(dependencies),
  };
}
