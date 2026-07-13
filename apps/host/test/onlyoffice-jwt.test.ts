import assert from 'node:assert/strict';
import test from 'node:test';

import {
  signOnlyOfficeJwt,
  verifyOnlyOfficeJwt,
} from '../src/artifacts/onlyoffice-jwt.js';

const SECRET = 'sample-onlyoffice-jwt-secret-for-tests';

test('ONLYOFFICE JWT signs and verifies HS256 payloads', () => {
  const token = signOnlyOfficeJwt({ payload: { key: 'doc-key', status: 2 } }, SECRET);
  assert.deepEqual(verifyOnlyOfficeJwt(token, SECRET), {
    payload: { key: 'doc-key', status: 2 },
  });
});

test('ONLYOFFICE JWT rejects tampering, wrong algorithms and expired claims', () => {
  const valid = signOnlyOfficeJwt({ exp: 1_700_000_010, value: 'safe' }, SECRET);
  assert.throws(
    () => verifyOnlyOfficeJwt(valid, SECRET, { nowSeconds: 1_700_000_011 }),
    /expired/i,
  );
  const [header, payload, signature] = valid.split('.');
  assert.throws(
    () => verifyOnlyOfficeJwt(`${header}.${payload}.${signature?.replace(/^./u, 'x')}`, SECRET),
    /signature/i,
  );
  const noneHeader = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  assert.throws(() => verifyOnlyOfficeJwt(`${noneHeader}.${payload}.`, SECRET), /HS256/i);
});
