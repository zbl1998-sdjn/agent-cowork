import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import {
  collectMeasuredSamples,
  createDeterministicAscii,
  summarizeSamples,
  type BenchmarkConfig,
  type BenchmarkPhase,
  type SampleSummary,
} from './bench-metrics.js';
import type { OfflineServerContext } from './bench-server.js';

type BatchResult = {
  elapsedMs: number;
  throughputPerSecond: number;
  requestLatencyMs: number[];
  responseBytes: number;
};

type BatchSummary = {
  elapsedMs: SampleSummary;
  throughputPerSecond: SampleSummary;
  requestLatencyMs: SampleSummary;
  requestLatencyP95Ms: SampleSummary;
  responseBytes: number;
  completedTasks: number;
};

export type AgentWorkloadResult = {
  promptSha256: string;
  sequential: BatchSummary;
  parallel: BatchSummary;
  parallelSpeedup: SampleSummary;
  registries: { approvals: number; cancellations: number; concurrencySlots: number };
  injectedModelCalls: number;
};

export function summarizeRequestLatencies(
  batches: readonly (readonly number[])[],
): SampleSummary {
  return summarizeSamples(batches.flatMap((batch) => batch));
}

function ensureLoopback(url: string): void {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1') {
    throw new Error(`benchmark request must stay on loopback, received ${parsed.origin}`);
  }
}

function promptsFor(config: BenchmarkConfig): string[] {
  return Array.from({ length: config.taskCount }, (_, index) => {
    const prefix = `benchmark-task-${index}:`;
    const taskSeed = ((config.seed + index) >>> 0) || 1;
    return prefix + createDeterministicAscii(taskSeed, config.promptBytes - prefix.length);
  });
}

async function runBatch(
  baseUrl: string,
  prompts: readonly string[],
  concurrency: number,
  label: string,
): Promise<BatchResult> {
  ensureLoopback(baseUrl);
  const latencies = new Array<number>(prompts.length);
  const errors: string[] = [];
  let next = 0;
  let responseBytes = 0;
  const started = performance.now();
  const worker = async (): Promise<void> => {
    while (next < prompts.length) {
      const index = next;
      next += 1;
      const taskStarted = performance.now();
      try {
        const response = await fetch(`${baseUrl}/api/agent/chat/stream`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ prompt: prompts[index], conversationId: `${label}-${index}`, maxSteps: 1 }),
          signal: AbortSignal.timeout(30_000),
        });
        const body = await response.text();
        if (!response.ok || !body.includes('event: done') || body.includes('event: error')) {
          throw new Error(`status=${response.status} complete=${body.includes('event: done')}`);
        }
        latencies[index] = performance.now() - taskStarted;
        responseBytes += Buffer.byteLength(body);
      } catch (error) {
        errors.push(`task ${index}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  const elapsedMs = performance.now() - started;
  if (errors.length > 0) throw new Error(`agent workload failed: ${errors.slice(0, 3).join('; ')}`);
  return {
    elapsedMs,
    throughputPerSecond: prompts.length / Math.max(elapsedMs / 1_000, 0.001),
    requestLatencyMs: latencies,
    responseBytes,
  };
}

function summarizeBatches(results: readonly BatchResult[], taskCount: number): BatchSummary {
  return {
    elapsedMs: summarizeSamples(results.map((result) => result.elapsedMs)),
    throughputPerSecond: summarizeSamples(results.map((result) => result.throughputPerSecond)),
    requestLatencyMs: summarizeRequestLatencies(
      results.map((result) => result.requestLatencyMs),
    ),
    requestLatencyP95Ms: summarizeSamples(
      results.map((result) => summarizeSamples(result.requestLatencyMs).p95),
    ),
    responseBytes: results.reduce((total, result) => total + result.responseBytes, 0),
    completedTasks: results.length * taskCount,
  };
}

async function collectBatches(
  context: OfflineServerContext,
  config: BenchmarkConfig,
  prompts: readonly string[],
  concurrency: number,
  mode: string,
): Promise<BatchResult[]> {
  const measured: BatchResult[] = [];
  await collectMeasuredSamples({
    warmupRounds: config.warmupRounds,
    sampleRounds: config.sampleRounds,
    run: async (phase: BenchmarkPhase, index: number) => {
      const result = await runBatch(context.baseUrl, prompts, concurrency, `${mode}-${phase}-${index}`);
      if (phase === 'sample') measured.push(result);
      return result.elapsedMs;
    },
  });
  return measured;
}

export async function runAgentWorkload(
  context: OfflineServerContext,
  config: BenchmarkConfig,
): Promise<AgentWorkloadResult> {
  const prompts = promptsFor(config);
  const sequential = await collectBatches(context, config, prompts, 1, 'sequential');
  const parallel = await collectBatches(context, config, prompts, config.taskConcurrency, 'parallel');
  const registries = {
    approvals: context.approvals.pendingCount(),
    cancellations: context.cancellation.pending().length,
    concurrencySlots: context.concurrency.stats().active,
  };
  if (Object.values(registries).some((count) => count !== 0)) {
    throw new Error(`benchmark registries did not drain: ${JSON.stringify(registries)}`);
  }
  return {
    promptSha256: crypto.createHash('sha256').update(prompts.join('\n')).digest('hex'),
    sequential: summarizeBatches(sequential, config.taskCount),
    parallel: summarizeBatches(parallel, config.taskCount),
    parallelSpeedup: summarizeSamples(sequential.map((result, index) => {
      const parallelResult = parallel[index];
      if (!parallelResult) throw new Error(`missing parallel sample ${index}`);
      return result.elapsedMs / parallelResult.elapsedMs;
    })),
    registries,
    injectedModelCalls: context.modelCallCount(),
  };
}
