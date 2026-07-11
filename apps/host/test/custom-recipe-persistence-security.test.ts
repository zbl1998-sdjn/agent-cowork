import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeCustomRecipeSnapshot } from '../src/recipes/custom-recipe-persistence.js';

test('custom recipe snapshot rejects a revoked recipe-array Proxy deterministically', () => {
  const revocable = Proxy.revocable<unknown[]>([], {});
  revocable.revoke();

  assert.throws(
    () => decodeCustomRecipeSnapshot({ recipes: revocable.proxy }),
    /expected an exact object with a recipes array/,
  );
});
