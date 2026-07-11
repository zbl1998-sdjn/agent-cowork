import {
  evaluateBudget,
  summarizeSamples,
  type BenchmarkConfig,
  type BudgetCheck,
  type BudgetStatus,
  type SampleSummary,
} from './bench-metrics.js';

export type BenchmarkBudgetInputs = {
  startupMs: SampleSummary;
  firstScreenFirstByteMs: SampleSummary;
  parallelRequestLatencyMs: SampleSummary;
  parallelThroughputPerSecond: SampleSummary;
  parallelSpeedup: SampleSummary;
  memory: { rssMb: number; heapUsedMb: number };
};

function check(
  config: BenchmarkConfig,
  name: string,
  actual: number,
  budget: number,
  direction: 'max' | 'min',
  samples: SampleSummary,
): BudgetCheck {
  return evaluateBudget({
    name,
    actual,
    budget,
    direction,
    samples,
    maxCvPct: config.maxCvPct,
    failOnRegression: config.failOnRegression,
  });
}

export function buildBenchmarkBudgetChecks(
  config: BenchmarkConfig,
  inputs: BenchmarkBudgetInputs,
): BudgetCheck[] {
  const {
    startupMs,
    firstScreenFirstByteMs,
    parallelRequestLatencyMs,
    parallelThroughputPerSecond,
    parallelSpeedup,
    memory,
  } = inputs;
  return [
    check(config, 'startup.p95Ms', startupMs.p95, config.budgets.startupP95Ms, 'max', startupMs),
    check(
      config,
      'firstScreen.firstByte.p95Ms',
      firstScreenFirstByteMs.p95,
      config.budgets.firstScreenP95Ms,
      'max',
      firstScreenFirstByteMs,
    ),
    check(
      config,
      'agentStream.parallel.requestLatency.p95Ms',
      parallelRequestLatencyMs.p95,
      config.budgets.taskP95Ms,
      'max',
      parallelRequestLatencyMs,
    ),
    check(
      config,
      'agentStream.parallel.throughput.p50',
      parallelThroughputPerSecond.p50,
      config.budgets.taskMinThroughput,
      'min',
      parallelThroughputPerSecond,
    ),
    check(
      config,
      'agentStream.parallel.speedup.p50',
      parallelSpeedup.p50,
      config.budgets.taskMinSpeedup,
      'min',
      parallelSpeedup,
    ),
    check(
      config,
      'memory.rssMb',
      memory.rssMb,
      config.budgets.rssMb,
      'max',
      summarizeSamples([memory.rssMb]),
    ),
    check(
      config,
      'memory.heapUsedMb',
      memory.heapUsedMb,
      config.budgets.heapUsedMb,
      'max',
      summarizeSamples([memory.heapUsedMb]),
    ),
  ];
}

export function overallBenchmarkStatus(checks: readonly BudgetCheck[]): BudgetStatus {
  if (checks.some((item) => item.status === 'fail')) return 'fail';
  if (checks.some((item) => item.status === 'inconclusive')) return 'inconclusive';
  if (checks.some((item) => item.status === 'warn')) return 'warn';
  return 'pass';
}
