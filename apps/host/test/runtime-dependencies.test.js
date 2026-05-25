import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../src/server.js';
import {
  buildRuntimeDependencyCleanupPlan,
  buildRuntimeDependencyInstallPlan,
  buildRuntimeDependencyUpdatePlan,
} from '../src/runtime/dependency-install-plan.js';
import { getRuntimeDependencyStatus } from '../src/runtime/dependencies.js';
import { makeTestWorkspace } from './test-fixtures.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');

async function withServer(config, fn) {
  const server = createServer({ requireAuth: false, enableScheduler: false, ...config });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function postJson(base, route, body) {
  const response = await fetch(`${base}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

test('GET /api/runtime/dependencies reports runtime catalog without leaking proxy credentials', async () => {
  const trustedRoot = makeTestWorkspace('kcw-runtime-deps');
  await withServer({
    trustedRoot,
    runtimeDependencyEnv: {
      HTTPS_PROXY: 'http://proxy-user:proxy-password@127.0.0.1:7890',
      KCW_EMBEDDED_PYTHON: 'C:\\AgentCowork\\runtime\\python\\python.exe',
      KCW_WEBVIEW2_MODE: 'evergreen',
    },
  }, async (base) => {
    const response = await fetch(`${base}/api/runtime/dependencies`);
    assert.equal(response.status, 200);

    const raw = await response.text();
    assert.ok(!raw.includes('proxy-password'), 'runtime dependency status leaked proxy password');
    const body = JSON.parse(raw);
    assert.equal(body.ok, true);
    assert.equal(body.service, 'agent-cowork-host');
    assert.equal(body.platform, process.platform);
    assert.ok(Array.isArray(body.dependencies));
    assert.ok(body.dependencies.length >= 6);
    assert.ok(body.summary.total >= body.dependencies.length);

    const byId = Object.fromEntries(body.dependencies.map((item) => [item.id, item]));
    assert.equal(byId.node.status, 'available');
    assert.equal(byId.node.label, 'Node.js 运行时');
    assert.match(byId.node.description, /本地 Node/);
    assert.match(byId.node.detail, /host 进程/);
    assert.match(byId.node.version, /^v\d+\./);
    assert.equal(byId.node.required, true);
    assert.equal(byId.webview2.installMode, 'system');
    assert.equal(byId.webview2.label, 'Microsoft Edge WebView2');
    assert.match(byId.webview2.description, /桌面外壳/);
    assert.match(byId['data-science'].label, /数据分析/);
    assert.match(byId['data-science'].description, /按需安装/);
    assert.equal(byId.ffmpeg.section, 'B5');
    assert.equal(byId.ffmpeg.installMode, 'on-demand');
    assert.match(byId.ffmpeg.description, /音视频处理/);
    assert.equal(byId.mingit.section, 'B6');
    assert.equal(byId.mingit.installMode, 'on-demand');
    assert.equal(byId['python-embedded'].status, 'configured');
    assert.equal(byId['python-embedded'].detail, '内置 Python 路径已配置');
    assert.equal(byId['cjk-fonts'].section, 'A3');
    assert.equal(byId['cjk-fonts'].required, true);
    assert.equal(byId.proxy.status, 'configured');
    assert.equal(byId.proxy.detail, 'http://proxy-user:[REDACTED]@127.0.0.1:7890');
  });
});

test('runtime dependency status detects configured MinGit before probing system git', () => {
  let called = false;
  const status = getRuntimeDependencyStatus({
    env: {
      KCW_MINGIT_HOME: 'C:\\Users\\Alice\\AppData\\Roaming\\AgentCowork\\components\\mingit',
      KCW_VC_RUNTIME_INSTALLED: '1',
    },
    spawnSync: () => {
      called = true;
      return { status: 1 };
    },
  });

  const mingit = status.dependencies.find((item) => item.id === 'mingit');
  assert.equal(called, false);
  assert.equal(mingit.status, 'configured');
  assert.equal(mingit.source, 'KCW_MINGIT_HOME');
  assert.equal(mingit.detail, 'Git 运行时路径已配置');
});

test('runtime dependency status reports system git availability', () => {
  const status = getRuntimeDependencyStatus({
    env: {},
    spawnSync: (command, args, options) => {
      assert.equal(command, 'git');
      assert.deepEqual(args, ['--version']);
      assert.equal(options.windowsHide, true);
      return { status: 0, stdout: 'git version 2.46.0.windows.1\n', stderr: '' };
    },
  });

  const mingit = status.dependencies.find((item) => item.id === 'mingit');
  assert.equal(mingit.status, 'available');
  assert.equal(mingit.version, '2.46.0.windows.1');
  assert.match(mingit.detail, /系统 Git 可用/);
});

test('runtime dependency status marks MinGit missing when git is unavailable', () => {
  const status = getRuntimeDependencyStatus({
    env: {},
    spawnSync: () => ({ status: 1, stdout: '', stderr: 'git not found' }),
  });

  const mingit = status.dependencies.find((item) => item.id === 'mingit');
  assert.equal(mingit.status, 'missing');
  assert.match(mingit.detail, /按需安装 MinGit/);
});

test('runtime dependency status detects configured VC runtime before registry probing', () => {
  let called = false;
  const status = getRuntimeDependencyStatus({
    env: { KCW_VC_RUNTIME_INSTALLED: '1', KCW_MINGIT_HOME: 'C:\\AgentCowork\\components\\mingit' },
    platform: 'win32',
    spawnSync: () => {
      called = true;
      return { status: 1 };
    },
  });

  const vcRuntime = status.dependencies.find((item) => item.id === 'vc-runtime');
  assert.equal(called, false);
  assert.equal(vcRuntime.status, 'configured');
  assert.equal(vcRuntime.source, 'KCW_VC_RUNTIME_INSTALLED');
});

test('runtime dependency status reports VC runtime registry availability on Windows', () => {
  const status = getRuntimeDependencyStatus({
    env: {},
    platform: 'win32',
    spawnSync: (command, args, options) => {
      if (command === 'git') return { status: 1, stdout: '', stderr: '' };
      assert.equal(command, 'reg');
      assert.equal(args[0], 'query');
      assert.match(args[1], /\\Runtimes\\x64$/);
      assert.equal(args.at(-1), 'Installed');
      assert.equal(options.windowsHide, true);
      return {
        status: 0,
        stdout: 'Installed    REG_DWORD    0x1\nVersion    REG_SZ    v14.40.33810.0\n',
        stderr: '',
      };
    },
  });

  const vcRuntime = status.dependencies.find((item) => item.id === 'vc-runtime');
  assert.equal(vcRuntime.status, 'available');
  assert.equal(vcRuntime.version, 'v14.40.33810.0');
  assert.match(vcRuntime.detail, /VC\+\+ 运行库可用/);
});

test('runtime dependency status accepts x86 VC runtime when x64 is absent', () => {
  const queried = [];
  const status = getRuntimeDependencyStatus({
    env: { KCW_MINGIT_HOME: 'C:\\AgentCowork\\components\\mingit' },
    platform: 'win32',
    spawnSync: (command, args) => {
      queried.push(args[1]);
      if (/\\Runtimes\\x86$/.test(args[1])) {
        return { status: 0, stdout: 'Installed    REG_DWORD    0x1\n', stderr: '' };
      }
      return { status: 1, stdout: '', stderr: 'not found' };
    },
  });

  const vcRuntime = status.dependencies.find((item) => item.id === 'vc-runtime');
  assert.deepEqual(queried, [
    'HKLM\\SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x64',
    'HKLM\\SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x86',
  ]);
  assert.equal(vcRuntime.status, 'available');
  assert.match(vcRuntime.detail, /x86/);
});

test('runtime dependency status marks VC runtime missing on Windows when registry flag is absent', () => {
  const status = getRuntimeDependencyStatus({
    env: {},
    platform: 'win32',
    spawnSync: (command) => {
      if (command === 'git') return { status: 1, stdout: '', stderr: '' };
      return { status: 1, stdout: '', stderr: 'not found' };
    },
  });

  const vcRuntime = status.dependencies.find((item) => item.id === 'vc-runtime');
  assert.equal(vcRuntime.status, 'missing');
  assert.match(vcRuntime.detail, /安装器需要补齐/);
});

test('runtime dependency status skips VC runtime probing off Windows', () => {
  let called = false;
  const status = getRuntimeDependencyStatus({
    env: { KCW_MINGIT_HOME: 'C:\\AgentCowork\\components\\mingit' },
    platform: 'linux',
    spawnSync: () => {
      called = true;
      return { status: 0 };
    },
  });

  const vcRuntime = status.dependencies.find((item) => item.id === 'vc-runtime');
  assert.equal(called, false);
  assert.equal(vcRuntime.status, 'not_applicable');
});

test('runtime dependency status reports configured CJK font directory availability', () => {
  const root = makeTestWorkspace('kcw-runtime-fonts');
  const fontDir = path.join(root, 'fonts');
  fs.mkdirSync(fontDir, { recursive: true });
  fs.writeFileSync(path.join(fontDir, 'NotoSansCJKsc-Regular.otf'), '');

  const status = getRuntimeDependencyStatus({
    env: {
      KCW_CJK_FONT_DIR: fontDir,
      KCW_MINGIT_HOME: 'C:\\AgentCowork\\components\\mingit',
      KCW_VC_RUNTIME_INSTALLED: '1',
    },
  });

  const cjkFonts = status.dependencies.find((item) => item.id === 'cjk-fonts');
  assert.equal(cjkFonts.status, 'available');
  assert.equal(cjkFonts.source, 'KCW_CJK_FONT_DIR');
  assert.equal(cjkFonts.detail, 'CJK 字体包可用');
});

test('runtime dependency status rejects missing CJK font paths', () => {
  const status = getRuntimeDependencyStatus({
    env: {
      KCW_CJK_FONT: 'C:\\AgentCowork\\runtime\\fonts\\missing.otf',
      KCW_MINGIT_HOME: 'C:\\AgentCowork\\components\\mingit',
      KCW_VC_RUNTIME_INSTALLED: '1',
    },
  });

  const cjkFonts = status.dependencies.find((item) => item.id === 'cjk-fonts');
  assert.equal(cjkFonts.status, 'missing');
  assert.equal(cjkFonts.source, 'KCW_CJK_FONT');
  assert.match(cjkFonts.detail, /未包含字体文件/);
});

test('runtime dependency status accepts a configured single CJK font file', () => {
  const root = makeTestWorkspace('kcw-runtime-font-file');
  const fontFile = path.join(root, 'NotoSansCJKsc-Regular.ttc');
  fs.writeFileSync(fontFile, '');

  const status = getRuntimeDependencyStatus({
    env: {
      KCW_CJK_FONT: fontFile,
      KCW_MINGIT_HOME: 'C:\\AgentCowork\\components\\mingit',
      KCW_VC_RUNTIME_INSTALLED: '1',
    },
  });

  const cjkFonts = status.dependencies.find((item) => item.id === 'cjk-fonts');
  assert.equal(cjkFonts.status, 'available');
  assert.equal(cjkFonts.source, 'KCW_CJK_FONT');
});

test('runtime dependency status rejects empty or non-font CJK directories', () => {
  const root = makeTestWorkspace('kcw-runtime-font-empty');
  const emptyDir = path.join(root, 'empty-fonts');
  const textDir = path.join(root, 'text-fonts');
  fs.mkdirSync(emptyDir, { recursive: true });
  fs.mkdirSync(textDir, { recursive: true });
  fs.writeFileSync(path.join(textDir, 'README.txt'), 'not a font');

  const emptyStatus = getRuntimeDependencyStatus({
    env: {
      KCW_CJK_FONT_DIR: emptyDir,
      KCW_MINGIT_HOME: 'C:\\AgentCowork\\components\\mingit',
      KCW_VC_RUNTIME_INSTALLED: '1',
    },
  });
  const textStatus = getRuntimeDependencyStatus({
    env: {
      KCW_CJK_FONT_DIR: textDir,
      KCW_MINGIT_HOME: 'C:\\AgentCowork\\components\\mingit',
      KCW_VC_RUNTIME_INSTALLED: '1',
    },
  });

  assert.equal(emptyStatus.dependencies.find((item) => item.id === 'cjk-fonts').status, 'missing');
  assert.equal(textStatus.dependencies.find((item) => item.id === 'cjk-fonts').status, 'missing');
});

test('runtime dependency status reports data science component availability', () => {
  const root = makeTestWorkspace('kcw-runtime-data-science');
  const sitePackages = path.join(root, 'Lib', 'site-packages');
  for (const pkg of ['pandas', 'numpy', 'matplotlib']) {
    fs.mkdirSync(path.join(sitePackages, pkg), { recursive: true });
  }

  const status = getRuntimeDependencyStatus({
    env: {
      KCW_DATA_SCIENCE_HOME: root,
      KCW_MINGIT_HOME: 'C:\\AgentCowork\\components\\mingit',
      KCW_VC_RUNTIME_INSTALLED: '1',
    },
  });

  const component = status.dependencies.find((item) => item.id === 'data-science');
  assert.equal(component.status, 'available');
  assert.equal(component.source, 'KCW_DATA_SCIENCE_HOME');
  assert.equal(component.detail, '数据分析组件可用');
});

test('runtime dependency status rejects incomplete data science components', () => {
  const root = makeTestWorkspace('kcw-runtime-data-science-missing');
  fs.mkdirSync(path.join(root, 'Lib', 'site-packages', 'pandas'), { recursive: true });
  fs.mkdirSync(path.join(root, 'Lib', 'site-packages', 'numpy'), { recursive: true });

  const status = getRuntimeDependencyStatus({
    env: {
      KCW_DATA_SCIENCE_HOME: root,
      KCW_MINGIT_HOME: 'C:\\AgentCowork\\components\\mingit',
      KCW_VC_RUNTIME_INSTALLED: '1',
    },
  });

  const component = status.dependencies.find((item) => item.id === 'data-science');
  assert.equal(component.status, 'missing');
  assert.equal(component.source, 'KCW_DATA_SCIENCE_HOME');
  assert.match(component.detail, /pandas\/numpy\/matplotlib/);
});

test('runtime dependency status accepts data science venv with lowercase site-packages', () => {
  const root = makeTestWorkspace('kcw-runtime-data-science-venv');
  const sitePackages = path.join(root, 'lib', 'site-packages');
  for (const pkg of ['pandas', 'numpy', 'matplotlib']) {
    fs.mkdirSync(path.join(sitePackages, pkg), { recursive: true });
  }

  const status = getRuntimeDependencyStatus({
    env: {
      KCW_DATA_SCIENCE_VENV: root,
      KCW_MINGIT_HOME: 'C:\\AgentCowork\\components\\mingit',
      KCW_VC_RUNTIME_INSTALLED: '1',
    },
  });

  const component = status.dependencies.find((item) => item.id === 'data-science');
  assert.equal(component.status, 'available');
  assert.equal(component.source, 'KCW_DATA_SCIENCE_VENV');
});

test('runtime dependency status reports OCR component availability with Chinese tessdata', () => {
  const root = makeTestWorkspace('kcw-runtime-ocr');
  fs.mkdirSync(path.join(root, 'tessdata'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tessdata', 'chi_sim.traineddata'), '');

  const status = getRuntimeDependencyStatus({
    env: {
      KCW_TESSERACT_HOME: root,
      KCW_MINGIT_HOME: 'C:\\AgentCowork\\components\\mingit',
      KCW_VC_RUNTIME_INSTALLED: '1',
    },
  });

  const component = status.dependencies.find((item) => item.id === 'tesseract-ocr');
  assert.equal(component.status, 'available');
  assert.equal(component.source, 'KCW_TESSERACT_HOME');
  assert.equal(component.detail, 'OCR 中文语言包可用');
});

test('runtime dependency status rejects OCR components without Chinese tessdata', () => {
  const root = makeTestWorkspace('kcw-runtime-ocr-missing-lang');
  fs.mkdirSync(path.join(root, 'tessdata'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tessdata', 'eng.traineddata'), '');

  const status = getRuntimeDependencyStatus({
    env: {
      KCW_TESSDATA_PREFIX: path.join(root, 'tessdata'),
      KCW_MINGIT_HOME: 'C:\\AgentCowork\\components\\mingit',
      KCW_VC_RUNTIME_INSTALLED: '1',
    },
  });

  const component = status.dependencies.find((item) => item.id === 'tesseract-ocr');
  assert.equal(component.status, 'missing');
  assert.equal(component.source, 'KCW_TESSDATA_PREFIX');
  assert.match(component.detail, /中文语言包/);
});

test('runtime dependency status accepts traditional Chinese OCR tessdata', () => {
  const root = makeTestWorkspace('kcw-runtime-ocr-tra');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'chi_tra.traineddata'), '');

  const status = getRuntimeDependencyStatus({
    env: {
      KCW_TESSDATA_PREFIX: root,
      KCW_MINGIT_HOME: 'C:\\AgentCowork\\components\\mingit',
      KCW_VC_RUNTIME_INSTALLED: '1',
    },
  });

  const component = status.dependencies.find((item) => item.id === 'tesseract-ocr');
  assert.equal(component.status, 'available');
  assert.equal(component.source, 'KCW_TESSDATA_PREFIX');
});

test('runtime dependency status reports Pandoc component availability from home directory', () => {
  const root = makeTestWorkspace('kcw-runtime-pandoc');
  const binDir = path.join(root, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, process.platform === 'win32' ? 'pandoc.exe' : 'pandoc'), '');

  const status = getRuntimeDependencyStatus({
    env: {
      KCW_PANDOC_HOME: root,
      KCW_MINGIT_HOME: 'C:\\AgentCowork\\components\\mingit',
      KCW_VC_RUNTIME_INSTALLED: '1',
    },
  });

  const component = status.dependencies.find((item) => item.id === 'pandoc');
  assert.equal(component.status, 'available');
  assert.equal(component.source, 'KCW_PANDOC_HOME');
  assert.equal(component.detail, 'Pandoc 组件可用');
});

test('runtime dependency status rejects non-pandoc executable paths', () => {
  const root = makeTestWorkspace('kcw-runtime-pandoc-bad');
  const toolPath = path.join(root, 'not-pandoc.exe');
  fs.writeFileSync(toolPath, '');

  const status = getRuntimeDependencyStatus({
    env: {
      KCW_PANDOC_EXE: toolPath,
      KCW_MINGIT_HOME: 'C:\\AgentCowork\\components\\mingit',
      KCW_VC_RUNTIME_INSTALLED: '1',
    },
  });

  const component = status.dependencies.find((item) => item.id === 'pandoc');
  assert.equal(component.status, 'missing');
  assert.equal(component.source, 'KCW_PANDOC_EXE');
  assert.match(component.detail, /名称不匹配/);
});

test('runtime dependency status accepts a configured Pandoc executable', () => {
  const root = makeTestWorkspace('kcw-runtime-pandoc-exe');
  const toolPath = path.join(root, process.platform === 'win32' ? 'pandoc.exe' : 'pandoc');
  fs.writeFileSync(toolPath, '');

  const status = getRuntimeDependencyStatus({
    env: {
      KCW_PANDOC_EXE: toolPath,
      KCW_MINGIT_HOME: 'C:\\AgentCowork\\components\\mingit',
      KCW_VC_RUNTIME_INSTALLED: '1',
    },
  });

  const component = status.dependencies.find((item) => item.id === 'pandoc');
  assert.equal(component.status, 'available');
  assert.equal(component.source, 'KCW_PANDOC_EXE');
});

test('runtime dependency status reports Chromium component availability from Playwright home', () => {
  const root = makeTestWorkspace('kcw-runtime-chromium');
  const chromeDir = path.join(root, 'chrome-win');
  fs.mkdirSync(chromeDir, { recursive: true });
  fs.writeFileSync(path.join(chromeDir, 'chrome.exe'), '');

  const status = getRuntimeDependencyStatus({
    env: {
      KCW_PLAYWRIGHT_CHROMIUM_HOME: root,
      KCW_MINGIT_HOME: 'C:\\AgentCowork\\components\\mingit',
      KCW_VC_RUNTIME_INSTALLED: '1',
    },
  });

  const component = status.dependencies.find((item) => item.id === 'playwright-chromium');
  assert.equal(component.status, 'available');
  assert.equal(component.source, 'KCW_PLAYWRIGHT_CHROMIUM_HOME');
  assert.equal(component.detail, '浏览器自动化组件可用');
});

test('runtime dependency status rejects non-Chromium executable paths', () => {
  const root = makeTestWorkspace('kcw-runtime-chromium-bad');
  const toolPath = path.join(root, 'firefox.exe');
  fs.writeFileSync(toolPath, '');

  const status = getRuntimeDependencyStatus({
    env: {
      KCW_CHROMIUM_EXECUTABLE: toolPath,
      KCW_MINGIT_HOME: 'C:\\AgentCowork\\components\\mingit',
      KCW_VC_RUNTIME_INSTALLED: '1',
    },
  });

  const component = status.dependencies.find((item) => item.id === 'playwright-chromium');
  assert.equal(component.status, 'missing');
  assert.equal(component.source, 'KCW_CHROMIUM_EXECUTABLE');
  assert.match(component.detail, /名称不匹配/);
});

test('runtime dependency plan routes expose install cleanup and update plans without side effects', async () => {
  const trustedRoot = makeTestWorkspace('kcw-runtime-dep-plan-routes');
  const appDataRoot = 'C:\\Users\\Alice\\AppData\\Roaming\\AgentCowork';
  await withServer({ trustedRoot, runtimeDependencyAppDataRoot: appDataRoot }, async (base) => {
    const install = await postJson(base, '/api/runtime/dependencies/install-plan', {
      selectedIds: ['data-science', 'playwright-chromium', 'pandoc', 'ffmpeg', 'mingit'],
      freeBytes: 250 * 1024 * 1024,
    });
    assert.equal(install.status, 200);
    assert.equal(install.body.ok, false);
    assert.equal(install.body.disk.status, 'insufficient');
    assert.deepEqual(install.body.components.map((item) => item.id), ['data-science', 'playwright-chromium', 'pandoc', 'ffmpeg', 'mingit']);

    const cleanup = await postJson(base, '/api/runtime/dependencies/cleanup-plan', {
      selectedIds: ['tesseract-ocr', 'pandoc', 'ffmpeg', 'mingit'],
      keepUserData: false,
    });
    assert.equal(cleanup.status, 200);
    assert.equal(cleanup.body.appDataRoot, appDataRoot);
    assert.ok(cleanup.body.targets.find((item) => item.id === 'tesseract-ocr').path.endsWith('\\components\\tesseract-ocr'));
    assert.ok(cleanup.body.targets.find((item) => item.id === 'pandoc').path.endsWith('\\components\\pandoc'));
    assert.ok(cleanup.body.targets.find((item) => item.id === 'ffmpeg').path.endsWith('\\components\\ffmpeg'));
    assert.ok(cleanup.body.targets.find((item) => item.id === 'mingit').path.endsWith('\\components\\mingit'));
    assert.equal(cleanup.body.targets.find((item) => item.id === 'user-data').requiresConfirmation, true);
    assert.equal(cleanup.body.targets.every((item) => item.action === 'remove'), true);

    const update = await postJson(base, '/api/runtime/dependencies/update-plan', {
      selectedIds: ['data-science', 'pandoc', 'ffmpeg', 'mingit'],
      currentVersion: '0.2.0',
      targetVersion: '0.2.1',
    });
    assert.equal(update.status, 200);
    assert.equal(update.body.appDataRoot, appDataRoot);
    assert.equal(update.body.destructiveActions.length, 0);
    assert.equal(update.body.components[0].action, 'preserve');
    assert.ok(update.body.retained.some((item) => item.id === 'user-data'));
  });
});

test('runtime dependency install plan blocks downloads when disk space is insufficient', () => {
  const plan = buildRuntimeDependencyInstallPlan({
    selectedIds: ['data-science', 'playwright-chromium', 'pandoc', 'ffmpeg', 'mingit'],
    freeBytes: 250 * 1024 * 1024,
  });

  assert.equal(plan.ok, false);
  assert.equal(plan.disk.availableBytes, 250 * 1024 * 1024);
  assert.ok(plan.disk.requiredBytes > plan.disk.availableBytes);
  assert.match(plan.disk.message, /磁盘空间不足/);
  assert.deepEqual(plan.components.map((item) => item.id), ['data-science', 'playwright-chromium', 'pandoc', 'ffmpeg', 'mingit']);
  assert.equal(plan.components.every((item) => item.installMode === 'on-demand'), true);
  assert.ok(plan.components.find((item) => item.id === 'ffmpeg').estimatedDownloadBytes > 0);
});

test('runtime dependency install plan accepts required bundled defaults without optional downloads', () => {
  const plan = buildRuntimeDependencyInstallPlan({
    selectedIds: ['node', 'python-embedded', 'cjk-fonts'],
    freeBytes: 400 * 1024 * 1024,
  });

  assert.equal(plan.ok, true);
  assert.equal(plan.disk.requiredBytes, 0);
  assert.equal(plan.disk.status, 'ok');
});

test('runtime dependency cleanup plan removes on-demand components while preserving user data', () => {
  const root = 'C:\\Users\\Alice\\AppData\\Roaming\\AgentCowork';
  const plan = buildRuntimeDependencyCleanupPlan({
    appDataRoot: root,
    selectedIds: ['data-science', 'playwright-chromium', 'pandoc', 'ffmpeg', 'mingit'],
    keepUserData: true,
  });

  assert.equal(plan.ok, true);
  assert.equal(plan.mode, 'preserve-user-data');
  assert.deepEqual(plan.targets.map((item) => item.id), ['data-science', 'playwright-chromium', 'pandoc', 'ffmpeg', 'mingit', 'runtime-cache']);
  assert.equal(plan.targets.some((item) => item.kind === 'user-data'), false);
  assert.equal(plan.retained[0].id, 'user-data');
  for (const target of plan.targets) {
    assert.ok(target.path.startsWith(plan.appDataRoot), `${target.path} escaped cleanup root`);
  }
});

test('runtime dependency cleanup plan requires confirmation before deleting user data', () => {
  const plan = buildRuntimeDependencyCleanupPlan({
    appDataRoot: 'C:\\Users\\Alice\\AppData\\Roaming\\AgentCowork',
    selectedIds: ['tesseract-ocr', 'unknown-component'],
    keepUserData: false,
  });

  assert.equal(plan.ok, false);
  assert.deepEqual(plan.unknownIds, ['unknown-component']);
  assert.equal(plan.mode, 'remove-user-data');
  const userData = plan.targets.find((item) => item.id === 'user-data');
  assert.equal(userData.requiresConfirmation, true);
  assert.match(plan.warnings[0], /二次确认/);
});

test('runtime dependency cleanup plan refuses non-AgentCowork roots', () => {
  assert.throws(
    () => buildRuntimeDependencyCleanupPlan({ appDataRoot: 'C:\\Users\\Alice\\AppData\\Roaming' }),
    /must end with AgentCowork/,
  );
});

test('NSIS uninstall hook deletes AgentCowork AppData only after delete-data confirmation', () => {
  const tauriRoot = path.join(repoRoot, 'apps/windows-client/src-tauri');
  const config = JSON.parse(fs.readFileSync(path.join(tauriRoot, 'tauri.conf.json'), 'utf8'));
  const hooksRel = config.bundle?.windows?.nsis?.installerHooks;
  assert.equal(hooksRel, './windows/nsis-hooks.nsh');

  const hookText = fs.readFileSync(path.join(tauriRoot, hooksRel), 'utf8');
  assert.match(hookText, /NSIS_HOOK_POSTUNINSTALL/);
  assert.match(hookText, /\$DeleteAppDataCheckboxState = 1/);
  assert.match(hookText, /\$UpdateMode <> 1/);
  const cleanupLines = hookText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('RmDir'));
  assert.deepEqual(cleanupLines, ['RmDir /r "$APPDATA\\AgentCowork"']);
  assert.doesNotMatch(hookText, /RmDir\s+\/r\s+"\$APPDATA"/);
});

test('runtime dependency update plan preserves AppData components, venv and user data', () => {
  const root = 'C:\\Users\\Alice\\AppData\\Roaming\\AgentCowork';
  const plan = buildRuntimeDependencyUpdatePlan({
    appDataRoot: root,
    currentVersion: '0.2.0',
    targetVersion: '0.2.1',
    selectedIds: ['data-science', 'playwright-chromium', 'pandoc', 'ffmpeg', 'mingit'],
  });

  assert.equal(plan.ok, true);
  assert.equal(plan.mode, 'preserve-on-update');
  assert.equal(plan.destructiveActions.length, 0);
  assert.deepEqual(plan.components.map((item) => item.id), ['data-science', 'playwright-chromium', 'pandoc', 'ffmpeg', 'mingit']);
  assert.ok(plan.components.find((item) => item.id === 'ffmpeg').path.endsWith('\\components\\ffmpeg'));
  assert.ok(plan.components.find((item) => item.id === 'pandoc').path.endsWith('\\components\\pandoc'));
  assert.ok(plan.components.find((item) => item.id === 'mingit').path.endsWith('\\components\\mingit'));
  assert.ok(plan.retained.some((item) => item.id === 'user-data' && item.path === plan.appDataRoot));
  assert.ok(plan.retained.some((item) => item.id === 'python-venv' && item.path.endsWith('\\venv')));
  assert.ok(plan.retained.some((item) => item.id === 'components-root' && item.path.endsWith('\\components')));
  for (const target of [...plan.retained, ...plan.components]) {
    assert.equal(target.action, 'preserve');
    assert.ok(target.path === plan.appDataRoot || target.path.startsWith(`${plan.appDataRoot}\\`), `${target.path} escaped update root`);
  }
});

test('runtime dependency update plan reports unknown components without destructive fallback', () => {
  const plan = buildRuntimeDependencyUpdatePlan({
    appDataRoot: 'C:\\Users\\Alice\\AppData\\Roaming\\AgentCowork',
    selectedIds: ['data-science', 'unknown-component'],
  });

  assert.equal(plan.ok, false);
  assert.deepEqual(plan.unknownIds, ['unknown-component']);
  assert.equal(plan.destructiveActions.length, 0);
  assert.equal(plan.components[0].action, 'preserve');
});
