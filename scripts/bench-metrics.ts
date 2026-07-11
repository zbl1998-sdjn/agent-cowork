export type BenchmarkPhase = 'warmup' | 'sample';
export type BudgetDirection = 'max' | 'min';
export type BudgetStatus = 'pass' | 'warn' | 'fail' | 'inconclusive';

export interface SampleSummary {
  count: number;
  min: number;
  max: number;
  mean: number;
  p50: number;
  p95: number;
  cvPct: number;
}

export interface BenchmarkConfig {
  seed: number;
  warmupRounds: number;
  sampleRounds: number;
  taskCount: number;
  taskConcurrency: number;
  promptBytes: number;
  mockModelDelayMs: number;
  maxCvPct: number;
  failOnRegression: boolean;
  budgets: {
    startupP95Ms: number;
    firstScreenP95Ms: number;
    taskP95Ms: number;
    taskMinThroughput: number;
    taskMinSpeedup: number;
    rssMb: number;
    heapUsedMb: number;
  };
}

export interface BudgetCheck {
  name: string;
  actual: number;
  budget: number;
  direction: BudgetDirection;
  sampleCvPct: number;
  maxCvPct: number;
  status: BudgetStatus;
}

type EnvLike = Readonly<Record<string, string | undefined>>;

function parseNumber(
  env: EnvLike,
  name: string,
  fallback: number,
  options: { integer?: boolean; min: number; max: number },
): number {
  const raw = env[name];
  const value = raw === undefined ? fallback : Number(raw);
  const kind = options.integer ? 'integer' : 'number';
  if (!Number.isFinite(value) || (options.integer && !Number.isSafeInteger(value))) {
    throw new Error(`${name} must be a finite ${kind}`);
  }
  if (value < options.min || value > options.max) {
    throw new Error(`${name} must be between ${options.min} and ${options.max}`);
  }
  return value;
}

export function parseBenchmarkConfig(env: EnvLike = process.env): BenchmarkConfig {
  const warmupRounds = parseNumber(env, 'BENCH_WARMUP_ROUNDS', 2, {
    integer: true,
    min: 1,
    max: 20,
  });
  const sampleRounds = parseNumber(env, 'BENCH_SAMPLE_ROUNDS', 7, {
    integer: true,
    min: 0,
    max: 100,
  });
  const taskCount = parseNumber(env, 'BENCH_TASK_COUNT', 12, {
    integer: true,
    min: 2,
    max: 500,
  });
  const taskConcurrency = parseNumber(env, 'BENCH_TASK_CONCURRENCY', 4, {
    integer: true,
    min: 2,
    max: 64,
  });
  if (taskConcurrency > taskCount) {
    throw new Error('BENCH_TASK_CONCURRENCY must not exceed BENCH_TASK_COUNT');
  }
  if (sampleRounds < 5) {
    throw new Error('BENCH_SAMPLE_ROUNDS must be at least 5');
  }

  return {
    seed: parseNumber(env, 'BENCH_SEED', 20_260_711, {
      integer: true,
      min: 1,
      max: 0xffff_ffff,
    }),
    warmupRounds,
    sampleRounds,
    taskCount,
    taskConcurrency,
    promptBytes: parseNumber(env, 'BENCH_PROMPT_BYTES', 8_192, {
      integer: true,
      min: 1_024,
      max: 262_144,
    }),
    mockModelDelayMs: parseNumber(env, 'BENCH_MOCK_MODEL_DELAY_MS', 8, {
      integer: true,
      min: 1,
      max: 1_000,
    }),
    maxCvPct: parseNumber(env, 'BENCH_MAX_CV_PCT', 35, { min: 1, max: 200 }),
    failOnRegression: env.BENCH_FAIL_ON_REGRESSION === '1',
    budgets: {
      startupP95Ms: parseNumber(env, 'BENCH_STARTUP_MS', 2_500, { min: 1, max: 60_000 }),
      firstScreenP95Ms: parseNumber(env, 'BENCH_FIRST_SCREEN_MS', 3_000, { min: 1, max: 60_000 }),
      taskP95Ms: parseNumber(env, 'BENCH_TASK_P95_MS', 2_000, { min: 1, max: 60_000 }),
      taskMinThroughput: parseNumber(env, 'BENCH_TASK_MIN_THROUGHPUT', 5, { min: 0.01, max: 10_000 }),
      taskMinSpeedup: parseNumber(env, 'BENCH_TASK_MIN_SPEEDUP', 1.2, { min: 0.01, max: 64 }),
      rssMb: parseNumber(env, 'BENCH_RSS_MB', 512, { min: 1, max: 65_536 }),
      heapUsedMb: parseNumber(env, 'BENCH_HEAP_USED_MB', 192, { min: 1, max: 65_536 }),
    },
  };
}

export function createDeterministicAscii(seed: number, bytes: number): string {
  if (!Number.isSafeInteger(seed) || seed < 1 || seed > 0xffff_ffff) {
    throw new Error('seed must be an integer between 1 and 4294967295');
  }
  if (!Number.isSafeInteger(bytes) || bytes < 1) {
    throw new Error('bytes must be a positive integer');
  }
  let state = seed >>> 0;
  const output = new Array<string>(bytes);
  for (let index = 0; index < bytes; index += 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    output[index] = String.fromCharCode(32 + (state % 95));
  }
  return output.join('');
}

function percentile(sorted: readonly number[], percentileValue: number): number {
  const rank = Math.max(0, Math.ceil((percentileValue / 100) * sorted.length) - 1);
  const value = sorted[rank];
  if (value === undefined) throw new Error('percentile requires at least one sample');
  return value;
}

export function summarizeSamples(samples: readonly number[]): SampleSummary {
  if (samples.length === 0 || samples.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error('samples must contain finite non-negative numbers');
  }
  const sorted = [...samples].sort((left, right) => left - right);
  const sum = sorted.reduce((total, value) => total + value, 0);
  const mean = sum / sorted.length;
  const variance = sorted.reduce((total, value) => total + ((value - mean) ** 2), 0) / sorted.length;
  return {
    count: sorted.length,
    min: sorted[0] ?? 0,
    max: sorted.at(-1) ?? 0,
    mean,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    cvPct: mean === 0 ? 0 : (Math.sqrt(variance) / mean) * 100,
  };
}

export async function collectMeasuredSamples(options: {
  warmupRounds: number;
  sampleRounds: number;
  run: (phase: BenchmarkPhase, index: number) => Promise<number>;
}): Promise<number[]> {
  const { warmupRounds, sampleRounds, run } = options;
  if (!Number.isSafeInteger(warmupRounds) || warmupRounds < 0) {
    throw new Error('warmupRounds must be a non-negative integer');
  }
  if (!Number.isSafeInteger(sampleRounds) || sampleRounds < 1) {
    throw new Error('sampleRounds must be a positive integer');
  }
  for (let index = 0; index < warmupRounds; index += 1) await run('warmup', index);
  const samples: number[] = [];
  for (let index = 0; index < sampleRounds; index += 1) {
    samples.push(await run('sample', index));
  }
  return samples;
}

export function evaluateBudget(options: {
  name: string;
  actual: number;
  budget: number;
  direction: BudgetDirection;
  samples: SampleSummary;
  maxCvPct: number;
  failOnRegression: boolean;
}): BudgetCheck {
  const { name, actual, budget, direction, samples, maxCvPct, failOnRegression } = options;
  const regressed = direction === 'max' ? actual > budget : actual < budget;
  let status: BudgetStatus = 'pass';
  if (samples.cvPct > maxCvPct) status = 'inconclusive';
  else if (regressed) status = failOnRegression ? 'fail' : 'warn';
  return { name, actual, budget, direction, sampleCvPct: samples.cvPct, maxCvPct, status };
}
