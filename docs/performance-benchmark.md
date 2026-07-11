# Local performance benchmark

`npm run bench` is the canonical repeatable local benchmark. It exercises real Host assembly,
`/health`, the first-screen route, and `/api/agent/chat/stream` with large prompts and multiple
concurrent tasks. It does not call a real model, database, external network, or production service.
The server is bound to `127.0.0.1`; model responses are injected; outbound injected fetches reject;
the state backend is forced to `file`; memory is paused in the fresh benchmark workspace.

## Sampling contract

- Seed: `BENCH_SEED=20260711`.
- Warmup: `BENCH_WARMUP_ROUNDS=2`; warmups execute but are excluded from statistics.
- Samples: `BENCH_SAMPLE_ROUNDS=7`, with a hard minimum of five.
- Percentiles: nearest-rank p50 and p95. Agent request p50/p95/CV and the
  BENCH_TASK_P95_MS budget pool every measured request across all sample rounds. The
  requestLatencyP95Ms field is only the distribution of per-round p95 values; it is diagnostic
  and is not used as the overall request percentile or budget sample.
- Noise: coefficient of variation (CV) is reported for each repeated metric. A CV above
  `BENCH_MAX_CV_PCT=35` is `inconclusive`, never a usable baseline.
- Workload: 12 tasks, concurrency four, 8 KiB deterministic prompt per task, and an 8 ms injected
  model delay. The report includes the prompt SHA-256 and sequential/parallel throughput and speedup.

The JSON report is written under `reports/bench/` with `schemaVersion: 2`. A result is suitable as a
baseline only when `baselineUsable` is `true` and `status` is `pass`. `ok: true` can also mean a
non-enforced warning or noisy run completed; it is not an acceptance statement.
The generated `kcw-bench-v2-*` workspace is path-jailed and removed in a `finally` block; JSON
reports are retained separately as the evidence surface.

## Regression budgets

The defaults are deliberately explicit and can be overridden for a controlled machine class:

| Environment variable | Default | Direction |
| --- | ---: | --- |
| `BENCH_STARTUP_MS` | 2500 ms | startup p95 at most |
| `BENCH_FIRST_SCREEN_MS` | 3000 ms | first-byte p95 at most |
| `BENCH_TASK_P95_MS` | 2000 ms | parallel request p95 at most |
| `BENCH_TASK_MIN_THROUGHPUT` | 5 tasks/s | parallel p50 at least |
| `BENCH_TASK_MIN_SPEEDUP` | 1.2x | parallel p50 at least |
| `BENCH_RSS_MB` | 512 MiB | at most |
| `BENCH_HEAP_USED_MB` | 192 MiB | at most |

By default, a budget miss is `warn`. With `BENCH_FAIL_ON_REGRESSION=1`, a miss is `fail`, and an
`inconclusive` noisy metric is also blocking. Do not loosen a budget to make a red run green; rerun on
an idle, fixed-power machine first, then change a budget only with reviewed baseline evidence.

## Controlled overrides

The workload controls are `BENCH_TASK_COUNT`, `BENCH_TASK_CONCURRENCY`, `BENCH_PROMPT_BYTES`, and
`BENCH_MOCK_MODEL_DELAY_MS`. Keep all values identical when comparing two commits. The report records
Node/platform/architecture, but not every source of machine noise; compare only runs from the same
machine class and power profile.

Timing uses Node's monotonic `performance.now()` API. The repository accepts Node 20 or newer, and
the report records the exact runtime used for each sample. The current verification host uses Node
24; see the matching Node.js `perf_hooks` documentation:
<https://nodejs.org/docs/latest-v24.x/api/perf_hooks.html>.
