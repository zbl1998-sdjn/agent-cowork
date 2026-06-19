import assert from 'node:assert/strict';
import test from 'node:test';
import { omitUndefined } from '../src/util/object.js';

test('omitUndefined removes only undefined values and preserves other falsy values', () => {
  const input = {
    keepNull: null,
    keepFalse: false,
    keepZero: 0,
    keepEmpty: '',
    drop: undefined,
    nested: { value: undefined },
  };

  const output = omitUndefined(input);

  assert.deepEqual(output, {
    keepNull: null,
    keepFalse: false,
    keepZero: 0,
    keepEmpty: '',
    nested: { value: undefined },
  });
  assert.equal(Object.hasOwn(output, 'drop'), false);
  assert.equal(Object.hasOwn(input, 'drop'), true);
});
