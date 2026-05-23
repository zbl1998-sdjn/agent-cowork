import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runRecipe } from '../src/recipes/run-recipe.js';
import { RunEventBus } from '../src/runtime/run-events.js';
import { RunsIndex } from '../src/runtime/runs-index.js';
import { listRecipes } from '../src/recipes/registry.js';

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-recipe-'));
}

test('runRecipe produces operations, run record, events, and indexes the run', () => {
  const trustedRoot = tempRoot();
  const runStoreRoot = path.join(trustedRoot, '.AgentCowork', 'runs');
  const runEvents = new RunEventBus();
  const runsIndex = new RunsIndex({ indexRoot: path.join(trustedRoot, '.AgentCowork', 'index') });

  const recipeId = listRecipes()[0].id;
  const result = runRecipe({
    recipeId,
    trustedRoot,
    prompt: '测试运行',
    files: [],
    context: { tenantId: 'tenant_alice', userId: 'user_alice', traceId: 'trace_1' },
    runStoreRoot,
    runEvents,
    runsIndex,
  });

  assert.equal(result.ok, true);
  assert.match(result.runId, /^run_/);
  assert.ok(Array.isArray(result.operations));
  assert.ok(fs.existsSync(result.runPath), 'run record file written');

  // Event timeline shape.
  const types = result.events.map((e) => e.type);
  assert.ok(types.includes('user_message'));
  assert.ok(types.includes('assistant_start'));
  assert.ok(types.includes('preview'));
  assert.ok(types.includes('awaiting_approval'));
  assert.ok(types.includes('sources'));
  assert.equal(types[types.length - 1], 'assistant_end');
  // Events carry monotonic seq.
  for (let i = 1; i < result.events.length; i += 1) {
    assert.ok(result.events[i].seq > result.events[i - 1].seq);
  }

  // Run record embeds events for replay across restart.
  const record = JSON.parse(fs.readFileSync(result.runPath, 'utf8'));
  assert.ok(Array.isArray(record.events));
  assert.equal(record.events.length, result.events.length);

  // Indexed and tenant scoped.
  const listed = runsIndex.list({ tenantId: 'tenant_alice' });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, result.runId);
  assert.equal(runsIndex.list({ tenantId: 'tenant_bob' }).length, 0);
});

test('runRecipe throws 404 for unknown recipe', () => {
  const trustedRoot = tempRoot();
  assert.throws(
    () => runRecipe({
      recipeId: 'does-not-exist',
      trustedRoot,
      runStoreRoot: path.join(trustedRoot, '.AgentCowork', 'runs'),
    }),
    /Recipe not found/,
  );
});

test('runRecipe works without runEvents/runsIndex (events still numbered locally)', () => {
  const trustedRoot = tempRoot();
  const recipeId = listRecipes()[0].id;
  const result = runRecipe({
    recipeId,
    trustedRoot,
    prompt: 'no deps',
    runStoreRoot: path.join(trustedRoot, '.AgentCowork', 'runs'),
  });
  assert.equal(result.ok, true);
  assert.ok(result.events.length >= 5);
  assert.equal(result.events[0].seq, 1);
});
