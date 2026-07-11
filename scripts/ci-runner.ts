// CI 有界并行调度器:仅并行同一连续分组,组内完成后聚合失败并阻断后续步骤。
// ---------------------------------------------------------------------------
// 职责:提供纯调度逻辑；具体子进程、日志和环境变量仍由 ci.ts 负责。
// 依赖:ci-gates 的步骤描述。默认并发为 2，可用 KCW_CI_CONCURRENCY 调整到 1..4。

import type { CiStep } from './ci-gates.js';

export type StepResult = {
  code: number;
  signal: string | null;
  error?: string;
};

type FailedStep = {
  step: CiStep;
  result: StepResult;
};

export class CiStepFailure extends Error {
  readonly failures: readonly FailedStep[];
  readonly exitCode: number;

  constructor(failures: readonly FailedStep[]) {
    const details = failures
      .map(({ step, result }) => `${step.name} (exit ${result.code}${result.error ? `: ${result.error}` : ''})`)
      .join(', ');
    super(`CI step group failed: ${details}`);
    this.name = 'CiStepFailure';
    this.failures = failures;
    this.exitCode = failures.find(({ result }) => result.code !== 0)?.result.code || 1;
  }
}

export function ciConcurrency(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const variable = 'KCW_CI_CONCURRENCY';
  const raw = (env[variable] ?? '2').trim();
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 4) {
    throw new Error(`${variable} must be an integer between 1 and 4; observed ${JSON.stringify(raw)}`);
  }
  return parsed;
}

async function runBoundedGroup(
  steps: readonly CiStep[],
  concurrency: number,
  runStep: (step: CiStep) => Promise<StepResult>,
): Promise<StepResult[]> {
  const results = new Array<StepResult>(steps.length);
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    while (nextIndex < steps.length) {
      const index = nextIndex;
      nextIndex += 1;
      const current = steps[index];
      if (!current) continue;
      try {
        results[index] = await runStep(current);
      } catch (error) {
        results[index] = {
          code: 1,
          signal: null,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
  };

  const workerCount = Math.min(concurrency, steps.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

export async function runCiSteps(
  steps: readonly CiStep[],
  {
    concurrency = ciConcurrency(),
    runStep,
  }: {
    concurrency?: number;
    runStep: (step: CiStep) => Promise<StepResult>;
  },
): Promise<void> {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) {
    throw new Error(`CI concurrency must be an integer between 1 and 4; observed ${concurrency}`);
  }

  let index = 0;
  while (index < steps.length) {
    const current = steps[index];
    if (!current) break;
    let groupEnd = index + 1;
    if (current.parallelGroup) {
      while (groupEnd < steps.length && steps[groupEnd]?.parallelGroup === current.parallelGroup) {
        groupEnd += 1;
      }
    }

    const group = steps.slice(index, groupEnd);
    const results = await runBoundedGroup(
      group,
      current.parallelGroup ? concurrency : 1,
      runStep,
    );
    const failures = group.flatMap((step, resultIndex) => {
      const result = results[resultIndex];
      return result && result.code !== 0 ? [{ step, result }] : [];
    });
    if (failures.length > 0) throw new CiStepFailure(failures);
    index = groupEnd;
  }
}
