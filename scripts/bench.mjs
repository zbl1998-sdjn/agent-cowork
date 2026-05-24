import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { createServer } from '../apps/host/src/server.js';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const reportRoot = path.resolve(process.env.BENCH_REPORT_DIR || path.join(repoRoot, 'reports', 'bench'));
const workspaceRoot = path.resolve(process.env.BENCH_WORKSPACE || path.join(reportRoot, 'workspace'));
const failOnRegression = process.env.BENCH_FAIL_ON_REGRESSION === '1';

const thresholds = {
  startupMs: numberEnv('BENCH_STARTUP_MS', 2500),
  firstScreenMs: numberEnv('BENCH_FIRST_SCREEN_MS', 3000),
  frameProcessingMs: numberEnv('BENCH_FRAME_PROCESSING_MS', 500),
  rssMb: numberEnv('BENCH_RSS_MB', 512),
  heapUsedMb: numberEnv('BENCH_HEAP_USED_MB', 192),
};

function numberEnv(name, fallback) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function bindMeasured(server) {
  const started = performance.now();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    startupMs: performance.now() - started,
  };
}

async function fetchMeasured(url) {
  const started = performance.now();
  const response = await fetch(url);
  const firstByteMs = performance.now() - started;
  const text = await response.text();
  return { status: response.status, firstByteMs, totalMs: performance.now() - started, bytes: Buffer.byteLength(text) };
}

function syntheticSseFrameBenchmark(frameCount = 2000) {
  const frames = [];
  for (let index = 0; index < frameCount; index += 1) {
    frames.push(`event: token\ndata: {"delta":"${index % 10}"}\n\n`);
  }
  const payload = frames.join('');
  const started = performance.now();
  let parsed = 0;
  for (const raw of payload.split(/\n\n/)) {
    if (!raw) continue;
    if (raw.includes('event: token') && raw.includes('data:')) parsed += 1;
  }
  const elapsedMs = performance.now() - started;
  return {
    frameCount,
    parsed,
    elapsedMs,
    framesPerSecond: Math.round((parsed / Math.max(elapsedMs, 0.001)) * 1000),
  };
}

function memorySnapshot() {
  const memory = process.memoryUsage();
  return {
    rssMb: Math.round((memory.rss / 1024 / 1024) * 10) / 10,
    heapUsedMb: Math.round((memory.heapUsed / 1024 / 1024) * 10) / 10,
    heapTotalMb: Math.round((memory.heapTotal / 1024 / 1024) * 10) / 10,
    externalMb: Math.round((memory.external / 1024 / 1024) * 10) / 10,
  };
}

function evaluateThresholds(metrics) {
  const checks = [
    { name: 'startupMs', actual: metrics.startupMs, threshold: thresholds.startupMs },
    { name: 'firstScreenMs', actual: metrics.firstScreen.firstByteMs, threshold: thresholds.firstScreenMs },
    { name: 'frameProcessingMs', actual: metrics.streamingFrames.elapsedMs, threshold: thresholds.frameProcessingMs },
    { name: 'rssMb', actual: metrics.memory.rssMb, threshold: thresholds.rssMb },
    { name: 'heapUsedMb', actual: metrics.memory.heapUsedMb, threshold: thresholds.heapUsedMb },
  ];
  return checks.map((check) => ({
    ...check,
    status: check.actual <= check.threshold ? 'pass' : failOnRegression ? 'fail' : 'warn',
  }));
}

async function main() {
  fs.mkdirSync(reportRoot, { recursive: true });
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.writeFileSync(path.join(workspaceRoot, 'bench-fixture.txt'), 'bench fixture', 'utf8');

  const server = createServer({
    trustedRoot: workspaceRoot,
    requireAuth: false,
    enableScheduler: false,
  });

  const reportPath = path.join(reportRoot, `bench-${nowStamp()}.json`);
  try {
    const { baseUrl, startupMs } = await bindMeasured(server);
    const health = await fetchMeasured(`${baseUrl}/health`);
    const firstScreen = await fetchMeasured(`${baseUrl}/`);
    const streamingFrames = syntheticSseFrameBenchmark(Number(process.env.BENCH_FRAME_COUNT || 2000));
    const memory = memorySnapshot();
    const metrics = { startupMs, health, firstScreen, streamingFrames, memory };
    const thresholdChecks = evaluateThresholds(metrics);
    const failed = thresholdChecks.filter((check) => check.status === 'fail');
    const warned = thresholdChecks.filter((check) => check.status === 'warn');
    const report = {
      ok: failed.length === 0,
      generatedAt: new Date().toISOString(),
      mode: 'local-offline',
      workspace: workspaceRoot,
      baseUrl,
      metrics,
      thresholds,
      failOnRegression,
      thresholdChecks,
    };
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({ ok: report.ok, reportPath, metrics, warned, failed }, null, 2));
    if (failed.length) process.exit(1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => {
  fs.mkdirSync(reportRoot, { recursive: true });
  const reportPath = path.join(reportRoot, `bench-${nowStamp()}-failed.json`);
  fs.writeFileSync(
    reportPath,
    `${JSON.stringify({ ok: false, generatedAt: new Date().toISOString(), error: error.stack || error.message }, null, 2)}\n`,
    'utf8',
  );
  console.error(error.stack || error.message);
  process.exit(1);
});
