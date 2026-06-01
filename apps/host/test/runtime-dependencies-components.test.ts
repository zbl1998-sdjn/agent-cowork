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
