import assert from 'node:assert/strict';
import test from 'node:test';
import {
  auditCapabilityPacks,
  type CapabilityPackManifest,
} from '../src/skills/capability-pack-governance.js';

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
    permissions: [
      {
        kind: 'filesystem',
        scope: 'trustedRoot',
        reason: 'Read an approved workspace.',
        default: 'ask',
      },
    ],
    installMode: 'bundled',
    security: {
      signed: true,
      sandboxRequired: false,
      networkDuringRuntime: 'none',
    },
    ...overrides,
  };
}

test('only signed internal bundled packs are executable without another review', () => {
  const [pack] = auditCapabilityPacks([manifest()]);

  assert.equal(pack?.governance.status, 'bundled_trusted');
  assert.equal(pack?.governance.executable, true);
  assert.equal(pack?.governance.reviewRequired, false);
  assert.deepEqual(pack?.governance.reasons, []);
});

test('runtime dependencies absent from the injected managed catalog fail closed', () => {
  const [pack] = auditCapabilityPacks([
    manifest({ dependencyIds: ['node', 'missing-runtime'] }),
  ], {
    knownDependencyIds: new Set(['node']),
  });

  assert.equal(pack?.governance.status, 'blocked');
  assert.equal(pack?.governance.executable, false);
  assert.ok(pack?.governance.reasons.includes('runtime_dependency_missing:missing-runtime'));
});

test('plan-only packs stay non-executable and require a review', () => {
  const [pack] = auditCapabilityPacks([
    manifest({
      id: 'planned-pack',
      installMode: 'plan-only',
      security: {
        signed: false,
        sandboxRequired: true,
        networkDuringRuntime: 'ask',
      },
    }),
  ]);

  assert.equal(pack?.governance.status, 'review_required');
  assert.equal(pack?.governance.executable, false);
  assert.equal(pack?.governance.reviewRequired, true);
  assert.ok(pack?.governance.reasons.includes('plan_only'));
});

test('dangerous defaults and unresolved required packs fail closed', () => {
  const results = auditCapabilityPacks([
    manifest({
      id: 'unsafe-default-pack',
      permissions: [
        {
          kind: 'shell',
          scope: '*',
          reason: 'Unsafe test fixture.',
          default: 'allow',
        },
      ],
    }),
    manifest({
      id: 'missing-required-pack',
      requiredPackIds: ['does-not-exist'],
    }),
  ]);

  assert.equal(results[0]?.governance.status, 'blocked');
  assert.equal(results[0]?.governance.executable, false);
  assert.ok(results[0]?.governance.reasons.includes('permission_default_allow'));
  assert.equal(results[1]?.governance.status, 'blocked');
  assert.ok(results[1]?.governance.reasons.includes('required_pack_missing:does-not-exist'));
});

test('cyclic and duplicate pack identities are blocked', () => {
  const results = auditCapabilityPacks([
    manifest({ id: 'pack-a', requiredPackIds: ['pack-b'] }),
    manifest({ id: 'pack-b', requiredPackIds: ['pack-a'] }),
    manifest({ id: 'duplicate-pack' }),
    manifest({ id: 'duplicate-pack', name: 'Duplicate Pack Copy' }),
  ]);

  assert.equal(results[0]?.governance.status, 'blocked');
  assert.ok(results[0]?.governance.reasons.includes('required_pack_cycle'));
  assert.equal(results[1]?.governance.status, 'blocked');
  assert.ok(results[1]?.governance.reasons.includes('required_pack_cycle'));
  assert.equal(results[2]?.governance.status, 'blocked');
  assert.ok(results[2]?.governance.reasons.includes('duplicate_pack_id'));
  assert.equal(results[3]?.governance.status, 'blocked');
});

test('blocked required packs make every transitive dependant fail closed', () => {
  const results = auditCapabilityPacks([
    manifest({
      id: 'blocked-base',
      permissions: [{
        kind: 'shell',
        scope: '*',
        reason: 'Unsafe test fixture.',
        default: 'allow',
      }],
    }),
    manifest({ id: 'direct-dependant', requiredPackIds: ['blocked-base'] }),
    manifest({ id: 'transitive-dependant', requiredPackIds: ['direct-dependant'] }),
  ]);

  assert.equal(results[1]?.governance.status, 'blocked');
  assert.equal(results[1]?.governance.executable, false);
  assert.ok(results[1]?.governance.reasons.includes('required_pack_blocked:blocked-base'));
  assert.equal(results[2]?.governance.status, 'blocked');
  assert.ok(results[2]?.governance.reasons.includes('required_pack_blocked:direct-dependant'));
});

test('a bundled pack cannot become executable through a plan-only requirement', () => {
  const results = auditCapabilityPacks([
    manifest({ id: 'reviewed-later', installMode: 'plan-only' }),
    manifest({ id: 'bundled-dependant', requiredPackIds: ['reviewed-later'] }),
  ]);

  assert.equal(results[0]?.governance.status, 'review_required');
  assert.equal(results[1]?.governance.status, 'blocked');
  assert.ok(results[1]?.governance.reasons.includes('required_pack_not_executable:reviewed-later'));
});

test('deep required-pack chains are audited without overflowing the call stack', () => {
  const count = 12_000;
  const manifests = Array.from({ length: count }, (_, index) => manifest({
    id: `deep-audit-${index}`,
    installMode: 'plan-only',
    requiredPackIds: index + 1 < count ? [`deep-audit-${index + 1}`] : [],
  }));

  const results = auditCapabilityPacks(manifests);
  assert.equal(results.length, count);
  assert.equal(results[0]?.governance.status, 'review_required');
});
