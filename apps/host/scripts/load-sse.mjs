#!/usr/bin/env node
// SSE load harness for /api/agent/chat/stream — for benchmarking a REAL cluster
// (not the CI sandbox). Ramps concurrent streams and reports throughput, latency
// percentiles, and error rate. Pair with a load balancer + multiple host
// instances to validate the 1万→10万 concurrency targets in docs/01-scalability.
//
// Usage:
//   BASE=http://lb.internal:3001 CONCURRENCY=2000 DURATION_S=60 \
//   TOKEN=<jwt> node scripts/load-sse.mjs
import { setTimeout as sleep } from 'node:timers/promises';

const BASE = process.env.BASE || 'http://127.0.0.1:3001';
const CONCURRENCY = Number(process.env.CONCURRENCY || 100);
const DURATION_S = Number(process.env.DURATION_S || 30);
const PROMPT = process.env.PROMPT || '总结一下工作区里的文件';
const TOKEN = process.env.TOKEN || '';

const lat = [];
let ok = 0; let err = 0; let inflight = 0; let done = false;

function pct(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

async function oneStream() {
  const started = Date.now();
  inflight += 1;
  try {
    const headers = { 'content-type': 'application/json' };
    if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;
    const res = await fetch(`${BASE}/api/agent/chat/stream`, { method: 'POST', headers, body: JSON.stringify({ prompt: PROMPT }) });
    if (!res.ok || !res.body) { err += 1; return; }
    const reader = res.body.getReader();
    for (;;) { const { done: d } = await reader.read(); if (d) break; }
    ok += 1;
    lat.push(Date.now() - started);
  } catch { err += 1; } finally { inflight -= 1; }
}

async function worker() {
  while (!done) { await oneStream(); }
}

async function main() {
  console.log(`load: ${CONCURRENCY} concurrent, ${DURATION_S}s -> ${BASE}`);
  const workers = Array.from({ length: CONCURRENCY }, () => worker());
  const deadline = Date.now() + DURATION_S * 1000;
  while (Date.now() < deadline) {
    await sleep(2000);
    console.log(`  inflight=${inflight} ok=${ok} err=${err} p50=${pct(lat, 50)}ms p95=${pct(lat, 95)}ms`);
  }
  done = true;
  await Promise.allSettled(workers);
  const rps = (ok / DURATION_S).toFixed(1);
  console.log(`\n=== result ===\ncompleted=${ok} errors=${err} rps=${rps}`);
  console.log(`latency p50=${pct(lat, 50)}ms p90=${pct(lat, 90)}ms p95=${pct(lat, 95)}ms p99=${pct(lat, 99)}ms`);
  process.exit(0);
}

main();
