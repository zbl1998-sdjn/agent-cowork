import { redactText } from '../security/redaction.js';
import { detectDataScienceRuntime } from './data-science-runtime.js';
import { detectCjkFonts } from './font-runtime.js';
import { detectGitRuntime } from './git-runtime.js';
import { detectOcrRuntime } from './ocr-runtime.js';
import { detectVcRuntime } from './windows-runtime.js';

export const RUNTIME_DEPENDENCY_CATALOG = Object.freeze([
  {
    id: 'node',
    section: 'A4',
    label: 'Node.js 运行时',
    description: '随应用提供的本地 Node 执行环境，用于启动 host 与内置脚本。',
    required: true,
    installMode: 'bundled',
    estimatedDownloadBytes: 0,
  },
  {
    id: 'webview2',
    section: 'A1',
    label: 'Microsoft Edge WebView2',
    description: 'Windows 桌面外壳渲染界面所需的系统运行时。',
    required: true,
    installMode: 'system',
    estimatedDownloadBytes: 0,
  },
  {
    id: 'python-embedded',
    section: 'A2',
    label: '内置 Python',
    description: '随包提供的 Python 环境，用于可选数据处理与脚本能力。',
    required: true,
    installMode: 'bundled',
    estimatedDownloadBytes: 0,
  },
  {
    id: 'cjk-fonts', section: 'A3', label: '中日韩字体包',
    description: '确保中文、日文、韩文内容在安装版中正常显示。',
    required: true, installMode: 'bundled', estimatedDownloadBytes: 0,
  },
  {
    id: 'vc-runtime',
    section: 'A5',
    label: 'Visual C++ 运行库',
    description: 'Windows 原生依赖所需的 VC++ 运行库。',
    required: true,
    installMode: 'system',
    estimatedDownloadBytes: 0,
  },
  {
    id: 'sqlite',
    section: 'F2',
    label: 'SQLite 存储运行时',
    description: '用于本地会话、记录与轻量索引存储。',
    required: true,
    installMode: 'bundled',
    estimatedDownloadBytes: 0,
  },
  {
    id: 'proxy',
    section: 'F1',
    label: '网络代理配置',
    description: '读取系统或环境代理，用于模型调用和连接器访问外网。',
    required: false,
    installMode: 'environment',
    estimatedDownloadBytes: 0,
  },
  {
    id: 'data-science',
    section: 'B1',
    label: '数据分析组件',
    description: '按需安装的 Python 数据处理依赖，用于表格、统计和分析工作流。',
    required: false,
    installMode: 'on-demand',
    estimatedDownloadBytes: 200 * 1024 * 1024,
    cleanup: { relativePath: 'components/data-science' },
  },
  {
    id: 'playwright-chromium',
    section: 'B2',
    label: '浏览器自动化组件',
    description: '按需安装 Chromium 浏览器，用于网页自动化和截图验收。',
    required: false,
    installMode: 'on-demand',
    estimatedDownloadBytes: 150 * 1024 * 1024,
    cleanup: { relativePath: 'components/playwright-chromium' },
  },
  {
    id: 'tesseract-ocr',
    section: 'B3',
    label: 'OCR 文字识别组件',
    description: '按需安装 OCR 引擎，用于图片和扫描件文字提取。',
    required: false,
    installMode: 'on-demand',
    estimatedDownloadBytes: 120 * 1024 * 1024,
    cleanup: { relativePath: 'components/tesseract-ocr' },
  },
  {
    id: 'pandoc',
    section: 'B4',
    label: '文档转换组件',
    description: '按需安装 Pandoc，用于 Office、Markdown 等文档转换链路。',
    required: false,
    installMode: 'on-demand',
    estimatedDownloadBytes: 80 * 1024 * 1024,
    cleanup: { relativePath: 'components/pandoc' },
  },
  {
    id: 'ffmpeg',
    section: 'B5',
    label: '音视频处理组件',
    description: '按需安装便携版 ffmpeg，用于未来音视频处理技能。',
    required: false, installMode: 'on-demand', estimatedDownloadBytes: 100 * 1024 * 1024,
    cleanup: { relativePath: 'components/ffmpeg' },
  },
  {
    id: 'mingit', section: 'B6', label: 'Git 轻量运行时',
    description: '按需安装 MinGit，用于仓库连接器和本地版本控制操作。',
    required: false, installMode: 'on-demand', estimatedDownloadBytes: 80 * 1024 * 1024,
    cleanup: { relativePath: 'components/mingit' },
  },
  {
    id: 'sandbox-isolation',
    section: 'C1',
    label: '沙箱隔离运行时',
    description: '使用 WSL2 或 Docker 为工具执行提供网络和文件隔离。',
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

  if (item.id === 'tesseract-ocr') return detectOcrRuntime({ env, fsImpl: options.fsImpl });

  if (item.id === 'mingit') return detectGitRuntime({ env, spawnSync: options.spawnSync });

  const marker = envValue(env, [`KCW_${item.id.toUpperCase().replace(/-/g, '_')}_HOME`]);
  if (marker) return { status: 'configured', source: marker.key, detail: `${item.label} 路径已配置` };
  return { status: 'missing', detail: '可选按需组件尚未安装' };
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
