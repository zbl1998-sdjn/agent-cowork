# Testing

This project keeps one reproducible local gate: `npm run ci`.

## Test Layers

1. Feature contract tests keep existing user-visible behavior stable before refactors.
2. Unit tests cover module-level logic near the code under test.
3. Integration tests cover host routes, sandbox/storage seams, auth, approvals, and file operations.
4. E2E smoke tests cover one realistic product path with the real host/UI boundary.
5. Performance benchmarks are milestone checks, not a default local gate yet.

## Naming And Placement

- Host tests live in `apps/host/test/*.test.js` and run through Node's built-in test runner.
- UI tests live under `apps/windows-client/ui/src/**/*.test.ts` or `*.test.tsx`.
- E2E and smoke scripts live in `scripts/smoke-*.mjs` or `scripts/*.ps1`.
- New module tests should use the same feature name as the module they lock.

## Local Commands

- `npm run check`: architecture and file-size guards.
- `npm run test:host`: `npm run check`, then isolated host tests with `--test-isolation=process`.
- `npm run test:ui`: UI test suite through the UI package.
- `npm run ci`: full local CI gate, in order: check, host tests, UI tests.
- `npm run smoke:host`: host API operation smoke.
- `npm run smoke:ui`: UI shell/API contract smoke.
- `npm run smoke:rendered-ui`: real browser rendered UI smoke when Edge/Chrome is available.
- `npm run smoke:windows-resources`: packaged Windows resource smoke without launching the exe.
- `npm run smoke:e2e`: Q6 E2E smoke. Defaults to offline dry-run with an injected model and writes JSON under `reports/e2e-smoke/`. Set `E2E_SMOKE_REAL=1` plus `KIMI_API_KEY` or `MOONSHOT_API_KEY` to run the real Kimi path.
- `npm run bench`: Q7 local performance baseline for startup, first-screen response, SSE frame processing, and memory. Writes JSON under `reports/bench/`; set `BENCH_FAIL_ON_REGRESSION=1` to turn threshold warnings into failures.
- `npm run smoke:windows-client`: R5 Windows client smoke. Use `-- -DryRun` for a non-destructive installed-build checklist.
- `npm run smoke:kimi-api`: optional live model smoke; requires `KIMI_API_KEY` or `MOONSHOT_API_KEY` and network.

## Gate Rule

A task is not done until the narrow relevant test passes. A milestone is not releasable until `npm run ci` passes and the release checklist records any optional smoke tests that could not run.
