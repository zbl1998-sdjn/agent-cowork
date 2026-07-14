import test from 'node:test';
import assert from 'node:assert/strict';
import { readCompatEnv } from '../src/util/env-compat.js';

test('readCompatEnv prefers the new name when it exists, even if empty', () => {
  assert.equal(readCompatEnv({ ACW_STORE: 'sqlite', KCW_STORE: 'file' }, 'ACW_STORE', 'KCW_STORE'), 'sqlite');
  assert.equal(readCompatEnv({ ACW_STORE: '', KCW_STORE: 'file' }, 'ACW_STORE', 'KCW_STORE'), '', 'an explicit empty new value must shadow the legacy value, not fall through to it');
});

test('readCompatEnv falls back through legacy names in order when the new name is unset', () => {
  assert.equal(readCompatEnv({ KCW_STORE: 'file' }, 'ACW_STORE', 'KCW_STORE'), 'file');
  assert.equal(readCompatEnv({ KIMI_MODEL: 'kimi-k2.7-code' }, 'ACW_MODEL', 'KCW_MODEL', 'KIMI_MODEL'), 'kimi-k2.7-code');
  assert.equal(readCompatEnv({ KCW_MODEL: 'a', KIMI_MODEL: 'b' }, 'ACW_MODEL', 'KCW_MODEL', 'KIMI_MODEL'), 'a', 'the nearer legacy name wins over the older one');
});

test('readCompatEnv returns undefined when no candidate name is set', () => {
  assert.equal(readCompatEnv({}, 'ACW_STORE', 'KCW_STORE'), undefined);
});
