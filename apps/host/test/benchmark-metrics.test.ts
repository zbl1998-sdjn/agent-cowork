import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collectMeasuredSamples,
  createDeterministicAscii,
  evaluateBudget,
  parseBenchmarkConfig,
  summarizeSamples,
} from '../../../scripts/bench-metrics.js';
import { buildBenchmarkBudgetChecks } from '../../../scripts/bench-report.js';
import { summarizeRequestLatencies } from '../../../scripts/bench-workloads.js';

test('benchmark input generation is byte-exact and repeatable for a fixed seed', () => {
  const first = createDeterministicAscii(20_260_711, 8_192);
  const second = createDeterministicAscii(20_260_711, 8_192);
  const otherSeed = createDeterministicAscii(20_260_712, 8_192);

  assert.equal(Buffer.byteLength(first, 'utf8'), 8_192);
  assert.equal(second, first);
  assert.notEqual(otherSeed, first);
});

test('sample summaries expose deterministic nearest-rank p50/p95 and variability', () => {
  const summary = summarizeSamples([10, 40, 20, 30, 50]);

  assert.equal(summary.count, 5);
  assert.equal(summary.min, 10);
  assert.equal(summary.max, 50);
  assert.equal(summary.mean, 30);
  assert.equal(summary.p50, 30);
  assert.equal(summary.p95, 50);
  assert.ok(summary.cvPct > 47 && summary.cvPct < 48);
});

test('request latency percentiles pool every measured request instead of percentiles of batch percentiles', () => {
  const batches = [
    [...Array<number>(18).fill(10), 30, 30],
    ...Array.from({ length: 4 }, () => Array<number>(20).fill(10)),
  ];

  const pooled = summarizeRequestLatencies(batches);
  const batchP95OfP95 = summarizeSamples(
    batches.map((batch) => summarizeSamples(batch).p95),
  );

  assert.equal(pooled.count, 100);
  assert.equal(pooled.p50, 10);
  assert.equal(pooled.p95, 10);
  assert.ok(pooled.cvPct > 26 && pooled.cvPct < 27);
  assert.equal(batchP95OfP95.p95, 30);
  assert.notEqual(pooled.p95, batchP95OfP95.p95);

  const stable = summarizeSamples([10, 10, 10, 10, 10]);
  const checks = buildBenchmarkBudgetChecks(
    parseBenchmarkConfig({
      BENCH_SAMPLE_ROUNDS: '5',
      BENCH_TASK_COUNT: '20',
      BENCH_TASK_CONCURRENCY: '4',
      BENCH_TASK_P95_MS: '15',
      BENCH_FAIL_ON_REGRESSION: '1',
    }),
    {
      startupMs: stable,
      firstScreenFirstByteMs: stable,
      parallelRequestLatencyMs: pooled,
      parallelThroughputPerSecond: stable,
      parallelSpeedup: summarizeSamples([2, 2, 2, 2, 2]),
      memory: { rssMb: 100, heapUsedMb: 50 },
    },
  );
  const latencyCheck = checks.find(
    (item) => item.name === 'agentStream.parallel.requestLatency.p95Ms',
  );
  assert.ok(latencyCheck);
  assert.equal(latencyCheck.actual, 10);
  assert.equal(latencyCheck.sampleCvPct, pooled.cvPct);
  assert.equal(latencyCheck.status, 'pass');
});

test('warmups execute but are excluded from measured samples', async () => {
  const phases: string[] = [];
  const measured = await collectMeasuredSamples({
    warmupRounds: 2,
    sampleRounds: 5,
    run: async (phase, index) => {
      phases.push(`${phase}:${index}`);
      return phase === 'warmup' ? 1_000 + index : 10 + index;
    },
  });

  assert.deepEqual(phases, [
    'warmup:0',
    'warmup:1',
    'sample:0',
    'sample:1',
    'sample:2',
    'sample:3',
    'sample:4',
  ]);
  assert.deepEqual(measured, [10, 11, 12, 13, 14]);
});

test('regression budgets distinguish pass, warning, failure, and machine noise', () => {
  const stable = summarizeSamples([98, 99, 100, 101, 102]);
  const noisy = summarizeSamples([1, 2, 3, 100, 200]);

  assert.equal(evaluateBudget({
    name: 'latency.p95',
    actual: stable.p95,
    budget: 110,
    direction: 'max',
    samples: stable,
    maxCvPct: 20,
    failOnRegression: true,
  }).status, 'pass');
  assert.equal(evaluateBudget({
    name: 'latency.p95',
    actual: stable.p95,
    budget: 90,
    direction: 'max',
    samples: stable,
    maxCvPct: 20,
    failOnRegression: false,
  }).status, 'warn');
  assert.equal(evaluateBudget({
    name: 'latency.p95',
    actual: stable.p95,
    budget: 90,
    direction: 'max',
    samples: stable,
    maxCvPct: 20,
    failOnRegression: true,
  }).status, 'fail');
  assert.equal(evaluateBudget({
    name: 'throughput.p50',
    actual: noisy.p50,
    budget: 2,
    direction: 'min',
    samples: noisy,
    maxCvPct: 20,
    failOnRegression: true,
  }).status, 'inconclusive');
});

test('benchmark configuration fails explicitly on irreproducible inputs', () => {
  const config = parseBenchmarkConfig({
    BENCH_SEED: '20260711',
    BENCH_WARMUP_ROUNDS: '2',
    BENCH_SAMPLE_ROUNDS: '5',
    BENCH_TASK_COUNT: '12',
    BENCH_TASK_CONCURRENCY: '4',
    BENCH_PROMPT_BYTES: '8192',
  });

  assert.equal(config.seed, 20_260_711);
  assert.equal(config.sampleRounds, 5);
  assert.equal(config.taskConcurrency, 4);
  assert.throws(
    () => parseBenchmarkConfig({ BENCH_SAMPLE_ROUNDS: '4' }),
    /BENCH_SAMPLE_ROUNDS.*at least 5/,
  );
  assert.throws(
    () => parseBenchmarkConfig({ BENCH_TASK_COUNT: '3', BENCH_TASK_CONCURRENCY: '4' }),
    /BENCH_TASK_CONCURRENCY.*BENCH_TASK_COUNT/,
  );
  assert.throws(
    () => parseBenchmarkConfig({ BENCH_SEED: 'not-a-number' }),
    /BENCH_SEED.*integer/,
  );
});
