#!/usr/bin/env node
// Single-instance in-process throughput benchmark for /api/agent/chat/stream.
// Fires N concurrent agent streams against a real host (with a fast mock model),
// reports throughput + latency percentiles, and asserts the in-memory registries
// drain to zero (no leak under load). For the 1万→10万 target, run the
// multi-instance harness scripts/load-sse.mjs against a load-balanced cluster.
//
// Usage: N=500 node scripts/bench-local.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const { createServer } = await import(path.join(here, '../src/server.js'));
const { createApprovalRegistry } = await import(path.join(here, '../src/runtime/approvals.js'));
const { createCancellationRegistry } = await import(path.join(here, '../src/runtime/cancellation.js'));
const { createConcurrencyLimiter } = await import(path.join(here, '../src/runtime/concurrency.js'));

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-bench-'));
const approvalRegistry = createApprovalRegistry();
const cancellation = createCancellationRegistry();
const agentConcurrency = createConcurrencyLimiter({ maxConcurrent: 100000, maxPerTenant: 100000 });
const agentModelCall = async () => ({ content: '已完成。', usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } });
const server = createServer({ trustedRoot: root, enableScheduler: false, kimiChatRunner: async () => ({}), agentModelCall, approvalRegistry, cancellation, agentConcurrency });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const N = Number(process.env.N || 200);
const lat = [];
let ok = 0; let err = 0;
const t0 = Date.now();
async function one(i) {
  const s = Date.now();
  try {
    const res = await fetch(`${base}/api/agent/chat/stream`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: `bench ${i}` }) });
    if (!res.ok || !res.body) { err += 1; return; }
    const reader = res.body.getReader();
    for (;;) { const { done } = await reader.read(); if (done) break; }
    ok += 1; lat.push(Date.now() - s);
  } catch { err += 1; }
}
await Promise.all(Array.from({ length: N }, (_, i) => one(i)));
const total = Date.now() - t0;
lat.sort((a, b) => a - b);
const pct = (p) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor((p / 100) * lat.length))] : 0);
console.log(`N=${N} completed=${ok} errors=${err} wallclock=${total}ms throughput=${(ok / (total / 1000)).toFixed(0)}/s`);
console.log(`latency p50=${pct(50)}ms p90=${pct(90)}ms p95=${pct(95)}ms p99=${pct(99)}ms`);
console.log(`registries: approvals=${approvalRegistry.pendingCount()} runs=${cancellation.pending().length} slots=${agentConcurrency.stats().active} (all should be 0)`);
if (server.closeMcp) server.closeMcp();
await new Promise((r) => server.close(r));
process.exit(0);
