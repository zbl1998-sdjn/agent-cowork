import test from 'node:test';
import assert from 'node:assert/strict';

const INPUT = {
  messages: [{ role: 'user', content: 'hello' }],
  tools: [{ type: 'function', function: { name: 'Read', parameters: { type: 'object' } } }],
  kimiConfig: {
    model: 'fake-model',
    baseUrl: 'https://api.example.test',
    apiKey: 'sk-RECORDERSECRET1234567890',
  },
  fetchImpl: async () => ({}),
  onContent: () => {},
  signal: new AbortController().signal,
};

test('ModelRecorder records sanitized model-call input and exact response', async () => {
  const {
    createMemoryModelRecordStore,
    createModelRecorder,
  } = await import('../src/runtime/model-recorder.js');
  const store = createMemoryModelRecordStore();
  const recorder = createModelRecorder({
    store,
    now: (() => {
      const times = ['2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.000Z'];
      return () => times.shift() || '2026-01-01T00:00:02.000Z';
    })(),
  });

  const wrapped = recorder.wrap(async ({ messages }) => ({
    content: `reply:${messages[0].content}`,
    usage: { total_tokens: 3 },
  }));
  const result = await wrapped(INPUT);

  assert.deepEqual(result, { content: 'reply:hello', usage: { total_tokens: 3 } });
  const records = store.list();
  assert.equal(records.length, 1);
  assert.equal(records[0].status, 'succeeded');
  assert.equal(records[0].startedAt, '2026-01-01T00:00:00.000Z');
  assert.equal(records[0].finishedAt, '2026-01-01T00:00:01.000Z');
  assert.equal(records[0].response.content, 'reply:hello');
  assert.equal(records[0].request.kimiConfig.apiKey, '[REDACTED]');
  assert.equal(records[0].request.fetchImpl, undefined);
  assert.equal(records[0].request.onContent, undefined);
  assert.equal(records[0].request.signal, undefined);
  assert.ok(!JSON.stringify(records).includes('sk-RECORDERSECRET'), 'record leaked model API key');
});

test('ModelReplayer returns the recorded response for the same sanitized input', async () => {
  const {
    createMemoryModelRecordStore,
    createModelRecorder,
    createModelReplayer,
  } = await import('../src/runtime/model-recorder.js');
  const store = createMemoryModelRecordStore();
  const recorder = createModelRecorder({ store });
  await recorder.wrap(async () => ({ content: 'recorded-answer' }))(INPUT);

  let upstreamCalls = 0;
  const replayer = createModelReplayer({ store });
  const replayed = await replayer.wrap(async () => {
    upstreamCalls += 1;
    return { content: 'live-answer' };
  })({
    ...INPUT,
    kimiConfig: { ...INPUT.kimiConfig, apiKey: 'sk-DIFFERENTSECRET1234567890' },
  });

  assert.equal(replayed.content, 'recorded-answer');
  assert.equal(upstreamCalls, 0);
  await assert.rejects(
    () => replayer.wrap(async () => ({ content: 'never' }))({
      ...INPUT,
      messages: [{ role: 'user', content: 'different' }],
    }),
    (error) => error.code === 'MODEL_REPLAY_MISS',
  );
});
