import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type TestInput = Record<string, unknown> & {
  messages: Array<{ role: string; content: string }>;
  kimiConfig: { model: string; baseUrl: string; apiKey: string };
};
type StoredRecord = Record<string, unknown> & {
  request?: {
    kimiConfig?: { apiKey?: unknown };
    fetchImpl?: unknown;
    onContent?: unknown;
    signal?: unknown;
  };
  response?: { content?: unknown };
};

function firstRecord(records: StoredRecord[]): StoredRecord {
  const record = records[0];
  assert.ok(record);
  return record;
}

function errorCode(error: unknown): unknown {
  return error && typeof error === 'object' && 'code' in error ? error.code : undefined;
}

const INPUT: TestInput = {
  messages: [{ role: 'user', content: 'hello' }],
  tools: [{ type: 'function', function: { name: 'Read', parameters: { type: 'object' } } }],
  kimiConfig: {
    model: 'fake-model',
    baseUrl: 'https://api.example.test',
    apiKey: 'sk-test-recorder-secret-1234567890',
  },
  fetchImpl: async () => ({}),
  onContent: () => undefined,
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

  const wrapped = recorder.wrap(async (args = {}) => ({
    content: `reply:${(args.messages as TestInput['messages'])[0]?.content}`,
    usage: { total_tokens: 3 },
  }));
  const result = await wrapped(INPUT);

  assert.deepEqual(result, { content: 'reply:hello', usage: { total_tokens: 3 } });
  const records = store.list() as StoredRecord[];
  const record = firstRecord(records);
  assert.equal(records.length, 1);
  assert.equal(record.status, 'succeeded');
  assert.equal(record.startedAt, '2026-01-01T00:00:00.000Z');
  assert.equal(record.finishedAt, '2026-01-01T00:00:01.000Z');
  assert.equal(record.response?.content, 'reply:hello');
  assert.equal(record.request?.kimiConfig?.apiKey, '[REDACTED]');
  assert.equal(record.request?.fetchImpl, undefined);
  assert.equal(record.request?.onContent, undefined);
  assert.equal(record.request?.signal, undefined);
  assert.ok(!JSON.stringify(records).includes('sk-test-recorder-secret'), 'record leaked model API key');
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
    kimiConfig: { ...INPUT.kimiConfig, apiKey: 'sk-test-different-secret-1234567890' },
  });

  assert.equal((replayed as { content?: unknown }).content, 'recorded-answer');
  assert.equal(upstreamCalls, 0);
  await assert.rejects(
    () => replayer.wrap(async () => ({ content: 'never' }))({
      ...INPUT,
      messages: [{ role: 'user', content: 'different' }],
    }),
    (error) => errorCode(error) === 'MODEL_REPLAY_MISS',
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
  assert.ok(!raw.includes('sk-test-recorder-secret'), 'jsonl record leaked model API key');
  assert.ok(!raw.includes('fetchImpl'), 'jsonl record stored non-deterministic fetchImpl');

  const reloadedStore = createJsonlModelRecordStore(filePath);
  const records = reloadedStore.list() as StoredRecord[];
  const record = firstRecord(records);
  assert.equal(records.length, 1);
  assert.equal(record.request?.kimiConfig?.apiKey, '[REDACTED]');
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
      throw new Error('upstream sk-test-fail-secret-1234567890 failed');
    })(INPUT),
    /upstream/,
  );

  assert.ok(!fs.readFileSync(filePath, 'utf8').includes('sk-test-fail-secret'), 'jsonl error record leaked secret text');
  await assert.rejects(
    () => createModelReplayer({ store }).wrap()(INPUT),
    (error) => errorCode(error) === 'MODEL_REPLAY_MISS',
  );
});

test('JsonlModelRecordStore tolerates only a malformed final non-empty record', async () => {
  const { createJsonlModelRecordStore } = await import('../src/runtime/model-recorder.js');
  const filePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-model-records-')), 'records.jsonl');
  const valid = { fingerprint: 'sha256:valid', status: 'succeeded', response: { content: 'kept' } };
  fs.writeFileSync(filePath, `${JSON.stringify(valid)}\n{"fingerprint":\n\n`, 'utf8');

  const store = createJsonlModelRecordStore(filePath);
  assert.deepEqual(store.list(), [valid]);
  assert.deepEqual(store.findByFingerprint('sha256:valid'), valid);
});

test('JsonlModelRecordStore rejects malformed non-empty records before a later valid record', async () => {
  const { createJsonlModelRecordStore } = await import('../src/runtime/model-recorder.js');
  const filePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-model-records-')), 'records.jsonl');
  const first = { fingerprint: 'sha256:first', status: 'succeeded', response: { content: 'first' } };
  const later = { fingerprint: 'sha256:later', status: 'succeeded', response: { content: 'later' } };
  fs.writeFileSync(filePath, `${JSON.stringify(first)}\n{"fingerprint":\n${JSON.stringify(later)}\n`, 'utf8');

  const store = createJsonlModelRecordStore(filePath);
  assert.throws(() => store.list(), (error: unknown) => error instanceof SyntaxError);
  assert.throws(
    () => store.findByFingerprint('sha256:later'),
    (error: unknown) => error instanceof SyntaxError,
  );
});

test('JsonlModelRecordStore repairs malformed and unterminated tails before append', async () => {
  const { createJsonlModelRecordStore } = await import('../src/runtime/model-recorder.js');
  for (const tail of ['{"fingerprint":', JSON.stringify({
    fingerprint: 'sha256:unterminated',
    status: 'succeeded',
    response: { content: 'unterminated-kept' },
  })]) {
    const filePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-model-records-')), 'records.jsonl');
    const first = { fingerprint: 'sha256:first', status: 'succeeded', response: { content: 'first' } };
    const next = { fingerprint: 'sha256:next', status: 'succeeded', response: { content: 'next' } };
    fs.writeFileSync(filePath, `${JSON.stringify(first)}\n${tail}`, 'utf8');

    const store = createJsonlModelRecordStore(filePath);
    store.append(next);
    const fingerprints = store.list().map((record) => record.fingerprint);
    const expected = tail.startsWith('{"fingerprint":') && !tail.endsWith('}')
      ? ['sha256:first', 'sha256:next']
      : ['sha256:first', 'sha256:unterminated', 'sha256:next'];
    assert.deepEqual(fingerprints, expected);
  }
});

test('JsonlModelRecordStore rejects interior schema-invalid records', async () => {
  const { createJsonlModelRecordStore } = await import('../src/runtime/model-recorder.js');
  const filePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-model-records-')), 'records.jsonl');
  const valid = { fingerprint: 'sha256:valid', status: 'succeeded', response: { content: 'kept' } };
  fs.writeFileSync(filePath, `null\n${JSON.stringify(valid)}\n`, 'utf8');

  assert.throws(
    () => createJsonlModelRecordStore(filePath).list(),
    /model record|JSONL/i,
  );
});

test('JsonlModelRecordStore rejects complete schema-invalid final records without truncating them', async () => {
  const { createJsonlModelRecordStore } = await import('../src/runtime/model-recorder.js');
  const invalidRecords = [
    { fingerprint: 'sha256:missing-response', status: 'succeeded' },
    { fingerprint: 'sha256:missing-error', status: 'failed' },
    { fingerprint: 'sha256:bad-status', status: 'unknown', response: null },
  ];
  for (const invalid of invalidRecords) {
    const filePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-model-records-')), 'records.jsonl');
    const raw = `${JSON.stringify(invalid)}\n`;
    fs.writeFileSync(filePath, raw, 'utf8');
    const store = createJsonlModelRecordStore(filePath);

    assert.throws(() => store.list(), /model record|JSONL/i);
    assert.throws(
      () => store.append({
        fingerprint: 'sha256:next',
        status: 'succeeded',
        response: { content: 'next' },
      }),
      /model record|JSONL/i,
    );
    assert.equal(fs.readFileSync(filePath, 'utf8'), raw, 'invalid complete tail must not be truncated');
  }
});

test('JsonlModelRecordStore persists an undefined successful response as explicit null', async () => {
  const { createJsonlModelRecordStore, createModelRecorder } = await import('../src/runtime/model-recorder.js');
  const filePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-model-records-')), 'records.jsonl');
  const store = createJsonlModelRecordStore(filePath);

  const result = await createModelRecorder({ store }).wrap(async () => undefined)(INPUT);

  assert.equal(result, undefined);
  assert.equal(store.list()[0]?.response, null);
});

test('ModelRecorder redacts sensitive responses and keeps secret-bearing prompts fingerprint-distinct', async () => {
  const {
    createJsonlModelRecordStore,
    createModelRecorder,
    createModelReplayer,
    modelCallFingerprint,
  } = await import('../src/runtime/model-recorder.js');
  const secretA = 'sk-test-response-a-12345678901234567890';
  const secretB = 'sk-test-response-b-12345678901234567890';
  const inputA = { ...INPUT, messages: [{ role: 'user', content: `inspect ${secretA}` }] };
  const inputB = { ...INPUT, messages: [{ role: 'user', content: `inspect ${secretB}` }] };
  assert.ok(modelCallFingerprint(inputA) !== modelCallFingerprint(inputB));
  assert.notEqual(
    modelCallFingerprint({ business: { password: 'dummy-business-a' } }),
    modelCallFingerprint({ business: { password: 'dummy-business-b' } }),
  );
  assert.notEqual(
    modelCallFingerprint({ toolArgs: { authorization: 'dummy-scope-a' } }),
    modelCallFingerprint({ toolArgs: { authorization: 'dummy-scope-b' } }),
  );

  const filePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-model-records-')), 'records.jsonl');
  const store = createJsonlModelRecordStore(filePath);
  const recorder = createModelRecorder({ store });
  const live = await recorder.wrap(async () => ({ content: `answer ${secretA}` }))(inputA);
  assert.match(String((live as { content?: unknown }).content), /sk-test-response-a/);
  const raw = fs.readFileSync(filePath, 'utf8');
  assert.equal(raw.includes(secretA), false, 'persisted response leaked a secret');
  await assert.rejects(
    () => createModelReplayer({ store }).wrap()(inputB),
    (error) => errorCode(error) === 'MODEL_REPLAY_MISS',
  );
});

test('JsonlModelRecordStore creates append files with private mode', async () => {
  const { createJsonlModelRecordStore } = await import('../src/runtime/model-recorder.js');
  const filePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-model-records-')), 'records.jsonl');
  const originalOpenSync = fs.openSync;
  const modes: number[] = [];
  fs.openSync = ((target: string, flags: string | number, mode?: number) => {
    if (path.resolve(target) === path.resolve(filePath) && mode !== undefined) modes.push(mode);
    return originalOpenSync(target, flags, mode);
  }) as typeof fs.openSync;
  try {
    createJsonlModelRecordStore(filePath).append({
      fingerprint: 'sha256:private',
      status: 'succeeded',
      response: { content: 'safe' },
    });
  } finally {
    fs.openSync = originalOpenSync;
  }
  assert.ok(modes.includes(0o600), 'record file must be opened with mode 0600');
});
