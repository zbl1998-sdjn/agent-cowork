import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.js';
import { makeTestWorkspace } from './test-fixtures.js';

// Verifies the test-suite escape hatch: test-setup.mjs (loaded via
// `node --test --import`) sets KCW_REQUIRE_AUTH=false, which opens the gate for
// tokenless functional tests. Run through the test:host script to see it pass.
test('KCW_REQUIRE_AUTH=false opens the gate for tokenless requests', async () => {
  const trustedRoot = makeTestWorkspace('kcw-authenv');
  const server = createServer({ trustedRoot }); // no requireAuth -> reads env
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${base}/api/workspace`);
    assert.equal(res.status, 200, 'gate should be disabled by KCW_REQUIRE_AUTH=false');
  } finally {
    await new Promise((r) => server.close(r));
  }
});
