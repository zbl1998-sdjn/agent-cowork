import test from 'node:test';
import assert from 'node:assert/strict';

const TASK = {
  id: 'file-read-replay-backend',
  title: 'Read replayed answer',
  category: 'file-read',
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
  }))(defaultEvalModelInput({ task: TASK }));

  const executor = createOfflineReplayExecutor({ records: store.list() });
  const result = await executor({ task: TASK, trustedRoot: 'unused' });

  assert.equal(result.response, 'replayed response');
  assert.equal(result.usage.totalTokens, 7);
  assert.equal(result.steps, 1);
});

test('offline eval replay executor fails closed on replay miss', async () => {
  const { createOfflineReplayExecutor } = await import('../../../eval/replay-backend.js');
  const executor = createOfflineReplayExecutor({ records: [] });

  await assert.rejects(
    () => executor({ task: TASK, trustedRoot: 'unused' }),
    (error) => error.code === 'MODEL_REPLAY_MISS',
  );
});
