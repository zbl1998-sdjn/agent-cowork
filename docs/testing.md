# Testing

The authoritative full local-source gate is:

```powershell
python -X utf8 scripts/quality_gate.py --level full
```

`npm run ci` is one delegated layer of that gate, not the complete release acceptance boundary.

## Test Layers

1. Feature contract tests keep existing user-visible behavior stable before refactors.
2. Unit tests cover module-level logic near the code under test.
3. Integration tests cover host routes, sandbox/storage seams, auth, approvals, and file operations.
4. E2E smoke tests cover one realistic product path with the real host/UI boundary.
5. Performance benchmarks are milestone checks, not a default local gate yet.

## Naming And Placement

- Host tests live in `apps/host/test/*.test.ts` and run through Node's built-in test runner.
- UI tests live under `apps/windows-client/ui/src/**/*.test.ts` or `*.test.tsx`.
- E2E and smoke scripts live in `scripts/smoke-*.ts` or `scripts/*.ps1`.
- New module tests should use the same feature name as the module they lock.

## Local Commands

- `python -X utf8 scripts/quality_gate.py --level full`: full local-source gate; it runs the repository-declared security, build, browser-smoke and CI layers and fails on the first red layer.
- `npm run check`: architecture, file-size, secrets, type, lint and repository-boundary guards.
- `npm run test:host`: `npm run check`, then host tests using Node 20+'s default per-file child-process isolation; no version-specific isolation flag is passed.
- `npm run test:ui`: UI test suite through the UI package.
- `npm run ci`: repository CI layer; read `scripts/ci.ts` and its command output for the current ordered steps.
- `npm run smoke:host`: host API operation smoke.
- `npm run smoke:ui`: UI shell/API contract smoke.
- `npm run smoke:rendered-ui`: real browser rendered UI smoke when Edge/Chrome is available.
- `npm run smoke:windows-resources`: packaged Windows resource smoke without launching the exe.
- `npm run smoke:e2e`: Q6 E2E smoke. The supported current path is the offline/local run with an injected or loopback model, writing JSON under `reports/e2e-smoke/`. The legacy `E2E_SMOKE_REAL=1` public-Kimi branch is not a passing beta gate while public-cloud approval receipts cannot be consumed.
- `npm run bench`: repeatable Q7 local benchmark for startup, first-screen response, the real Agent SSE route, parallel throughput/speedup, and memory. It uses fixed offline inputs, warmups, and repeated p50/p95/CV samples. See [`performance-benchmark.md`](./performance-benchmark.md) for budgets, noise handling, and the non-production boundary.
- `npm run smoke:windows-client`: R5 Windows client smoke. Use `-- -DryRun` for a non-destructive installed-build checklist.
- `npm run smoke:kimi-api`: reserved public-Kimi external acceptance script. It intentionally fails closed in the current Internal Beta; do not list it as passing evidence until the approval-receipt consumer and an authorized live run are both accepted.

## Eval Evidence

`npm run eval` is deterministic only when `KCW_EVAL_REPLAY_RECORDS` points to a real ModelRecorder JSON/JSONL file. The full local-source gate selects an existing record under `output/eval-replay/` when the variable is absent and fails closed if no usable record exists.

The checked-in/current replay evidence must be interpreted as a regression fixture, not as a fresh live-model benchmark. The current merged file, `output/eval-replay/model-records-20260702T234520829Z-merged.jsonl`, combines an initial 28-task live capture (24 passed) with four targeted repair captures. `reports/eval/latest.json` reports the most recent offline replay of that fixture. A live-model, network, credential or production claim requires a separately dated live run and must not be inferred from replay success.

## Gate Rule

A task is not done until the narrow relevant test passes. A source milestone is not locally accepted until the full local-source gate passes. A distributable is not release-accepted until the version-matched installed-client smoke, trusted signing verification and production updater verification are also recorded; see `docs/release-checklist.md`.
