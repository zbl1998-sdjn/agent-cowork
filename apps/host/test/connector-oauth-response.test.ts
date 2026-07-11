import assert from 'node:assert/strict';
import test from 'node:test';
import { githubOAuthCompletionDto } from '../src/routes/connector-oauth-response.js';

const summary = {
  provider: 'github',
  accountId: 'octocat',
  tenantId: 'tenant-a',
  userId: 'user-a',
  scopes: ['read:user'],
  account: { login: 'octocat', id: 1 },
  updatedAt: '2026-07-11T00:00:00.000Z',
};

test('GitHub OAuth completion response rebuilds strict primitive DTOs', () => {
  const marker = 'nested-sensitive-value';
  const result = githubOAuthCompletionDto(
    {
      login: { token: marker },
      id: { raw: marker },
      name: [marker],
      email: { address: marker },
      private: { token: marker },
    },
    summary,
  );

  assert.deepEqual(result.account, {
    login: 'github-user',
    id: null,
    name: null,
    email: null,
  });
  assert.deepEqual(result.credential, summary);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(marker));
});

test('GitHub OAuth completion response fails closed for nested credential summaries', () => {
  const marker = 'nested-sensitive-value';
  assert.throws(
    () => githubOAuthCompletionDto(
      { login: 'octocat', id: 1, name: null, email: null },
      {
        ...summary,
        account: { login: 'octocat', private: { token: marker } },
      },
    ),
    /credential summary DTO is invalid/,
  );
});
