import test from 'node:test';
import assert from 'node:assert/strict';
import { validateToolArguments } from '../src/kimi/agent/arg-validator.js';

test('validateToolArguments accepts values matching a simple object schema', () => {
  const result = validateToolArguments({
    type: 'object',
    required: ['path', 'limit'],
    properties: {
      path: { type: 'string' },
      limit: { type: 'integer' },
      tags: { type: 'array', items: { type: 'string' } },
    },
  }, { path: 'a.txt', limit: 3, tags: ['safe'] });

  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test('validateToolArguments rejects missing required fields and wrong types', () => {
  const result = validateToolArguments({
    type: 'object',
    required: ['path', 'limit'],
    properties: {
      path: { type: 'string' },
      limit: { type: 'integer' },
    },
  }, { path: 42 });

  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes('path') && error.includes('string')));
  assert.ok(result.errors.some((error) => error.includes('limit') && error.includes('required')));
});
