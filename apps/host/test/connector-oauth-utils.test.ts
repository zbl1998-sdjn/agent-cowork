import assert from 'node:assert/strict';
import test from 'node:test';
import {
  errorStatus,
  githubClientId,
  githubConnector,
  isGitHub,
  oauthFilter,
  oauthIdentity,
} from '../src/routes/connector-oauth-route-utils.js';

test('OAuth route utilities normalize identities, client id, and status codes', () => {
  const previousClientId = process.env.KCW_GITHUB_OAUTH_CLIENT_ID;
  process.env.KCW_GITHUB_OAUTH_CLIENT_ID = 'env-client-id';
  try {
    assert.equal(isGitHub('GitHub'), true);
    assert.equal(githubClientId({ github: { clientId: ['bad-client'] } }), 'env-client-id');
    assert.deepEqual(oauthIdentity({ tenantId: 'tenant-a', userId: 'user-a' }, 'github', 'octocat'), {
      tenantId: 'tenant-a',
      userId: 'user-a',
      provider: 'github',
      accountId: 'octocat',
    });
    const noisyContext = { tenantId: 123, userId: 'user-a' } as unknown as Parameters<typeof oauthFilter>[0];
    assert.deepEqual(oauthFilter(noisyContext, 'github'), {
      userId: 'user-a',
      provider: 'github',
    });
    assert.equal(githubConnector().id, 'github');
    assert.equal(errorStatus({ statusCode: 418 }, 502), 418);
    assert.equal(errorStatus({ statusCode: '418' }, 502), 502);
  } finally {
    if (previousClientId === undefined) delete process.env.KCW_GITHUB_OAUTH_CLIENT_ID;
    else process.env.KCW_GITHUB_OAUTH_CLIENT_ID = previousClientId;
  }
});
