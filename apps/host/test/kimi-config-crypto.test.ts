// Kimi 配置 apiKey 落盘加密(切片 2 · 明文凭据缺口修复)
// ---------------------------------------------------------------------------
// persistModelConfig 写盘前封印 apiKey(含 fallbacks 内的),applyPersistedAgentModelConfig
// 读侧兼容:密文解封 / 遗留明文原样 / 解封失败按未配置跳过且不拖垮其他字段。
// 测试注入 AES-GCM protector(跨平台、避免 DPAPI 拉 PowerShell 的耗时)。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { applyPersistedAgentModelConfig, persistModelConfig } from '../src/engine/config-store.js';
import { createAesGcmProtector, isSealedCredential } from '../src/security/credential-store.js';
import { createServer } from '../src/server.js';

const SECRET = 'sk-test-dummy-config-crypto-key-123456'; // allowlist-secret
const FALLBACK_SECRET = 'sk-test-dummy-fallback-key-654321'; // allowlist-secret

function tmpFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-cfg-crypto-')), 'config.json');
}

const protector = createAesGcmProtector({ keyMaterial: 'kimi-config-crypto-test' });

test('persistModelConfig seals apiKey (incl. fallbacks) so plaintext never hits disk', () => {
  const file = tmpFile();
  persistModelConfig(file, {
    apiKey: SECRET,
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'kimi-k2.6',
    fallbacks: [{ provider: 'anthropic', apiKey: FALLBACK_SECRET, model: 'claude-sonnet-5' }],
  }, { protector });

  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(!raw.includes(SECRET), 'plaintext primary key leaked to disk');
  assert.ok(!raw.includes(FALLBACK_SECRET), 'plaintext fallback key leaked to disk');
  const parsed = JSON.parse(raw) as { modelApi: { apiKey: string; fallbacks: Array<{ apiKey?: string }> } };
  assert.ok(isSealedCredential(parsed.modelApi.apiKey));
  assert.ok(isSealedCredential(parsed.modelApi.fallbacks[0]?.apiKey));
});

test('applyPersistedAgentModelConfig round-trips sealed keys back to plaintext in memory', () => {
  const file = tmpFile();
  persistModelConfig(file, {
    apiKey: SECRET,
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'kimi-k2.6',
    fallbacks: [{ provider: 'anthropic', apiKey: FALLBACK_SECRET, model: 'claude-sonnet-5' }],
  }, { protector });

  const target: Record<string, unknown> = {};
  applyPersistedAgentModelConfig(file, target, { protector });
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
  applyPersistedAgentModelConfig(file, target, { protector });
  assert.equal(target.apiKey, SECRET);
  assert.equal(target.model, 'legacy-model');

  // 下次写盘自动升级为密文
  persistModelConfig(file, target, { protector });
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
  applyPersistedAgentModelConfig(file, target, { protector });
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
  persistModelConfig(file, { apiKey: SECRET, baseUrl: 'https://api.moonshot.cn/v1', model: 'kimi-k2.6' });
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(!raw.includes(SECRET), 'default protector left plaintext on disk');

  const target: Record<string, unknown> = {};
  applyPersistedAgentModelConfig(file, target);
  assert.equal(target.apiKey, SECRET);
});

test('a non-empty corrupt Kimi config fails startup without exposing or overwriting its bytes', () => {
  const file = tmpFile();
  const corruptBytes = `{"kimiApi":{"apiKey":"${SECRET}"`;
  fs.writeFileSync(file, corruptBytes, 'utf8');
  let startupError: unknown;
  try {
    createServer({
      trustedRoot: path.dirname(file),
      modelConfigFile: file,
      modelConfigProtector: protector,
      requireAuth: false,
      persistAuth: false,
      enableScheduler: false,
      enableSandbox: false,
      rateLimit: false,
    });
  } catch (error) {
    startupError = error;
  }
  assert.ok(startupError instanceof Error, 'corrupt config must fail startup');
  assert.match(startupError.message, /agent model config/i);
  assert.equal(startupError.message.includes(SECRET), false);
  assert.equal(fs.readFileSync(file, 'utf8'), corruptBytes);

  const missingFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-cfg-missing-')), 'config.json');
  assert.doesNotThrow(() => createServer({
    trustedRoot: path.dirname(missingFile),
    modelConfigFile: missingFile,
    modelConfigProtector: protector,
    requireAuth: false,
    persistAuth: false,
    enableScheduler: false,
    enableSandbox: false,
    rateLimit: false,
  }));
  assert.equal(fs.existsSync(missingFile), false);
});

test('persistModelConfig keeps the previous file and cleans temp data when atomic replace fails', () => {
  const file = tmpFile();
  const originalBytes = 'original-config-bytes';
  fs.writeFileSync(file, originalBytes, 'utf8');
  const renameError = new Error('simulated atomic rename failure');
  const originalRenameSync = fs.renameSync;
  fs.renameSync = (() => { throw renameError; }) as typeof fs.renameSync;
  try {
    assert.throws(
      () => persistModelConfig(file, { apiKey: SECRET, baseUrl: 'https://new.example/v1', model: 'new-model' }, { protector }),
      (error: unknown) => error === renameError,
    );
  } finally {
    fs.renameSync = originalRenameSync;
  }
  assert.equal(fs.readFileSync(file, 'utf8'), originalBytes);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), [path.basename(file)]);
});

test('persistModelConfig never deletes a colliding temporary file it did not create', () => {
  const file = tmpFile();
  fs.writeFileSync(file, 'original-config-bytes', 'utf8');
  const mutableFs = fs as unknown as {
    openSync(filePath: string, flags: string, mode?: number): number;
  };
  const originalOpenSync = mutableFs.openSync;
  let collidingFile = '';
  mutableFs.openSync = (filePath, flags, mode) => {
    if (flags === 'wx' && filePath.endsWith('.tmp')) {
      collidingFile = filePath;
      fs.writeFileSync(filePath, 'collision-sentinel', { encoding: 'utf8', flag: 'wx' });
    }
    return originalOpenSync(filePath, flags, mode);
  };

  try {
    assert.throws(
      () => persistModelConfig(file, { apiKey: SECRET, model: 'new-model' }, { protector }),
      (error: unknown) => Boolean(error)
        && typeof error === 'object'
        && (error as { code?: unknown }).code === 'EEXIST',
    );
  } finally {
    mutableFs.openSync = originalOpenSync;
  }

  assert.equal(fs.readFileSync(file, 'utf8'), 'original-config-bytes');
  assert.equal(fs.readFileSync(collidingFile, 'utf8'), 'collision-sentinel');
});
