import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

test('GitHub pull requests cannot bypass the version-controlled replay eval', () => {
  const workflow = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.match(workflow, /pull_request:/);
  const start = workflow.indexOf('  eval-replay:');
  const end = workflow.indexOf('  desktop-source-build:', start);
  assert.ok(start >= 0 && end > start, 'eval-replay job must be a top-level CI job');
  const evalJob = workflow.slice(start, end);
  assert.match(evalJob, /runs-on: ubuntu-24\.04/);
  assert.match(evalJob, /needs: check/);
  assert.match(evalJob, /run: npm run eval/);
  assert.match(evalJob, /KCW_EVAL_REPLAY_RECORDS: eval\/fixtures\/ci-model-records\.json/);
  assert.doesNotMatch(evalJob, /KCW_EVAL_CONTRACT_EXECUTOR/);
  assert.doesNotMatch(evalJob, /^\s+if:/m);
});
