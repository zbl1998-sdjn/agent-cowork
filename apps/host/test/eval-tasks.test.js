import test from 'node:test';
import assert from 'node:assert/strict';

test('golden eval tasks load with schema coverage required by plan/07 A1', async () => {
  const { loadGoldenEvalTasks } = await import('../../../eval/tasks/index.js');
  const tasks = loadGoldenEvalTasks();

  assert.ok(tasks.length >= 20, 'plan/07 A1 requires at least 20 golden tasks');
  assert.equal(new Set(tasks.map((task) => task.id)).size, tasks.length, 'task ids must be unique');

  const categories = new Set(tasks.map((task) => task.category));
  for (const required of [
    'file-read',
    'file-write',
    'workspace-search',
    'multi-step-refactor',
    'approval-flow',
    'office-artifact',
    'batch-files',
    'conversation-branches',
  ]) {
    assert.ok(categories.has(required), `missing required eval category: ${required}`);
  }

  for (const task of tasks) {
    assert.match(task.id, /^[a-z0-9][a-z0-9-]{4,80}$/);
    assert.equal(typeof task.title, 'string');
    assert.ok(task.title.length > 4);
    assert.equal(typeof task.prompt, 'string');
    assert.ok(task.prompt.length > 10);
    assert.ok(Array.isArray(task.assertions) && task.assertions.length > 0, `${task.id} lacks assertions`);
    assert.ok(Array.isArray(task.fixture.files), `${task.id} lacks fixture.files`);
    assert.equal(typeof task.maxSteps, 'number');
    assert.ok(task.maxSteps > 0);
  }
});

test('EvalTask validation rejects tasks without deterministic assertions', async () => {
  const { validateEvalTask } = await import('../../../eval/tasks/schema.js');
  assert.throws(
    () => validateEvalTask({
      id: 'bad-task',
      title: 'Bad task',
      category: 'file-read',
      prompt: 'read the file',
      fixture: { files: [] },
      maxSteps: 3,
      assertions: [],
    }),
    /assertions/i,
  );
});
