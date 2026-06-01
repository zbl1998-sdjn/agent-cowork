import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:http';
import { createServer } from '../src/server.js';
import { buildOnboardingRecommendations } from '../src/onboarding/recommendations.js';
import { makeTestWorkspace } from './test-fixtures.js';

type ServerConfig = Parameters<typeof createServer>[0];
type RecommendationItem = { id: string };
type OnboardingResponse = {
  selectedRole: string;
  workspaceType: string;
  dependencyCheck: { recommendedIds: string[] };
  recommendations: {
    connectors: RecommendationItem[];
    skills: RecommendationItem[];
  };
};

async function withServer(config: ServerConfig, fn: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = createServer({ enableScheduler: false, ...config });
  await new Promise<void>((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  assert.ok(address !== null);
  assert.equal(typeof address, 'object');
  const { port } = address as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('onboarding recommendations fallback unknown role to office', () => {
  const result = buildOnboardingRecommendations({ role: 'unknown', workspaceType: 'Team Space' });

  assert.equal(result.selectedRole, 'office');
  assert.equal(result.workspaceType, 'team space');
  assert.deepEqual(result.roles.map((role) => role.id), ['office', 'developer', 'research', 'operations']);
  assert.equal(result.roles.every((role) => role.label && role.description), true);
  assert.equal(result.dependencyCheck.route, '/api/runtime/dependencies');
  assert.ok(result.dependencyCheck.recommendedIds.includes('node'));
  assert.ok(result.dependencyCheck.recommendedIds.includes('pandoc'));
  assert.ok(result.recommendations.skills.some((item) => item.id === 'office-writer'));
});

test('onboarding recommendations differ by role', () => {
  const office = buildOnboardingRecommendations({ role: 'office' });
  const developer = buildOnboardingRecommendations({ role: 'developer' });
  const research = buildOnboardingRecommendations({ role: 'research' });

  assert.ok(JSON.stringify(developer.recommendations.skills) !== JSON.stringify(office.recommendations.skills));
  assert.ok(developer.dependencyCheck.recommendedIds.includes('mingit'));
  assert.ok(!office.dependencyCheck.recommendedIds.includes('mingit'));
  assert.ok(research.dependencyCheck.recommendedIds.includes('tesseract-ocr'));
  assert.ok(research.recommendations.skills.some((item) => item.id === 'document-extractor'));
});

test('POST /api/onboarding/recommendations returns recommendations', async () => {
  const trustedRoot = makeTestWorkspace('kcw-onboarding');
  await withServer({ trustedRoot, requireAuth: false }, async (base) => {
    const response = await fetch(`${base}/api/onboarding/recommendations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'developer', workspaceType: 'repo' }),
    });

    assert.equal(response.status, 200);
    const body = await response.json() as OnboardingResponse;
    assert.equal(body.selectedRole, 'developer');
    assert.equal(body.workspaceType, 'repo');
    assert.ok(body.dependencyCheck.recommendedIds.includes('mingit'));
    assert.ok(body.recommendations.connectors.some((item) => item.id === 'github'));
  });
});

test('POST /api/onboarding/recommendations sanitizes invalid optional fields', async () => {
  const trustedRoot = makeTestWorkspace('kcw-onboarding-sanitize');
  await withServer({ trustedRoot, requireAuth: false }, async (base) => {
    const response = await fetch(`${base}/api/onboarding/recommendations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: ['developer'], workspaceType: { kind: 'repo' } }),
    });

    assert.equal(response.status, 200);
    const body = await response.json() as OnboardingResponse;
    assert.equal(body.selectedRole, 'office');
    assert.equal(body.workspaceType, 'local');
  });
});

test('unauthenticated onboarding API is blocked by auth gate', async () => {
  const trustedRoot = makeTestWorkspace('kcw-onboarding-gate');
  await withServer({ trustedRoot, requireAuth: true, trustIdentityHeaders: false }, async (base) => {
    const response = await fetch(`${base}/api/onboarding/recommendations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'developer' }),
    });

    assert.equal(response.status, 401);
  });
});
