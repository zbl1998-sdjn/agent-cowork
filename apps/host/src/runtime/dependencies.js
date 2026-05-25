import { redactText } from '../security/redaction.js';

export const RUNTIME_DEPENDENCY_CATALOG = Object.freeze([
  {
    id: 'node',
    section: 'A4',
    label: 'Node runtime',
    required: true,
    installMode: 'bundled',
    estimatedDownloadBytes: 0,
  },
  {
    id: 'webview2',
    section: 'A1',
    label: 'WebView2 runtime',
    required: true,
    installMode: 'system',
    estimatedDownloadBytes: 0,
  },
  {
    id: 'python-embedded',
    section: 'A2',
    label: 'Embedded Python',
    required: true,
    installMode: 'bundled',
    estimatedDownloadBytes: 0,
  },
  {
    id: 'cjk-fonts',
    section: 'A3',
    label: 'CJK fonts',
    required: true,
    installMode: 'bundled',
    estimatedDownloadBytes: 0,
  },
  {
    id: 'vc-runtime',
    section: 'A5',
    label: 'VC++ redistributable',
    required: true,
    installMode: 'system',
    estimatedDownloadBytes: 0,
  },
  {
    id: 'sqlite',
    section: 'F2',
    label: 'SQLite runtime',
    required: true,
    installMode: 'bundled',
    estimatedDownloadBytes: 0,
  },
  {
    id: 'proxy',
    section: 'F1',
    label: 'Proxy configuration',
    required: false,
    installMode: 'environment',
    estimatedDownloadBytes: 0,
  },
  {
    id: 'data-science',
    section: 'B1',
    label: 'Data science packages',
    required: false,
    installMode: 'on-demand',
    estimatedDownloadBytes: 200 * 1024 * 1024,
    cleanup: { relativePath: 'components/data-science' },
  },
  {
    id: 'playwright-chromium',
    section: 'B2',
    label: 'Playwright Chromium',
    required: false,
    installMode: 'on-demand',
    estimatedDownloadBytes: 150 * 1024 * 1024,
    cleanup: { relativePath: 'components/playwright-chromium' },
  },
  {
    id: 'tesseract-ocr',
    section: 'B3',
    label: 'Tesseract OCR',
    required: false,
    installMode: 'on-demand',
    estimatedDownloadBytes: 120 * 1024 * 1024,
    cleanup: { relativePath: 'components/tesseract-ocr' },
  },
  {
    id: 'pandoc',
    section: 'B4',
    label: 'Pandoc',
    required: false,
    installMode: 'on-demand',
    estimatedDownloadBytes: 80 * 1024 * 1024,
    cleanup: { relativePath: 'components/pandoc' },
  },
  {
    id: 'mingit',
    section: 'B6',
    label: 'MinGit',
    required: false,
    installMode: 'on-demand',
    estimatedDownloadBytes: 80 * 1024 * 1024,
    cleanup: { relativePath: 'components/mingit' },
  },
  {
    id: 'sandbox-isolation',
    section: 'C1',
    label: 'WSL2 or Docker sandbox isolation',
    required: false,
    installMode: 'system',
    estimatedDownloadBytes: 0,
  },
]);

function envValue(env, keys) {
  for (const key of keys) {
    const value = env?.[key];
    if (typeof value === 'string' && value.trim()) {
      return { key, value: value.trim() };
    }
  }
  return null;
}

function redactProxyUrl(value) {
  const text = redactText(value) || '';
  return text.replace(/^([a-z][a-z0-9+.-]*:\/\/)([^:@/\s]+):([^@/\s]+)@/i, '$1$2:[REDACTED]@');
}

function configuredFromEnv(env, keys, detail) {
  const match = envValue(env, keys);
  if (!match) return { status: 'missing', detail };
  return { status: 'configured', source: match.key, detail };
}

function detectDependency(item, options) {
  const env = options.env || {};
  const platform = options.platform || process.platform;
  const sandboxStartup = options.sandboxStartup || null;

  if (item.id === 'node') {
    return {
      status: 'available',
      version: process.version,
      detail: process.execPath ? 'host process runtime' : 'process runtime',
    };
  }

  if (item.id === 'sqlite') {
    return process.versions?.sqlite
      ? { status: 'available', version: process.versions.sqlite, detail: 'node:sqlite available' }
      : { status: 'unknown', detail: 'sqlite binding not probed by this endpoint' };
  }

  if (item.id === 'webview2') {
    const configured = envValue(env, ['KCW_WEBVIEW2_MODE', 'WEBVIEW2_RELEASE_CHANNEL_PREFERENCE']);
    if (configured) return { status: 'configured', source: configured.key, detail: configured.value };
    return platform === 'win32'
      ? { status: 'unknown', detail: 'installer or Windows runtime probe required' }
      : { status: 'not_applicable', detail: 'Windows-only dependency' };
  }

  if (item.id === 'python-embedded') {
    return configuredFromEnv(env, ['KCW_EMBEDDED_PYTHON', 'KCW_PYTHON_HOME'], 'embedded Python path configured');
  }

  if (item.id === 'cjk-fonts') {
    return configuredFromEnv(env, ['KCW_CJK_FONT_DIR', 'KCW_CJK_FONT'], 'CJK font bundle path configured');
  }

  if (item.id === 'vc-runtime') {
    return platform === 'win32'
      ? { status: 'unknown', detail: 'installer runtime probe required' }
      : { status: 'not_applicable', detail: 'Windows-only dependency' };
  }

  if (item.id === 'proxy') {
    const proxy = envValue(env, ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'https_proxy', 'http_proxy', 'all_proxy']);
    if (!proxy) return { status: 'unknown', detail: 'no proxy environment variable configured' };
    return { status: 'configured', source: proxy.key, detail: redactProxyUrl(proxy.value) };
  }

  if (item.id === 'sandbox-isolation') {
    if (sandboxStartup?.info?.backend) {
      return {
        status: sandboxStartup.info.networkIsolated ? 'available' : 'degraded',
        detail: redactText(sandboxStartup.info.userMessage || sandboxStartup.info.backend),
      };
    }
    return { status: 'unknown', detail: 'sandbox startup probe not attached' };
  }

  const marker = envValue(env, [`KCW_${item.id.toUpperCase().replace(/-/g, '_')}_HOME`]);
  if (marker) return { status: 'configured', source: marker.key, detail: `${item.label} path configured` };
  return { status: 'missing', detail: 'optional on-demand component is not installed' };
}

function summarize(dependencies) {
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
