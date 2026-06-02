import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { EvalTask } from '../../../eval/tasks/schema.js';

type ScoreLike = {
  passed: boolean;
};

function assertScoreLike(score: unknown): asserts score is ScoreLike {
  assert.ok(score && typeof score === 'object' && 'passed' in score);
  assert.equal(typeof score.passed, 'boolean');
}

const TASKS: EvalTask[] = [
  {
    id: 'file-read-runner-one',
    title: 'Read one file',
    category: 'file-read',
    tags: [],
    prompt: 'Read input.txt and report the value.',
    maxSteps: 3,
    fixture: { files: [{ path: 'input.txt', content: 'value: 42\n' }] },
    assertions: [
      { type: 'responseContains', contains: '42' },
      { type: 'toolCalled', tool: 'Read' },
    ],
  },
  {
    id: 'file-write-runner-two',
    title: 'Write one file',
    category: 'file-write',
    tags: [],
    prompt: 'Write result.md with the final answer.',
    maxSteps: 4,
    fixture: { files: [{ path: 'notes/source.md', content: 'answer: stable\n' }] },
    assertions: [
      { type: 'fileContains', path: 'result.md', contains: 'stable' },
      { type: 'toolCalled', tool: 'Write' },
    ],
  },
];

test('EvalRunner runs tasks in isolated trusted roots and aggregates scores', async () => {
  const { runEvalTasks } = await import('../../../eval/runner.js');
  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-eval-runner-'));
  const seenRoots: string[] = [];
  try {
    const summary = await runEvalTasks({
      tasks: TASKS,
      workRoot,
      executor: async ({ task, trustedRoot }) => {
        seenRoots.push(trustedRoot);
        const firstFixtureFile = task.fixture.files.at(0);
        assert.ok(firstFixtureFile);
        assert.ok(trustedRoot.startsWith(workRoot));
        assert.ok(fs.existsSync(path.join(trustedRoot, firstFixtureFile.path)));
        if (task.id === 'file-write-runner-two') {
          fs.writeFileSync(path.join(trustedRoot, 'result.md'), 'stable result\n');
          return {
            response: 'wrote result',
            files: { 'result.md': 'stable result\n' },
            toolCalls: [{ name: 'Write' }],
            steps: 2,
            latencyMs: 15,
            usage: { totalTokens: 12, costUsd: 0.0002 },
          };
        }
        return {
          response: 'value is 42',
          files: { 'input.txt': 'value: 42\n' },
          toolCalls: [{ name: 'Read' }],
          steps: 1,
          latencyMs: 10,
          usage: { totalTokens: 10, costUsd: 0.0001 },
        };
      },
    });

    assert.equal(summary.totalTasks, 2);
    assert.equal(summary.passedTasks, 2);
    assert.equal(summary.failedTasks, 0);
    assert.equal(summary.passRate, 1);
    assert.equal(summary.results.length, 2);
    assert.equal(new Set(seenRoots).size, 2);
    assert.ok(summary.results.every((result) => {
      assertScoreLike(result.score);
      return result.score.passed;
    }));
  } finally {
    fs.rmSync(workRoot, { recursive: true, force: true });
  }
});

test('EvalRunner records task errors without aborting the remaining batch', async () => {
  const { runEvalTasks } = await import('../../../eval/runner.js');
  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-eval-runner-'));
  try {
    const summary = await runEvalTasks({
      tasks: TASKS,
      workRoot,
      executor: async ({ task }) => {
        if (task.id === 'file-read-runner-one') throw new Error('model replay miss');
        return {
          response: 'stable',
          files: { 'result.md': 'stable result\n' },
          toolCalls: [{ name: 'Write' }],
          steps: 1,
          latencyMs: 10,
          usage: { totalTokens: 5 },
        };
      },
    });

    assert.equal(summary.totalTasks, 2);
    assert.equal(summary.passedTasks, 1);
    assert.equal(summary.failedTasks, 1);
    assert.equal(summary.passRate, 0.5);
    const firstResult = summary.results.at(0);
    const secondResult = summary.results.at(1);
    assert.ok(firstResult);
    assert.ok(secondResult);
    assert.equal(firstResult.error?.message, 'model replay miss');
    assertScoreLike(firstResult.score);
    assertScoreLike(secondResult.score);
    assert.equal(firstResult.score.passed, false);
    assert.equal(secondResult.score.passed, true);
  } finally {
    fs.rmSync(workRoot, { recursive: true, force: true });
  }
});
