import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { getRuntimeDependencyStatus } from '../src/runtime/dependencies.js';
import { makeTestWorkspace } from './test-fixtures.js';
import { dependencyById } from './helpers/runtime-dependency.js';

const installedSystemEnv = {
  KCW_MINGIT_HOME: 'C:\\AgentCowork\\components\\mingit',
  KCW_VC_RUNTIME_INSTALLED: '1',
};

test('runtime dependency status reports configured CJK font directory availability', () => {
  const root = makeTestWorkspace('kcw-runtime-fonts');
  const fontDir = path.join(root, 'fonts');
  fs.mkdirSync(fontDir, { recursive: true });
  fs.writeFileSync(path.join(fontDir, 'NotoSansCJKsc-Regular.otf'), '');

  const status = getRuntimeDependencyStatus({
    env: { ...installedSystemEnv, KCW_CJK_FONT_DIR: fontDir },
  });

  const cjkFonts = dependencyById(status, 'cjk-fonts');
  assert.equal(cjkFonts.status, 'available');
  assert.equal(cjkFonts.source, 'KCW_CJK_FONT_DIR');
  assert.equal(cjkFonts.detail, 'CJK 字体包可用');
});

test('runtime dependency status rejects missing CJK font paths', () => {
  const status = getRuntimeDependencyStatus({
    env: { ...installedSystemEnv, KCW_CJK_FONT: 'C:\\AgentCowork\\runtime\\fonts\\missing.otf' },
  });

  const cjkFonts = dependencyById(status, 'cjk-fonts');
  assert.equal(cjkFonts.status, 'missing');
  assert.equal(cjkFonts.source, 'KCW_CJK_FONT');
  assert.match(String(cjkFonts.detail), /未包含字体文件/);
});

test('runtime dependency status accepts a configured single CJK font file', () => {
  const root = makeTestWorkspace('kcw-runtime-font-file');
  const fontFile = path.join(root, 'NotoSansCJKsc-Regular.ttc');
  fs.writeFileSync(fontFile, '');

  const status = getRuntimeDependencyStatus({
    env: { ...installedSystemEnv, KCW_CJK_FONT: fontFile },
  });

  const cjkFonts = dependencyById(status, 'cjk-fonts');
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
    env: { ...installedSystemEnv, KCW_CJK_FONT_DIR: emptyDir },
  });
  const textStatus = getRuntimeDependencyStatus({
    env: { ...installedSystemEnv, KCW_CJK_FONT_DIR: textDir },
  });

  assert.equal(dependencyById(emptyStatus, 'cjk-fonts').status, 'missing');
  assert.equal(dependencyById(textStatus, 'cjk-fonts').status, 'missing');
});

// dogfood 2026-07-09 修复:此前 cjk-fonts 探测只认 KCW_CJK_FONT(_DIR) env,而 PDF/制品渲染实际
// 走 pdf-cjk-font.ts 的系统字体(黑体/雅黑等),导致有中文字体的 Windows 上「渲染正常但面板报缺失」。
test('runtime dependency status reports CJK available via a system font when no env var is set', () => {
  const status = getRuntimeDependencyStatus({
    env: { ...installedSystemEnv },
    fsImpl: {
      // 仅对系统字体候选返回「是字体文件」,其余一律否;不触碰真实磁盘,保持跨机器确定性。
      statSync: (target: string) => ({
        isFile: () => /\.(?:ttf|otf|ttc|woff2)$/i.test(target),
        isDirectory: () => false,
      }),
      readdirSync: () => [],
      existsSync: () => false,
    } as never,
  });
  const cjkFonts = dependencyById(status, 'cjk-fonts');
  assert.equal(cjkFonts.status, 'available');
  assert.equal(cjkFonts.source, 'system');
  assert.match(String(cjkFonts.detail), /系统/);
});

test('runtime dependency status reports CJK missing when neither env nor system fonts are present', () => {
  const status = getRuntimeDependencyStatus({
    env: { ...installedSystemEnv },
    fsImpl: {
      statSync: () => { throw new Error('ENOENT'); },
      readdirSync: () => [],
      existsSync: () => false,
    } as never,
  });
  const cjkFonts = dependencyById(status, 'cjk-fonts');
  assert.equal(cjkFonts.status, 'missing');
});

// dogfood 2026-07-09 修复:python-embedded 探测此前只认 Rust 外壳注入的 KCW_EMBEDDED_PYTHON/
// KCW_PYTHON_HOME env,env 缺失即误报缺失;实际上安装版里 python-embedded/python.exe 就在
// host exe 同级目录,应实地探测回落。
test('runtime dependency status detects bundled python-embedded beside the host exe when no env var is set', () => {
  const bundledPython = 'C:\\Program Files\\Agent Cowork\\python-embedded\\python.exe';
  const probedPaths = new Set<string>();
  const status = getRuntimeDependencyStatus({
    env: { ...installedSystemEnv },
    platform: 'win32',
    execPath: 'C:\\Program Files\\Agent Cowork\\agent-cowork-host.exe',
    fsImpl: {
      existsSync: (target: string) => {
        probedPaths.add(target);
        return target === bundledPython;
      },
      statSync: () => { throw new Error('ENOENT'); },
      readdirSync: () => [],
    } as never,
  });
  const python = dependencyById(status, 'python-embedded');
  assert.equal(python.status, 'available');
  assert.match(String(python.detail), /随包内置 Python/);
  assert.ok(probedPaths.has(bundledPython));
});

test('runtime dependency status still honors the injected KCW_EMBEDDED_PYTHON env over disk probing', () => {
  const status = getRuntimeDependencyStatus({
    env: { ...installedSystemEnv, KCW_EMBEDDED_PYTHON: 'C:\\AgentCowork\\runtime\\python\\python.exe' },
    platform: 'win32',
    execPath: 'C:\\Program Files\\Agent Cowork\\agent-cowork-host.exe',
    fsImpl: { existsSync: () => false, statSync: () => { throw new Error('ENOENT'); }, readdirSync: () => [] } as never,
  });
  const python = dependencyById(status, 'python-embedded');
  assert.equal(python.status, 'configured');
  assert.equal(python.detail, '内置 Python 路径已配置');
});

test('runtime dependency status reports python-embedded missing when neither env nor a sibling bundle exists', () => {
  const status = getRuntimeDependencyStatus({
    env: { ...installedSystemEnv },
    platform: 'win32',
    execPath: 'C:\\Program Files\\Agent Cowork\\agent-cowork-host.exe',
    fsImpl: { existsSync: () => false, statSync: () => { throw new Error('ENOENT'); }, readdirSync: () => [] } as never,
  });
  const python = dependencyById(status, 'python-embedded');
  assert.equal(python.status, 'missing');
});

// dogfood 2026-07-09 修复:WebView2 此前 win32 一律 unknown「待检测」,即使桌面外壳正靠已装的
// WebView2 Evergreen 运行时渲染,面板也不显示可用。改为实地探测标准安装目录。
test('runtime dependency status detects an installed WebView2 runtime via its system install dir', () => {
  const status = getRuntimeDependencyStatus({
    env: { ...installedSystemEnv, 'ProgramFiles(x86)': 'C:\\Program Files (x86)' },
    platform: 'win32',
    fsImpl: {
      existsSync: (target: string) => /Microsoft[\\/]EdgeWebView[\\/]Application$/i.test(target),
      statSync: () => { throw new Error('ENOENT'); },
      readdirSync: () => [],
    } as never,
  });
  const webview2 = dependencyById(status, 'webview2');
  assert.equal(webview2.status, 'available');
});

test('runtime dependency status keeps WebView2 unknown when no install dir is present (installer/runtime fallback)', () => {
  const status = getRuntimeDependencyStatus({
    env: { ...installedSystemEnv, 'ProgramFiles(x86)': 'C:\\Program Files (x86)' },
    platform: 'win32',
    fsImpl: { existsSync: () => false, statSync: () => { throw new Error('ENOENT'); }, readdirSync: () => [] } as never,
  });
  const webview2 = dependencyById(status, 'webview2');
  assert.equal(webview2.status, 'unknown');
});

test('runtime dependency status reports data science component availability', () => {
  const root = makeTestWorkspace('kcw-runtime-data-science');
  const sitePackages = path.join(root, 'Lib', 'site-packages');
  for (const pkg of ['pandas', 'numpy', 'matplotlib']) {
    fs.mkdirSync(path.join(sitePackages, pkg), { recursive: true });
  }

  const status = getRuntimeDependencyStatus({
    env: { ...installedSystemEnv, KCW_DATA_SCIENCE_HOME: root },
  });

  const component = dependencyById(status, 'data-science');
  assert.equal(component.status, 'available');
  assert.equal(component.source, 'KCW_DATA_SCIENCE_HOME');
  assert.equal(component.detail, '数据分析组件可用');
});

test('runtime dependency status rejects incomplete data science components', () => {
  const root = makeTestWorkspace('kcw-runtime-data-science-missing');
  fs.mkdirSync(path.join(root, 'Lib', 'site-packages', 'pandas'), { recursive: true });
  fs.mkdirSync(path.join(root, 'Lib', 'site-packages', 'numpy'), { recursive: true });

  const status = getRuntimeDependencyStatus({
    env: { ...installedSystemEnv, KCW_DATA_SCIENCE_HOME: root },
  });

  const component = dependencyById(status, 'data-science');
  assert.equal(component.status, 'missing');
  assert.equal(component.source, 'KCW_DATA_SCIENCE_HOME');
  assert.match(String(component.detail), /pandas\/numpy\/matplotlib/);
});

test('runtime dependency status accepts data science venv with lowercase site-packages', () => {
  const root = makeTestWorkspace('kcw-runtime-data-science-venv');
  const sitePackages = path.join(root, 'lib', 'site-packages');
  for (const pkg of ['pandas', 'numpy', 'matplotlib']) {
    fs.mkdirSync(path.join(sitePackages, pkg), { recursive: true });
  }

  const status = getRuntimeDependencyStatus({
    env: { ...installedSystemEnv, KCW_DATA_SCIENCE_VENV: root },
  });

  const component = dependencyById(status, 'data-science');
  assert.equal(component.status, 'available');
  assert.equal(component.source, 'KCW_DATA_SCIENCE_VENV');
});

test('runtime dependency status reports OCR component availability with Chinese tessdata', () => {
  const root = makeTestWorkspace('kcw-runtime-ocr');
  fs.mkdirSync(path.join(root, 'tessdata'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tessdata', 'chi_sim.traineddata'), '');

  const status = getRuntimeDependencyStatus({
    env: { ...installedSystemEnv, KCW_TESSERACT_HOME: root },
  });

  const component = dependencyById(status, 'tesseract-ocr');
  assert.equal(component.status, 'available');
  assert.equal(component.source, 'KCW_TESSERACT_HOME');
  assert.equal(component.detail, 'OCR 中文语言包可用');
});

test('runtime dependency status rejects OCR components without Chinese tessdata', () => {
  const root = makeTestWorkspace('kcw-runtime-ocr-missing-lang');
  fs.mkdirSync(path.join(root, 'tessdata'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tessdata', 'eng.traineddata'), '');

  const status = getRuntimeDependencyStatus({
    env: { ...installedSystemEnv, KCW_TESSDATA_PREFIX: path.join(root, 'tessdata') },
  });

  const component = dependencyById(status, 'tesseract-ocr');
  assert.equal(component.status, 'missing');
  assert.equal(component.source, 'KCW_TESSDATA_PREFIX');
  assert.match(String(component.detail), /中文语言包/);
});

test('runtime dependency status accepts traditional Chinese OCR tessdata', () => {
  const root = makeTestWorkspace('kcw-runtime-ocr-tra');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'chi_tra.traineddata'), '');

  const status = getRuntimeDependencyStatus({
    env: { ...installedSystemEnv, KCW_TESSDATA_PREFIX: root },
  });

  const component = dependencyById(status, 'tesseract-ocr');
  assert.equal(component.status, 'available');
  assert.equal(component.source, 'KCW_TESSDATA_PREFIX');
});

test('runtime dependency status reports Pandoc component availability from home directory', () => {
  const root = makeTestWorkspace('kcw-runtime-pandoc');
  const binDir = path.join(root, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, process.platform === 'win32' ? 'pandoc.exe' : 'pandoc'), '');

  const status = getRuntimeDependencyStatus({
    env: { ...installedSystemEnv, KCW_PANDOC_HOME: root },
  });

  const component = dependencyById(status, 'pandoc');
  assert.equal(component.status, 'available');
  assert.equal(component.source, 'KCW_PANDOC_HOME');
  assert.equal(component.detail, 'Pandoc 组件可用');
});

test('runtime dependency status rejects non-pandoc executable paths', () => {
  const root = makeTestWorkspace('kcw-runtime-pandoc-bad');
  const toolPath = path.join(root, 'not-pandoc.exe');
  fs.writeFileSync(toolPath, '');

  const status = getRuntimeDependencyStatus({
    env: { ...installedSystemEnv, KCW_PANDOC_EXE: toolPath },
  });

  const component = dependencyById(status, 'pandoc');
  assert.equal(component.status, 'missing');
  assert.equal(component.source, 'KCW_PANDOC_EXE');
  assert.match(String(component.detail), /名称不匹配/);
});

test('runtime dependency status accepts a configured Pandoc executable', () => {
  const root = makeTestWorkspace('kcw-runtime-pandoc-exe');
  const toolPath = path.join(root, process.platform === 'win32' ? 'pandoc.exe' : 'pandoc');
  fs.writeFileSync(toolPath, '');

  const status = getRuntimeDependencyStatus({
    env: { ...installedSystemEnv, KCW_PANDOC_EXE: toolPath },
  });

  const component = dependencyById(status, 'pandoc');
  assert.equal(component.status, 'available');
  assert.equal(component.source, 'KCW_PANDOC_EXE');
});

test('runtime dependency status reports Chromium component availability from Playwright home', () => {
  const root = makeTestWorkspace('kcw-runtime-chromium');
  const chromeDir = path.join(root, 'chrome-win');
  fs.mkdirSync(chromeDir, { recursive: true });
  fs.writeFileSync(path.join(chromeDir, 'chrome.exe'), '');

  const status = getRuntimeDependencyStatus({
    env: { ...installedSystemEnv, KCW_PLAYWRIGHT_CHROMIUM_HOME: root },
  });

  const component = dependencyById(status, 'playwright-chromium');
  assert.equal(component.status, 'available');
  assert.equal(component.source, 'KCW_PLAYWRIGHT_CHROMIUM_HOME');
  assert.equal(component.detail, '浏览器自动化组件可用');
});

test('runtime dependency status rejects non-Chromium executable paths', () => {
  const root = makeTestWorkspace('kcw-runtime-chromium-bad');
  const toolPath = path.join(root, 'firefox.exe');
  fs.writeFileSync(toolPath, '');

  const status = getRuntimeDependencyStatus({
    env: { ...installedSystemEnv, KCW_CHROMIUM_EXECUTABLE: toolPath },
  });

  const component = dependencyById(status, 'playwright-chromium');
  assert.equal(component.status, 'missing');
  assert.equal(component.source, 'KCW_CHROMIUM_EXECUTABLE');
  assert.match(String(component.detail), /名称不匹配/);
});
