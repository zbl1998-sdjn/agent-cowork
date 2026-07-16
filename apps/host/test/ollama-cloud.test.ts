import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { isCloudModelName, RECOMMENDED_CLOUD_MODELS, resolveOllamaBinary } from '../src/engine/provider/ollama-cloud.js';

test('isCloudModelName accepts -cloud/:cloud models and rejects injection or non-cloud', () => {
  assert.equal(isCloudModelName('gpt-oss:120b-cloud'), true);
  assert.equal(isCloudModelName('deepseek-v4-flash:cloud'), true);
  assert.equal(isCloudModelName('kimi-k2.7-code:cloud'), true);
  // non-cloud local model must be refused (pull only for cloud here)
  assert.equal(isCloudModelName('qwen2.5:0.5b'), false);
  // injection / shell metacharacters / spaces / flags must all fail the charset+shape check
  assert.equal(isCloudModelName('gpt-oss:120b-cloud; rm -rf /'), false);
  assert.equal(isCloudModelName('a && curl evil:cloud'), false);
  assert.equal(isCloudModelName('--config=/etc/x:cloud'), false);
  assert.equal(isCloudModelName('$(whoami):cloud'), false);
  assert.equal(isCloudModelName(''), false);
  assert.equal(isCloudModelName('no-colon-cloud'), false);
  assert.equal(isCloudModelName(`${'a'.repeat(200)}:cloud`), false);
  // every recommended model must itself pass validation
  for (const m of RECOMMENDED_CLOUD_MODELS) assert.equal(isCloudModelName(m), true, m);
});

test('resolveOllamaBinary prefers an existing install path, else falls back to the bare command', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acw-ollama-'));
  const programs = path.join(dir, 'Programs', 'Ollama');
  fs.mkdirSync(programs, { recursive: true });
  const exe = process.platform === 'win32' ? 'ollama.exe' : 'ollama';
  const installed = path.join(programs, exe);
  fs.writeFileSync(installed, '');
  assert.equal(resolveOllamaBinary({ LOCALAPPDATA: dir } as Record<string, string | undefined>), installed);

  // no known path -> bare command name (PATH resolution / spawn error handled upstream)
  assert.equal(resolveOllamaBinary({ LOCALAPPDATA: path.join(dir, 'nope') } as Record<string, string | undefined>), exe);
});
