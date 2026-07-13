import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getCacheTelemetry,
  getSafeCacheTelemetry,
  recordCacheUsage,
  resetCacheTelemetry,
} from '../src/engine/cache-telemetry.js';
import { sanitizeTelemetryPayload } from '../src/security/telemetry-allowlist.js';

test('safe cache telemetry strips raw cache keys but preserves allowlisted counters', () => {
  resetCacheTelemetry();
  recordCacheUsage(
    { prompt_tokens: 100, cached_tokens: 40 },
    { cacheKey: 'conversation-user-file-path-secret', prefixHash: 'prefix-a' },
  );

  const raw = getCacheTelemetry();
  assert.equal(raw.byKey[0]?.key, 'conversation-user-file-path-secret');

  const safe = getSafeCacheTelemetry();
  assert.equal(safe.calls, 1);
  assert.equal(safe.cachedTokens, 40);
  assert.equal(safe.byKey[0]?.slot, 1);
  assert.equal('key' in (safe.byKey[0] || {}), false);
  resetCacheTelemetry();
});

test('telemetry sanitizer rejects prompts, files, outputs, paths, urls, and credentials', () => {
  const result = sanitizeTelemetryPayload({
    calls: 1,
    prompt: 'secret prompt',
    file: 'C:/private/report.md',
    output: 'model output',
    baseUrl: 'https://api.example.test/v1',
    apiKey: 'sk-test-secret',
    byKey: [{ slot: 1, calls: 1, hitRatePct: 50, cacheKey: 'session-1' }],
  });

  assert.equal((result.payload as Record<string, unknown>).calls, 1);
  assert.ok(result.rejectedKeys.includes('prompt'));
  assert.ok(result.rejectedKeys.includes('file'));
  assert.ok(result.rejectedKeys.includes('output'));
  assert.ok(result.rejectedKeys.includes('baseUrl'));
  assert.ok(result.rejectedKeys.includes('apiKey'));
  assert.ok(result.rejectedKeys.includes('byKey[0].cacheKey'));
});
