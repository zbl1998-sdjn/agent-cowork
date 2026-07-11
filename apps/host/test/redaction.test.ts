import test from 'node:test';
import assert from 'node:assert/strict';
import { redactText, redactValue } from '../src/security/redaction.js';

type RedactedObject = {
  name: string;
  creds: { apiKey: string };
  list: string[];
};

function redactString(value: string): string {
  const out = redactText(value);
  assert.ok(typeof out === 'string');
  return out;
}

test('masks sk- API keys and every occurrence', () => {
  const out = redactString('key1 sk-ABCDEFGHIJ1234567890 and key2 sk-ZYXWVUTSRQ0987654321 done');
  assert.ok(!out.includes('sk-ABCDEFGHIJ'), 'first key leaked');
  assert.ok(!out.includes('sk-ZYXWVUTSRQ'), 'second key leaked (global flag regression)');
  assert.match(out, /\[REDACTED\].*\[REDACTED\]/);
});

test('masks the VALUE of label=value secrets, keeps the label', () => {
  const out = redactString('api_key=sk-test-dummy-0000000000');
  assert.ok(out.startsWith('api_key='), 'label should be kept for debuggability');
  assert.ok(!out.includes('sk-test-dummy'), 'value must be masked');
  assert.match(out, /\[REDACTED\]/);
});

test('masks Authorization bearer tokens', () => {
  const out = redactString('Authorization: Bearer abcdef.ghijkl.mnopqr123');
  assert.ok(!out.includes('abcdef.ghijkl'), 'bearer token leaked');
  assert.match(out.toLowerCase(), /bearer.*\[redacted\]/i);
});

test('masks JWT-shaped tokens', () => {
  const out = redactString('token eyJhbGciOiJI.eyJzdWIiOiAx.signature9876 end');
  assert.ok(!out.includes('eyJhbGciOiJI.eyJzdWIiOiAx'), 'JWT leaked');
});

test('masks sensitive filesystem paths', () => {
  assert.match(redactString('/home/bob/.ssh/id_rsa'), /\[REDACTED_PATH\]/);
  assert.match(redactString('C:\\Users\\bob\\AppData\\Roaming\\Kimi'), /\[REDACTED_PATH\]/);
});

test('leaves ordinary text untouched (no over-eager keyword masking)', () => {
  // The phrase "secret garden" must NOT be masked — only `secret=value` is.
  assert.equal(redactString('the secret garden was lovely'), 'the secret garden was lovely');
  assert.equal(redactString('hello world'), 'hello world');
  assert.equal(redactText(null), null);
  assert.equal(redactText(42), '42');
});

test('redactValue recurses into objects and arrays', () => {
  const out = redactValue({
    name: 'ok',
    creds: { apiKey: 'value sk-DEEPSECRET12345' },
    list: ['sk-LISTKEY1234567890'],
  }) as RedactedObject;
  assert.equal(out.name, 'ok');
  assert.ok(!JSON.stringify(out).includes('DEEPSECRET'), 'nested secret leaked');
  assert.ok(!JSON.stringify(out).includes('LISTKEY'), 'array secret leaked');
});

test('redactValue masks normalized sensitive keys regardless of value shape', () => {
  const out = redactValue({
    nested: {
      apiKey: 'short-value',
      ACCESS_TOKEN: { nested: 'must-not-survive' },
      'set-cookie': 'session=short',
      ordinaryTokenCount: 'kept',
    },
  });

  assert.deepEqual(out, {
    nested: {
      apiKey: '[REDACTED]',
      ACCESS_TOKEN: '[REDACTED]',
      'set-cookie': '[REDACTED]',
      ordinaryTokenCount: 'kept',
    },
  });
});

test('redactValue rejects revoked proxies before array introspection', () => {
  const revocable = Proxy.revocable<unknown[]>([], {});
  revocable.revoke();

  assert.throws(
    () => redactValue(revocable.proxy),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.name, 'Error');
      assert.equal(error.message, 'cannot redact proxy values');
      return true;
    },
  );
});
