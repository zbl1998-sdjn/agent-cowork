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
    assert.ok(packs.some((pack) => pack.id === 'core-text-pack'));
    assert.ok(packs.some((pack) => pack.id === 'frontend-design-pack'));

    const recommend = await jsonRequest(base, '/api/capabilities/recommend?role=developer&taskIntent=frontend%20ui');
    assert.equal(recommend.status, 200);
    const recommendations = arrayField(recommend.body, 'recommendations', 'capability recommendations');
    assert.ok(recommendations.some((pack) => pack.id === 'frontend-design-pack'));

    const plan = await jsonRequest(base, '/api/install/plan', {
      method: 'POST',
      body: {
        packIds: ['frontend-design-pack'],
        freeBytes: 2 * 1024 * 1024 * 1024,
      },
    });
    assert.equal(plan.status, 200);
    assert.deepEqual(plan.body.packIds, ['frontend-design-pack']);
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
