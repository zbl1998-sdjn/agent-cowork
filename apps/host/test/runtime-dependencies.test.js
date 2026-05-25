import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.js';
import {
  buildRuntimeDependencyCleanupPlan,
  buildRuntimeDependencyInstallPlan,
  buildRuntimeDependencyUpdatePlan,
} from '../src/runtime/dependency-install-plan.js';
import { makeTestWorkspace } from './test-fixtures.js';

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
    assert.match(byId.node.version, /^v\d+\./);
    assert.equal(byId.node.required, true);
    assert.equal(byId.webview2.installMode, 'system');
    assert.equal(byId['python-embedded'].status, 'configured');
    assert.equal(byId.proxy.status, 'configured');
    assert.equal(byId.proxy.detail, 'http://proxy-user:[REDACTED]@127.0.0.1:7890');
  });
});

test('runtime dependency plan routes expose install cleanup and update plans without side effects', async () => {
  const trustedRoot = makeTestWorkspace('kcw-runtime-dep-plan-routes');
  const appDataRoot = 'C:\\Users\\Alice\\AppData\\Roaming\\AgentCowork';
  await withServer({ trustedRoot, runtimeDependencyAppDataRoot: appDataRoot }, async (base) => {
    const install = await postJson(base, '/api/runtime/dependencies/install-plan', {
      selectedIds: ['data-science', 'playwright-chromium'],
      freeBytes: 250 * 1024 * 1024,
    });
    assert.equal(install.status, 200);
    assert.equal(install.body.ok, false);
    assert.equal(install.body.disk.status, 'insufficient');
    assert.deepEqual(install.body.components.map((item) => item.id), ['data-science', 'playwright-chromium']);

    const cleanup = await postJson(base, '/api/runtime/dependencies/cleanup-plan', {
      selectedIds: ['tesseract-ocr'],
      keepUserData: false,
    });
    assert.equal(cleanup.status, 200);
    assert.equal(cleanup.body.appDataRoot, appDataRoot);
    assert.equal(cleanup.body.targets.find((item) => item.id === 'user-data').requiresConfirmation, true);
    assert.equal(cleanup.body.targets.every((item) => item.action === 'remove'), true);

    const update = await postJson(base, '/api/runtime/dependencies/update-plan', {
      selectedIds: ['data-science'],
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
    selectedIds: ['data-science', 'playwright-chromium'],
    freeBytes: 250 * 1024 * 1024,
  });

  assert.equal(plan.ok, false);
  assert.equal(plan.disk.availableBytes, 250 * 1024 * 1024);
  assert.ok(plan.disk.requiredBytes > plan.disk.availableBytes);
  assert.match(plan.disk.message, /磁盘空间不足/);
  assert.deepEqual(plan.components.map((item) => item.id), ['data-science', 'playwright-chromium']);
  assert.equal(plan.components.every((item) => item.installMode === 'on-demand'), true);
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
    selectedIds: ['data-science', 'playwright-chromium'],
    keepUserData: true,
  });

  assert.equal(plan.ok, true);
  assert.equal(plan.mode, 'preserve-user-data');
  assert.deepEqual(plan.targets.map((item) => item.id), ['data-science', 'playwright-chromium', 'runtime-cache']);
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

test('runtime dependency update plan preserves AppData components, venv and user data', () => {
  const root = 'C:\\Users\\Alice\\AppData\\Roaming\\AgentCowork';
  const plan = buildRuntimeDependencyUpdatePlan({
    appDataRoot: root,
    currentVersion: '0.2.0',
    targetVersion: '0.2.1',
    selectedIds: ['data-science', 'playwright-chromium'],
  });

  assert.equal(plan.ok, true);
  assert.equal(plan.mode, 'preserve-on-update');
  assert.equal(plan.destructiveActions.length, 0);
  assert.deepEqual(plan.components.map((item) => item.id), ['data-science', 'playwright-chromium']);
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
