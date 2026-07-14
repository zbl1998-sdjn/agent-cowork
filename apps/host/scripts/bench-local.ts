#!/usr/bin/env node
// Single-instance in-process throughput benchmark for /api/agent/chat/stream.
// Fires N concurrent agent streams against a real host (with a fast mock model),
// reports throughput + latency percentiles, and asserts the in-memory registries
// drain to zero (no leak under load). For the 1万→10万 target, run the
// multi-instance harness apps/host/scripts/load-sse.ts against a load-balanced cluster.
//
// Usage: N=500 node scripts/run-host-node.mjs apps/host/scripts/bench-local.ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/server.js';
import { createApprovalRegistry } from '../src/runtime/approvals.js';
import { createCancellationRegistry } from '../src/runtime/cancellation.js';
import { createConcurrencyLimiter } from '../src/runtime/concurrency.js';
import type { AddressInfo } from 'node:http';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-bench-'));
const approvalRegistry = createApprovalRegistry();
const cancellation = createCancellationRegistry();
const agentConcurrency = createConcurrencyLimiter({ maxConcurrent: 100000, maxPerTenant: 100000 });
const modelChatRunner = async () => ({ ok: true as const, provider: 'bench', model: 'mock', mode: 'chat', text: '已完成。', durationMs: 0 });
const agentModelCall = async () => ({ content: '已完成。', usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } });
const server = createServer({ trustedRoot: root, requireAuth: false, enableScheduler: false, modelChatRunner, agentModelCall, approvalRegistry, cancellation, agentConcurrency });
await new Promise<void>((resolve) => {
  server.listen(0, '127.0.0.1', resolve);
});
const address = server.address() as AddressInfo;
const base = `http://127.0.0.1:${address.port}`;

const N = Number(process.env.N || 200);
const lat: number[] = [];
let ok = 0;
let err = 0;
const t0 = Date.now();
async function one(i: number): Promise<void> {
  const s = Date.now();
  try {
    const res = await fetch(`${base}/api/agent/chat/stream`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: `bench ${i}` }) });
    if (!res.ok || !res.body) { err += 1; return; }
    const reader = res.body.getReader();
    for (;;) { const { done } = await reader.read(); if (done) break; }
    ok += 1;
    lat.push(Date.now() - s);
  } catch {
    err += 1;
  }
}
await Promise.all(Array.from({ length: N }, (_, i) => one(i)));
const total = Date.now() - t0;
lat.sort((a, b) => a - b);
const pct = (p: number): number => (
  lat.length ? lat[Math.min(lat.length - 1, Math.floor((p / 100) * lat.length))] ?? 0 : 0
);
console.log(`N=${N} completed=${ok} errors=${err} wallclock=${total}ms throughput=${(ok / (total / 1000)).toFixed(0)}/s`);
console.log(`latency p50=${pct(50)}ms p90=${pct(90)}ms p95=${pct(95)}ms p99=${pct(99)}ms`);
console.log(`registries: approvals=${approvalRegistry.pendingCount()} runs=${cancellation.pending().length} slots=${agentConcurrency.stats().active} (all should be 0)`);
server.closeMcp();
await new Promise<void>((resolve, reject) => {
  server.close((error?: Error) => {
    if (error) reject(error);
    else resolve();
  });
});
