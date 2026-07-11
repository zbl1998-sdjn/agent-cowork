import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canonicalIdentityFilter,
  canonicalIdentityPart,
  canonicalRequiredIdentityScope,
  identityScopeTupleKey,
  LOCAL_IDENTITY_SCOPE,
  requireCanonicalIdentityScope,
  requireIdentityScopeFrom,
} from '../src/security/identity-scope.js';

test('identity parts accept only raw canonical strings', () => {
  assert.equal(canonicalIdentityPart('tenant-a:user_1.example'), 'tenant-a:user_1.example');
  for (const value of [
    '',
    ' tenant-a',
    'tenant-a ',
    'tenant\n',
    '用户',
    'a'.repeat(97),
    7,
    false,
    ['tenant-a'],
    { toString: () => 'tenant-a' },
  ]) {
    assert.equal(canonicalIdentityPart(value), null, `must reject ${typeof value}`);
  }
});

test('required identity scopes are complete, immutable, and fail closed', () => {
  const scope = canonicalRequiredIdentityScope('tenant-a', 'user-a');
  assert.deepEqual(scope, { tenantId: 'tenant-a', userId: 'user-a' });
  assert.equal(Object.isFrozen(scope), true);
  assert.equal(canonicalRequiredIdentityScope('tenant-a', undefined), null);
  assert.equal(canonicalRequiredIdentityScope(undefined, 'user-a'), null);
  assert.throws(() => requireCanonicalIdentityScope('tenant-a', ' user-a'), /identity/i);
});

test('only an entirely omitted context may opt into the explicit local scope', () => {
  assert.equal(
    requireIdentityScopeFrom(undefined, { allowLocalDefault: true }),
    LOCAL_IDENTITY_SCOPE,
  );
  assert.deepEqual(
    requireIdentityScopeFrom({ tenantId: 'tenant-a', userId: 'user-a' }),
    { tenantId: 'tenant-a', userId: 'user-a' },
  );
  for (const context of [
    null,
    {},
    { tenantId: 'tenant-a' },
    { userId: 'user-a' },
    { tenantId: undefined, userId: undefined },
  ]) {
    assert.throws(
      () => requireIdentityScopeFrom(context, { allowLocalDefault: true }),
      /identity/i,
    );
  }
});

test('identity filters preserve missing fields but reject provided invalid fields', () => {
  assert.deepEqual(canonicalIdentityFilter({}), {});
  assert.deepEqual(canonicalIdentityFilter({ tenantId: 'tenant-a' }), { tenantId: 'tenant-a' });
  assert.deepEqual(canonicalIdentityFilter({ userId: 'user-a' }), { userId: 'user-a' });
  assert.deepEqual(
    canonicalIdentityFilter({ tenantId: 'tenant-a', userId: 'user-a' }),
    { tenantId: 'tenant-a', userId: 'user-a' },
  );
  for (const filter of [
    { tenantId: undefined },
    { userId: null },
    { tenantId: ' tenant-a' },
    { userId: ['user-a'] },
  ]) {
    assert.throws(() => canonicalIdentityFilter(filter), /identity/i);
  }
});

test('versioned JSON tuple keys cannot collide through separators', () => {
  const left = identityScopeTupleKey(
    requireCanonicalIdentityScope('a:b', 'c'),
    'POST',
    '/api/path',
    'key',
  );
  const right = identityScopeTupleKey(
    requireCanonicalIdentityScope('a', 'b:c'),
    'POST',
    '/api/path',
    'key',
  );
  assert.equal(left === right, false);
  assert.deepEqual(JSON.parse(left), ['identity-scope:v1', 'a:b', 'c', 'POST', '/api/path', 'key']);
  assert.throws(
    () => identityScopeTupleKey(LOCAL_IDENTITY_SCOPE, 7 as unknown as string),
    /tuple/i,
  );
});

test('identity parsing rejects proxies without invoking user-controlled traps', () => {
  for (const parse of [
    (value: unknown) => requireIdentityScopeFrom(value),
    (value: unknown) => canonicalIdentityFilter(value),
  ]) {
    const traps = { get: 0, getOwnPropertyDescriptor: 0, getPrototypeOf: 0, ownKeys: 0 };
    const value = new Proxy({ tenantId: 'tenant-a', userId: 'user-a' }, {
      get(target, key, receiver) {
        traps.get += 1;
        return Reflect.get(target, key, receiver);
      },
      getOwnPropertyDescriptor(target, key) {
        traps.getOwnPropertyDescriptor += 1;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
      getPrototypeOf(target) {
        traps.getPrototypeOf += 1;
        return Reflect.getPrototypeOf(target);
      },
      ownKeys(target) {
        traps.ownKeys += 1;
        return Reflect.ownKeys(target);
      },
    });

    assert.throws(() => parse(value), /identity/i);
    assert.deepEqual(traps, { get: 0, getOwnPropertyDescriptor: 0, getPrototypeOf: 0, ownKeys: 0 });
  }
});
