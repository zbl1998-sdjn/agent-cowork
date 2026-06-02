import test from 'node:test';
import assert from 'node:assert/strict';
import type { EvalTask } from '../../../eval/tasks/schema.js';

function usageTotalTokens(usage: unknown): unknown {
  return typeof usage === 'object' && usage !== null && 'totalTokens' in usage ? usage.totalTokens : undefined;
}

const TASK: EvalTask = {
  id: 'file-read-replay-backend',
  title: 'Read replayed answer',
  category: 'file-read',
  tags: [],
  prompt: 'Read input.txt and report the replayed value.',
  maxSteps: 3,
  fixture: { files: [{ path: 'input.txt', content: 'value: replayed\n' }] },
  assertions: [{ type: 'responseContains', contains: 'replayed' }],
};

test('offline eval replay executor reuses ModelRecorder records deterministically', async () => {
  const { createMemoryModelRecordStore, createModelRecorder } = await import('../src/runtime/model-recorder.js');
  const { createOfflineReplayExecutor, defaultEvalModelInput } = await import('../../../eval/replay-backend.js');
  const store = createMemoryModelRecordStore();
  const recorder = createModelRecorder({ store });
  await recorder.wrap(async () => ({
    content: 'replayed response',
    usage: { totalTokens: 7 },
  }))(defaultEvalModelInput({ task: TASK, trustedRoot: 'unused', taskIndex: 0 }));

  const executor = createOfflineReplayExecutor({ records: store.list() });
  const result = await executor({ task: TASK, trustedRoot: 'unused', taskIndex: 0 });

  assert.equal(result.response, 'replayed response');
  assert.equal(usageTotalTokens(result.usage), 7);
  assert.equal(result.steps, 1);
});

test('offline eval replay executor fails closed on replay miss', async () => {
  const { createOfflineReplayExecutor } = await import('../../../eval/replay-backend.js');
  const executor = createOfflineReplayExecutor({ records: [] });

  await assert.rejects(
    () => executor({ task: TASK, trustedRoot: 'unused', taskIndex: 0 }),
    (error) => typeof error === 'object' && error !== null && 'code' in error && error.code === 'MODEL_REPLAY_MISS',
  );
});
