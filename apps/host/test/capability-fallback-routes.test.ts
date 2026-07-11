import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from '../src/server.js';
import { makeTestWorkspace } from './test-fixtures.js';
import {
  arrayField,
  bind,
  close,
  jsonRequest,
  objectField,
} from './helpers/host-http.js';

const degradedSandboxStartup = {
  options: { backend: 'local' },
  info: {
    requestedBackend: 'auto',
    selectedBackend: 'local',
    securityMode: 'saas_opt_in',
    networkIsolated: false,
    fallback: true,
    fallbackReason: 'No Docker backend was available',
    userMessage: '本地执行不隔离网络',
    backends: {
      docker: {
        available: false,
        usable: false,
        networkIsolated: false,
        detail: 'docker unavailable',
        reason: 'not found',
      },
      wsl: {
        available: false,
        usable: false,
        networkIsolated: false,
        detail: 'wsl unavailable',
        reason: 'not found',
      },
      local: {
        available: true,
        usable: true,
        networkIsolated: false,
      },
    },
  },
};

test('capability catalog and install-plan routes expose pack recommendations without applying installs', async () => {
  const trustedRoot = makeTestWorkspace('kcw-capability-routes');
  const server = createServer({
    requireAuth: false,
    enableScheduler: false,
    trustedRoot,
  });
  const base = await bind(server);
  try {
    const catalog = await jsonRequest(base, '/api/capabilities/catalog');
    assert.equal(catalog.status, 200);
    const packs = arrayField(catalog.body, 'packs', 'capability packs');
    const corePack = packs.find((pack) => pack.id === 'core-text-pack');
    const frontendPack = packs.find((pack) => pack.id === 'frontend-design-pack');
    assert.ok(corePack);
    assert.ok(frontendPack);
    assert.equal(objectField(corePack, 'governance', 'core pack governance').status, 'bundled_trusted');
    assert.equal(objectField(corePack, 'governance', 'core pack governance').executable, true);
    assert.equal(objectField(frontendPack, 'governance', 'frontend pack governance').status, 'review_required');
    assert.equal(objectField(frontendPack, 'governance', 'frontend pack governance').executable, false);

    const recommend = await jsonRequest(base, '/api/capabilities/recommend?role=developer&taskIntent=frontend%20ui');
    assert.equal(recommend.status, 200);
    const recommendations = arrayField(recommend.body, 'recommendations', 'capability recommendations');
    assert.ok(recommendations.some((pack) => pack.id === 'frontend-design-pack'));

    const plan = await jsonRequest(base, '/api/install/plan', {
      method: 'POST',
      body: {
        packIds: ['frontend-design-pack', 'frontend-design-pack'],
        selectedIds: ['playwright-chromium', 'playwright-chromium'],
        freeBytes: 2 * 1024 * 1024 * 1024,
      },
    });
    assert.equal(plan.status, 200);
    assert.deepEqual(plan.body.packIds, ['frontend-design-pack']);
    assert.deepEqual(plan.body.requestedPackIds, ['frontend-design-pack']);
    assert.deepEqual(plan.body.resolvedPackIds, ['browser-automation-pack', 'frontend-design-pack']);
    assert.deepEqual(plan.body.unknownPackIds, []);
    assert.ok(Array.isArray(plan.body.dependencyIds));
    assert.ok((plan.body.dependencyIds as unknown[]).includes('playwright-chromium'));
    const runtimePlan = objectField(plan.body, 'runtimePlan', 'capability runtime plan');
    const components = arrayField(runtimePlan, 'components', 'runtime plan components');
    assert.deepEqual(components.map((component) => component.id), ['playwright-chromium']);
    assert.equal(components[0]?.needsDownload, true);

  } finally {
    await close(server);
  }
});

test('capability install-plan rejects more than 64 pack or dependency ids', async () => {
  const trustedRoot = makeTestWorkspace('kcw-capability-route-limits');
  const server = createServer({
    requireAuth: false,
    enableScheduler: false,
    trustedRoot,
  });
  const base = await bind(server);
  try {
    const tooManyPacks = await jsonRequest(base, '/api/capabilities/install-plan', {
      method: 'POST',
      body: { packIds: Array.from({ length: 65 }, (_, index) => `pack-${index}`) },
    });
    assert.equal(tooManyPacks.status, 400);

    const tooManyDependencies = await jsonRequest(base, '/api/capabilities/install-plan', {
      method: 'POST',
      body: { selectedIds: Array.from({ length: 65 }, (_, index) => `dependency-${index}`) },
    });
    assert.equal(tooManyDependencies.status, 400);
  } finally {
    await close(server);
  }
});

test('fallback status route reports degraded local-only ability with explicit decisions', async () => {
  const trustedRoot = makeTestWorkspace('kcw-fallback-status');
  const server = createServer({
    requireAuth: false,
    enableScheduler: false,
    trustedRoot,
    kimiProvider: 'offline-test-provider',
    kimiBaseUrl: '',
    kimiModel: '',
    sandboxStartup: degradedSandboxStartup,
  });
  const base = await bind(server);
  try {
    const response = await jsonRequest(base, '/api/fallback/status');
    assert.equal(response.status, 200);
    assert.equal(response.body.ok, true);
    assert.equal(response.body.ability, 'local_only');
    const decisions = arrayField(response.body, 'decisions', 'fallback decisions');
    const causes = decisions.map((decision) => decision.cause);
    assert.ok(causes.includes('model_auth_failed'));
    assert.ok(causes.includes('sandbox_unavailable'));
    assert.equal(objectField(response.body, 'dependencies', 'fallback dependencies').ok, true);
  } finally {
    await close(server);
  }
});
