import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCapabilityInstallPlan,
  recommendCapabilityPacks,
  type CapabilityPackManifest,
} from '../src/runtime/capability-packs.js';

function manifest(overrides: Partial<CapabilityPackManifest> = {}): CapabilityPackManifest {
  return {
    schemaVersion: 'agent-cowork.pack.v1',
    id: 'sample-pack',
    name: 'Sample Pack',
    version: '1.0.0',
    description: 'Test-only capability manifest.',
    category: 'capability',
    publisher: 'Agent Cowork',
    license: 'internal',
    capabilities: ['sample.read'],
    dependencyIds: [],
    requiredPackIds: [],
    recommendedForRoles: [],
    permissions: [{
      kind: 'filesystem',
      scope: 'trustedRoot',
      reason: 'Read an approved workspace.',
      default: 'ask',
    }],
    installMode: 'plan-only',
    security: {
      signed: false,
      sandboxRequired: true,
      networkDuringRuntime: 'none',
    },
    ...overrides,
  };
}

test('capability recommendations only report dependency ids absent from the managed catalog', () => {
  const recommendations = recommendCapabilityPacks({ role: 'developer' });

  assert.ok(recommendations.length > 0);
  for (const recommendation of recommendations) {
    assert.deepEqual(
      recommendation.missingDependencyIds,
      [],
      `${recommendation.id} only references dependencies present in the managed catalog`,
    );
  }
});

test('install plans resolve required packs transitively and expose inherited review data', () => {
  const plan = buildCapabilityInstallPlan({
    packIds: ['developer-role-pack', 'developer-role-pack'],
  });

  assert.deepEqual(plan.requestedPackIds, ['developer-role-pack']);
  assert.deepEqual(plan.packIds, ['developer-role-pack']);
  assert.deepEqual(plan.resolvedPackIds, [
    'browser-automation-pack',
    'frontend-design-pack',
    'developer-role-pack',
  ]);
  assert.ok(plan.inheritedPermissions.some((permission) => (
    permission.packId === 'browser-automation-pack'
      && permission.kind === 'shell'
      && permission.scope === 'local-browser'
  )));
  const developerGovernance = plan.packGovernance.find((pack) => pack.id === 'developer-role-pack');
  assert.equal(developerGovernance?.governance.status, 'review_required');
  assert.equal(developerGovernance?.governance.executable, false);
});

test('install plans fail closed for missing, blocked and cyclic pack graphs', () => {
  const catalog = [
    manifest({ id: 'missing-root', requiredPackIds: ['does-not-exist'] }),
    manifest({ id: 'cycle-a', requiredPackIds: ['cycle-b'] }),
    manifest({ id: 'cycle-b', requiredPackIds: ['cycle-a'] }),
    manifest({
      id: 'blocked-pack',
      permissions: [{
        kind: 'shell',
        scope: '*',
        reason: 'Unsafe test fixture.',
        default: 'allow',
      }],
    }),
  ];
  const plan = buildCapabilityInstallPlan({
    packIds: ['missing-root', 'cycle-a', 'blocked-pack'],
  }, catalog);

  assert.equal(plan.ok, false);
  assert.deepEqual(plan.unknownPackIds, []);
  assert.deepEqual(plan.missingRequiredPackIds, ['does-not-exist']);
  assert.ok(plan.blockedPackIds.includes('missing-root'));
  assert.ok(plan.blockedPackIds.includes('cycle-a'));
  assert.ok(plan.blockedPackIds.includes('cycle-b'));
  assert.ok(plan.blockedPackIds.includes('blocked-pack'));
  const cycleGovernance = plan.packGovernance.find((pack) => pack.id === 'cycle-a');
  assert.ok(cycleGovernance?.governance.reasons.includes('required_pack_cycle'));
});

test('install plans resolve deep required-pack chains without overflowing the call stack', () => {
  const count = 12_000;
  const catalog = Array.from({ length: count }, (_, index) => manifest({
    id: `deep-plan-${index}`,
    requiredPackIds: index + 1 < count ? [`deep-plan-${index + 1}`] : [],
  }));

  const plan = buildCapabilityInstallPlan({ packIds: ['deep-plan-0'] }, catalog);
  assert.equal(plan.resolvedPackIds.length, count);
  assert.equal(plan.resolvedPackIds[0], `deep-plan-${count - 1}`);
  assert.equal(plan.resolvedPackIds.at(-1), 'deep-plan-0');
});
