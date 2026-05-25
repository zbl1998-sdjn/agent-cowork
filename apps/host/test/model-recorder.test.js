import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

test('JsonlModelRecordStore persists sanitized records for deterministic replay', async () => {
  const {
    createJsonlModelRecordStore,
    createModelRecorder,
    createModelReplayer,
  } = await import('../src/runtime/model-recorder.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-model-records-'));
  const filePath = path.join(dir, 'records.jsonl');
  const store = createJsonlModelRecordStore(filePath);
  const recorder = createModelRecorder({ store });

  await recorder.wrap(async () => ({
    content: 'persisted-answer',
    usage: { total_tokens: 9 },
  }))(INPUT);
  assert.equal(store.filePath, filePath);

  const raw = fs.readFileSync(filePath, 'utf8');
  assert.ok(raw.endsWith('\n'));
  assert.equal(raw.trim().split(/\r?\n/).length, 1);
  assert.ok(!raw.includes('sk-RECORDERSECRET'), 'jsonl record leaked model API key');
  assert.ok(!raw.includes('fetchImpl'), 'jsonl record stored non-deterministic fetchImpl');

  const reloadedStore = createJsonlModelRecordStore(filePath);
  const records = reloadedStore.list();
  assert.equal(records.length, 1);
  assert.equal(records[0].request.kimiConfig.apiKey, '[REDACTED]');
  const replayed = await createModelReplayer({ store: reloadedStore }).wrap()(INPUT);
  assert.deepEqual(replayed, { content: 'persisted-answer', usage: { total_tokens: 9 } });
});

test('JsonlModelRecordStore ignores failed records during replay', async () => {
  const {
    createJsonlModelRecordStore,
    createModelRecorder,
    createModelReplayer,
  } = await import('../src/runtime/model-recorder.js');
  const filePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-model-records-')), 'records.jsonl');
  const store = createJsonlModelRecordStore(filePath);
  const recorder = createModelRecorder({ store });
  await assert.rejects(
    () => recorder.wrap(async () => {
      throw new Error('upstream sk-FAILSECRET1234567890 failed');
    })(INPUT),
    /upstream/,
  );

  assert.ok(!fs.readFileSync(filePath, 'utf8').includes('sk-FAILSECRET'), 'jsonl error record leaked secret text');
  await assert.rejects(
    () => createModelReplayer({ store }).wrap()(INPUT),
    (error) => error.code === 'MODEL_REPLAY_MISS',
  );
});
