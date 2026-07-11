#!/usr/bin/env node
// 可重复离线性能基准:多轮测量 Host 启动、HTTP 首屏和真实 Agent SSE 路由。
// 模型响应在装配边界注入;状态后端强制 file;HTTP 只允许 127.0.0.1。
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import {
  collectMeasuredSamples,
  parseBenchmarkConfig,
  summarizeSamples,
  type BenchmarkConfig,
  type SampleSummary,
} from './bench-metrics.js';
import {
  buildBenchmarkBudgetChecks,
  overallBenchmarkStatus,
} from './bench-report.js';
import {
  closeOfflineBenchmarkServer,
  startOfflineBenchmarkServer,
  type OfflineServerContext,
} from './bench-server.js';
import { runAgentWorkload } from './bench-workloads.js';
import {
  createBenchmarkWorkspace,
  removeBenchmarkWorkspace,
} from './bench-workspace.js';

type FetchResult = { status: number; firstByteMs: number; totalMs: number; bytes: number };
type FetchSummary = {
  status: number;
  firstByteMs: SampleSummary;
  totalMs: SampleSummary;
  bytes: SampleSummary;
};
type MemoryMetrics = { rssMb: number; heapUsedMb: number; heapTotalMb: number; externalMb: number };

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const reportRoot = path.resolve(process.env.BENCH_REPORT_DIR || path.join(repoRoot, 'reports', 'bench'));

function nowStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function fetchMeasured(url: string): Promise<FetchResult> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1') {
    throw new Error(`benchmark fetch must stay on loopback, received ${parsed.origin}`);
  }
  const started = performance.now();
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  const firstByteMs = performance.now() - started;
  const body = await response.text();
  if (response.status !== 200) throw new Error(`benchmark fetch ${parsed.pathname} returned ${response.status}`);
  return {
    status: response.status,
    firstByteMs,
    totalMs: performance.now() - started,
    bytes: Buffer.byteLength(body),
  };
}

async function collectFetchSummary(url: string, config: BenchmarkConfig): Promise<FetchSummary> {
  const measured: FetchResult[] = [];
  await collectMeasuredSamples({
    warmupRounds: config.warmupRounds,
    sampleRounds: config.sampleRounds,
    run: async (phase) => {
      const result = await fetchMeasured(url);
      if (phase === 'sample') measured.push(result);
      return result.firstByteMs;
    },
  });
  const first = measured[0];
  if (!first) throw new Error('benchmark fetch produced no measured samples');
  return {
    status: first.status,
    firstByteMs: summarizeSamples(measured.map((result) => result.firstByteMs)),
    totalMs: summarizeSamples(measured.map((result) => result.totalMs)),
    bytes: summarizeSamples(measured.map((result) => result.bytes)),
  };
}

async function collectStartupSummary(workspaceRoot: string, config: BenchmarkConfig): Promise<SampleSummary> {
  const samples = await collectMeasuredSamples({
    warmupRounds: config.warmupRounds,
    sampleRounds: config.sampleRounds,
    run: async (phase, index) => {
      const context = await startOfflineBenchmarkServer(
        path.join(workspaceRoot, `startup-${phase}-${index}`),
        config,
      );
      try {
        return context.startupMs;
      } finally {
        await closeOfflineBenchmarkServer(context);
      }
    },
  });
  return summarizeSamples(samples);
}

function memorySnapshot(): MemoryMetrics {
  const memory = process.memoryUsage();
  const mb = (value: number): number => Math.round((value / 1024 / 1024) * 10) / 10;
  return {
    rssMb: mb(memory.rss),
    heapUsedMb: mb(memory.heapUsed),
    heapTotalMb: mb(memory.heapTotal),
    externalMb: mb(memory.external),
  };
}

async function main(): Promise<void> {
  const config = parseBenchmarkConfig();
  fs.mkdirSync(reportRoot, { recursive: true });
  const reportPath = path.join(reportRoot, `bench-${nowStamp()}.json`);
  const workspace = createBenchmarkWorkspace(process.env.BENCH_WORKSPACE);
  try {
    const startupMs = await collectStartupSummary(workspace.root, config);
    const context: OfflineServerContext = await startOfflineBenchmarkServer(
      path.join(workspace.root, 'workload'),
      config,
    );
    try {
      const health = await collectFetchSummary(`${context.baseUrl}/health`, config);
      const firstScreen = await collectFetchSummary(`${context.baseUrl}/`, config);
      const agentStream = await runAgentWorkload(context, config);
      const expectedModelCalls = (config.warmupRounds + config.sampleRounds) * config.taskCount * 2;
      if (agentStream.injectedModelCalls !== expectedModelCalls) {
        throw new Error(`injected model call count ${agentStream.injectedModelCalls} != ${expectedModelCalls}`);
      }
      const memory = memorySnapshot();
      const budgetChecks = buildBenchmarkBudgetChecks(config, {
        startupMs,
        firstScreenFirstByteMs: firstScreen.firstByteMs,
        parallelRequestLatencyMs: agentStream.parallel.requestLatencyMs,
        parallelThroughputPerSecond: agentStream.parallel.throughputPerSecond,
        parallelSpeedup: agentStream.parallelSpeedup,
        memory,
      });
      const status = overallBenchmarkStatus(budgetChecks);
      const inconclusive = budgetChecks.filter((item) => item.status === 'inconclusive');
      const failed = budgetChecks.filter((item) => item.status === 'fail');
      const blocking = failed.length > 0 || (config.failOnRegression && inconclusive.length > 0);
      const report = {
        schemaVersion: 2,
        ok: !blocking,
        baselineUsable: status === 'pass',
        status,
        generatedAt: new Date().toISOString(),
        mode: 'local-offline-deterministic',
        boundary: {
          externalNetwork: false,
          loopbackHttpOnly: true,
          realModel: false,
          database: false,
          production: false,
          details: 'Injected model; outbound fetch rejects; file state backend; memory paused.',
        },
        sampling: {
          seed: config.seed,
          warmupRounds: config.warmupRounds,
          sampleRounds: config.sampleRounds,
          percentile: 'nearest-rank',
          maxCvPct: config.maxCvPct,
        },
        workload: {
          taskCount: config.taskCount,
          concurrency: config.taskConcurrency,
          promptBytes: config.promptBytes,
          promptSha256: agentStream.promptSha256,
          mockModelDelayMs: config.mockModelDelayMs,
        },
        machine: {
          platform: process.platform,
          arch: process.arch,
          node: process.version,
        },
        metrics: { startupMs, health, firstScreen, agentStream, memory },
        budgets: config.budgets,
        failOnRegression: config.failOnRegression,
        budgetChecks,
      };
      fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
      console.log(JSON.stringify({
        ok: report.ok,
        baselineUsable: report.baselineUsable,
        status,
        reportPath,
        startupP95Ms: startupMs.p95,
        firstScreenP95Ms: firstScreen.firstByteMs.p95,
        agentP95Ms: agentStream.parallel.requestLatencyMs.p95,
        parallelThroughputP50: agentStream.parallel.throughputPerSecond.p50,
        parallelSpeedupP50: agentStream.parallelSpeedup.p50,
        budgetChecks,
      }, null, 2));
      if (blocking) process.exitCode = 1;
    } finally {
      await closeOfflineBenchmarkServer(context);
    }
  } finally {
    removeBenchmarkWorkspace(workspace);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.stack || error.message : String(error);
}

main().catch((error: unknown) => {
  fs.mkdirSync(reportRoot, { recursive: true });
  const reportPath = path.join(reportRoot, `bench-${nowStamp()}-failed.json`);
  fs.writeFileSync(
    reportPath,
    `${JSON.stringify({ schemaVersion: 2, ok: false, generatedAt: new Date().toISOString(), error: errorMessage(error) }, null, 2)}\n`,
    'utf8',
  );
  console.error(errorMessage(error));
  process.exitCode = 1;
});
