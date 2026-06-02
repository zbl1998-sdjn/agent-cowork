import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  buildRuntimeDependencyCleanupPlan,
  buildRuntimeDependencyInstallPlan,
  buildRuntimeDependencyUpdatePlan,
} from '../src/runtime/dependency-install-plan.js';
import { createServer } from '../src/server.js';
import type { ServerConfig } from '../src/server.js';
import { makeTestWorkspace } from './test-fixtures.js';
import {
  arrayField,
  bind,
  close,
  jsonRequest,
  objectField,
  present,
  recordValue,
  stringField,
} from './helpers/host-http.js';
import { recordById, stringIds } from './helpers/runtime-dependency.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');

// 以下部分计划测试断言 Windows 安装版的 AppData 布局(C:\...\AgentCowork),依赖
// normalizeAgentCoworkRoot 的 Windows 路径校验,在非 Windows(如 Linux CI)上无法成立。
// 用 winOnly 让它们仅在 Windows 运行、其它平台跳过(Windows 本地行为与断言不变)。
const winOnly = process.platform === 'win32' ? {} : { skip: 'Windows-only: AppData 路径规范化' };

async function withServer(config: ServerConfig, fn: (base: string) => Promise<void>): Promise<void> {
  const server = createServer({ requireAuth: false, enableScheduler: false, ...config });
  const base = await bind(server);
  try {
    await fn(base);
  } finally {
    await close(server);
  }
}

test('runtime dependency plan routes expose install cleanup and update plans without side effects', winOnly, async () => {
  const trustedRoot = makeTestWorkspace('kcw-runtime-dep-plan-routes');
  const appDataRoot = 'C:\\Users\\Alice\\AppData\\Roaming\\AgentCowork';
  await withServer({ trustedRoot, runtimeDependencyAppDataRoot: appDataRoot }, async (base) => {
    const install = await jsonRequest(base, '/api/runtime/dependencies/install-plan', {
      method: 'POST',
      body: {
        selectedIds: ['data-science', 'playwright-chromium', 'pandoc', 'ffmpeg', 'mingit'],
        freeBytes: 250 * 1024 * 1024,
      },
    });
    assert.equal(install.status, 200);
    assert.equal(install.body.ok, false);
    assert.equal(objectField(install.body, 'disk', 'install disk').status, 'insufficient');
    assert.deepEqual(stringIds(arrayField(install.body, 'components', 'install components')), [
      'data-science',
      'playwright-chromium',
      'pandoc',
      'ffmpeg',
      'mingit',
    ]);

    const cleanup = await jsonRequest(base, '/api/runtime/dependencies/cleanup-plan', {
      method: 'POST',
      body: {
        selectedIds: ['tesseract-ocr', 'pandoc', 'ffmpeg', 'mingit'],
        keepUserData: false,
      },
    });
    assert.equal(cleanup.status, 200);
    assert.equal(cleanup.body.appDataRoot, appDataRoot);
    const cleanupTargets = arrayField(cleanup.body, 'targets', 'cleanup targets');
    assert.ok(stringField(recordById(cleanupTargets, 'tesseract-ocr', 'cleanup target'), 'path').endsWith('\\components\\tesseract-ocr'));
    assert.ok(stringField(recordById(cleanupTargets, 'pandoc', 'cleanup target'), 'path').endsWith('\\components\\pandoc'));
    assert.ok(stringField(recordById(cleanupTargets, 'ffmpeg', 'cleanup target'), 'path').endsWith('\\components\\ffmpeg'));
    assert.ok(stringField(recordById(cleanupTargets, 'mingit', 'cleanup target'), 'path').endsWith('\\components\\mingit'));
    assert.equal(recordById(cleanupTargets, 'user-data', 'cleanup target').requiresConfirmation, true);
    assert.equal(cleanupTargets.every((item) => item.action === 'remove'), true);

    const update = await jsonRequest(base, '/api/runtime/dependencies/update-plan', {
      method: 'POST',
      body: {
        selectedIds: ['data-science', 'pandoc', 'ffmpeg', 'mingit'],
        currentVersion: '0.2.0',
        targetVersion: '0.2.1',
      },
    });
    assert.equal(update.status, 200);
    assert.equal(update.body.appDataRoot, appDataRoot);
    assert.equal(arrayField(update.body, 'destructiveActions', 'update destructive actions').length, 0);
    assert.equal(present(arrayField(update.body, 'components', 'update components')[0], 'first update component').action, 'preserve');
    assert.ok(arrayField(update.body, 'retained', 'update retained items').some((item) => item.id === 'user-data'));
  });
});

test('runtime dependency plan routes reject malformed body fields before planning', async () => {
  const trustedRoot = makeTestWorkspace('kcw-runtime-dep-plan-invalid');
  await withServer({ trustedRoot }, async (base) => {
    const response = await jsonRequest(base, '/api/runtime/dependencies/install-plan', {
      method: 'POST',
      body: { selectedIds: 'data-science' },
    });

    assert.equal(response.status, 400);
    assert.match(String(response.body.error), /selectedIds/);
  });
});

test('runtime dependency install plan blocks downloads when disk space is insufficient', () => {
  const plan = buildRuntimeDependencyInstallPlan({
    selectedIds: ['data-science', 'playwright-chromium', 'pandoc', 'ffmpeg', 'mingit'],
    freeBytes: 250 * 1024 * 1024,
  });

  assert.equal(plan.ok, false);
  assert.equal(plan.disk.availableBytes, 250 * 1024 * 1024);
  assert.ok(Number(plan.disk.requiredBytes) > Number(plan.disk.availableBytes));
  assert.match(plan.disk.message, /磁盘空间不足/);
  assert.deepEqual(plan.components.map((item) => item.id), ['data-science', 'playwright-chromium', 'pandoc', 'ffmpeg', 'mingit']);
  assert.equal(plan.components.every((item) => item.installMode === 'on-demand'), true);
  assert.ok(Number(recordById(plan.components, 'ffmpeg', 'install component').estimatedDownloadBytes) > 0);
});

test('runtime dependency install plan blocks on-demand downloads without verifiable source metadata', () => {
  const plan = buildRuntimeDependencyInstallPlan({
    selectedIds: ['pandoc'],
    freeBytes: 1024 * 1024 * 1024,
  });

  assert.equal(plan.ok, false);
  assert.equal(plan.disk.status, 'ok');
  assert.equal(plan.supplyChain.status, 'blocked');
  assert.deepEqual(plan.supplyChain.issues.map((item) => item.id), ['pandoc']);
  const component = present(plan.components[0], 'pandoc install plan component');
  assert.equal(component.needsDownload, true);
  assert.equal(component.sourceKind, 'official');
  assert.equal(component.sourceUrl, null);
  assert.equal(component.sha256, null);
  assert.equal(component.signaturePolicy, 'sha256-required');
  assert.match(component.supplyChain.reasons.join('\n'), /下载来源 URL/);
  assert.match(component.supplyChain.reasons.join('\n'), /sha256/);
});

test('runtime dependency install plan accepts required bundled defaults without optional downloads', () => {
  const plan = buildRuntimeDependencyInstallPlan({
    selectedIds: ['node', 'python-embedded', 'cjk-fonts'],
    freeBytes: 400 * 1024 * 1024,
  });

  assert.equal(plan.ok, true);
  assert.equal(plan.disk.requiredBytes, 0);
  assert.equal(plan.disk.status, 'ok');
  assert.equal(plan.supplyChain.status, 'ok');
});

test('runtime dependency cleanup plan removes on-demand components while preserving user data', winOnly, () => {
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
  assert.equal(present(plan.retained[0], 'retained user data').id, 'user-data');
  for (const target of plan.targets) {
    const targetRecord = recordValue(target, 'cleanup target');
    assert.ok(stringField(targetRecord, 'path').startsWith(plan.appDataRoot), `${String(targetRecord.path)} escaped cleanup root`);
  }
});

test('runtime dependency cleanup plan requires confirmation before deleting user data', winOnly, () => {
  const plan = buildRuntimeDependencyCleanupPlan({
    appDataRoot: 'C:\\Users\\Alice\\AppData\\Roaming\\AgentCowork',
    selectedIds: ['tesseract-ocr', 'unknown-component'],
    keepUserData: false,
  });

  assert.equal(plan.ok, false);
  assert.deepEqual(plan.unknownIds, ['unknown-component']);
  assert.equal(plan.mode, 'remove-user-data');
  const userData = recordById(plan.targets, 'user-data', 'cleanup target');
  assert.equal(userData.requiresConfirmation, true);
  assert.match(String(plan.warnings[0]), /二次确认/);
});

test('runtime dependency cleanup plan refuses non-AgentCowork roots', () => {
  assert.throws(
    () => buildRuntimeDependencyCleanupPlan({ appDataRoot: 'C:\\Users\\Alice\\AppData\\Roaming' }),
    /must end with AgentCowork/,
  );
});

test('NSIS uninstall hook deletes AgentCowork AppData only after delete-data confirmation', () => {
  const tauriRoot = path.join(repoRoot, 'apps/windows-client/src-tauri');
  const config = recordValue(JSON.parse(fs.readFileSync(path.join(tauriRoot, 'tauri.conf.json'), 'utf8')) as unknown, 'tauri config');
  const bundle = objectField(config, 'bundle', 'tauri bundle config');
  const windows = objectField(bundle, 'windows', 'tauri windows config');
  const nsis = objectField(windows, 'nsis', 'tauri nsis config');
  const hooksRel = stringField(nsis, 'installerHooks', 'nsis installer hooks');
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

test('runtime dependency update plan preserves AppData components, venv and user data', winOnly, () => {
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
  assert.ok(stringField(recordById(plan.components, 'ffmpeg', 'update component'), 'path').endsWith('\\components\\ffmpeg'));
  assert.ok(stringField(recordById(plan.components, 'pandoc', 'update component'), 'path').endsWith('\\components\\pandoc'));
  assert.ok(stringField(recordById(plan.components, 'mingit', 'update component'), 'path').endsWith('\\components\\mingit'));
  assert.ok(plan.retained.some((item) => item.id === 'user-data' && item.path === plan.appDataRoot));
  assert.ok(plan.retained.some((item) => item.id === 'python-venv' && stringField(recordValue(item, 'retained item'), 'path').endsWith('\\venv')));
  assert.ok(plan.retained.some((item) => item.id === 'components-root' && stringField(recordValue(item, 'retained item'), 'path').endsWith('\\components')));
  for (const target of [...plan.retained, ...plan.components]) {
    const targetRecord = recordValue(target, 'update target');
    const targetPath = stringField(targetRecord, 'path');
    assert.equal(targetRecord.action, 'preserve');
    assert.ok(targetPath === plan.appDataRoot || targetPath.startsWith(`${plan.appDataRoot}\\`), `${targetPath} escaped update root`);
  }
});

test('runtime dependency update plan reports unknown components without destructive fallback', winOnly, () => {
  const plan = buildRuntimeDependencyUpdatePlan({
    appDataRoot: 'C:\\Users\\Alice\\AppData\\Roaming\\AgentCowork',
    selectedIds: ['data-science', 'unknown-component'],
  });

  assert.equal(plan.ok, false);
  assert.deepEqual(plan.unknownIds, ['unknown-component']);
  assert.equal(plan.destructiveActions.length, 0);
  assert.equal(present(plan.components[0], 'first update component').action, 'preserve');
});
