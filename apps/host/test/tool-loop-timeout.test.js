import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAgentChat } from '../src/kimi/agent-runner.js';

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-tool-loop-timeout-'));
}

test('runAgentChat aborts a hung model call when the run wall-clock timeout expires', async () => {
  const root = tmp();
  const events = [];
  let sawSignal = false;
  const modelCall = async ({ signal }) => {
    sawSignal = !!signal;
    return new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => {
        const err = new Error('aborted by run timeout');
        err.name = 'AbortError';
        reject(err);
      }, { once: true });
      setTimeout(() => resolve({ content: 'too late' }), 1_000);
    });
  };

  const out = await runAgentChat({
    prompt: 'hang',
    kimiConfig: { model: 'fake', timeoutMs: 5_000 },
    trustedRoot: root,
    modelCall,
    runTimeoutMs: 20,
    emit: (type, payload) => events.push({ type, payload }),
    runStoreRoot: path.join(root, 'runs'),
  });

  assert.equal(sawSignal, true);
  assert.equal(out.timeoutStopped, true);
  assert.match(out.text, /时间上限|timeout/i);
  assert.ok(events.some((event) => event.type === 'run_timeout'));
});
