// Kimi 配置 apiKey 落盘加密(切片 2 · 明文凭据缺口修复)
// ---------------------------------------------------------------------------
// persistKimiConfig 写盘前封印 apiKey(含 fallbacks 内的),applyPersistedKimiConfig
// 读侧兼容:密文解封 / 遗留明文原样 / 解封失败按未配置跳过且不拖垮其他字段。
// 测试注入 AES-GCM protector(跨平台、避免 DPAPI 拉 PowerShell 的耗时)。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { applyPersistedKimiConfig, persistKimiConfig } from '../src/kimi/config-store.js';
import { createAesGcmProtector, isSealedCredential } from '../src/security/credential-store.js';

const SECRET = 'sk-test-dummy-config-crypto-key-123456'; // allowlist-secret
const FALLBACK_SECRET = 'sk-test-dummy-fallback-key-654321'; // allowlist-secret

function tmpFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-cfg-crypto-')), 'config.json');
}

const protector = createAesGcmProtector({ keyMaterial: 'kimi-config-crypto-test' });

test('persistKimiConfig seals apiKey (incl. fallbacks) so plaintext never hits disk', () => {
  const file = tmpFile();
  persistKimiConfig(file, {
    apiKey: SECRET,
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'kimi-k2.6',
    fallbacks: [{ provider: 'anthropic', apiKey: FALLBACK_SECRET, model: 'claude-sonnet-5' }],
  }, { protector });

  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(!raw.includes(SECRET), 'plaintext primary key leaked to disk');
  assert.ok(!raw.includes(FALLBACK_SECRET), 'plaintext fallback key leaked to disk');
  const parsed = JSON.parse(raw) as { kimiApi: { apiKey: string; fallbacks: Array<{ apiKey?: string }> } };
  assert.ok(isSealedCredential(parsed.kimiApi.apiKey));
  assert.ok(isSealedCredential(parsed.kimiApi.fallbacks[0]?.apiKey));
});

test('applyPersistedKimiConfig round-trips sealed keys back to plaintext in memory', () => {
  const file = tmpFile();
  persistKimiConfig(file, {
    apiKey: SECRET,
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'kimi-k2.6',
    fallbacks: [{ provider: 'anthropic', apiKey: FALLBACK_SECRET, model: 'claude-sonnet-5' }],
  }, { protector });

  const target: Record<string, unknown> = {};
  applyPersistedKimiConfig(file, target, { protector });
  assert.equal(target.apiKey, SECRET);
  assert.equal(target.model, 'kimi-k2.6');
  const fallbacks = target.fallbacks as Array<{ apiKey?: string }>;
  assert.equal(fallbacks[0]?.apiKey, FALLBACK_SECRET);
  assert.equal(target.configured, true);
});

test('legacy plaintext config files keep loading (migrate-on-write compatibility)', () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({ kimiApi: { apiKey: SECRET, baseUrl: 'https://x.example/v1', model: 'legacy-model' } }), 'utf8');

  const target: Record<string, unknown> = {};
  applyPersistedKimiConfig(file, target, { protector });
  assert.equal(target.apiKey, SECRET);
  assert.equal(target.model, 'legacy-model');

  // 下次写盘自动升级为密文
  persistKimiConfig(file, target, { protector });
  assert.ok(!fs.readFileSync(file, 'utf8').includes(SECRET));
});

test('an unopenable sealed key is treated as unconfigured without dropping other fields', () => {
  const file = tmpFile();
  const alien = createAesGcmProtector({ keyMaterial: 'a-different-machine' }).protect(SECRET);
  fs.writeFileSync(file, JSON.stringify({
    kimiApi: {
      apiKey: alien,
      baseUrl: 'https://api.moonshot.cn/v1',
      model: 'kimi-k2.6',
      fallbacks: [{ provider: 'anthropic', apiKey: alien, model: 'claude-sonnet-5' }],
    },
  }), 'utf8');

  const target: Record<string, unknown> = {};
  applyPersistedKimiConfig(file, target, { protector });
  assert.equal(target.apiKey, undefined, 'unopenable key must not surface as a usable value');
  assert.equal(target.baseUrl, 'https://api.moonshot.cn/v1', 'other fields survive an unopenable key');
  assert.equal(target.model, 'kimi-k2.6');
  const fallbacks = target.fallbacks as Array<{ apiKey?: string; provider?: string }>;
  assert.equal(fallbacks[0]?.apiKey, undefined);
  assert.equal(fallbacks[0]?.provider, 'anthropic', 'fallback routing fields survive');
  assert.equal(target.configured, false);
});

test('default protector path round-trips without injection (DPAPI on win32, AES elsewhere)', () => {
  const file = tmpFile();
  persistKimiConfig(file, { apiKey: SECRET, baseUrl: 'https://api.moonshot.cn/v1', model: 'kimi-k2.6' });
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(!raw.includes(SECRET), 'default protector left plaintext on disk');

  const target: Record<string, unknown> = {};
  applyPersistedKimiConfig(file, target);
  assert.equal(target.apiKey, SECRET);
});
