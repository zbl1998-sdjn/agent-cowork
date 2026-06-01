# JS To TS Migration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate project JavaScript to TypeScript in small, verified feature lines without breaking the existing Host/UI/Tauri contracts.

**Architecture:** Follow `plan/00-架构基线与模块依赖.md`. Host imports must keep pointing inward across L0-L4. Source files may keep NodeNext-style `.js` import specifiers during migration because `scripts/check-arch.ts`, `scripts/host-ts-loader.mjs`, and `tsconfig.host-checkjs.json` support `.js` specifiers resolving to `.ts` sources.

**Current Boundary (2026-06-02):**
- Checked source files are TypeScript. `npm run check:js-boundary` allows only three Node loader bootstraps (`scripts/host-ts-loader.mjs`, `scripts/register-host-ts-loader.mjs`, `scripts/run-host-node.mjs`) plus generated Windows resource scripts.
- Windows classic resource sources live in `apps/windows-client/resources-src/*.ts`; `apps/windows-client/resources/*.js` is generated output and is checked by `npm run check:resource-js`.
- `npm run check:ts-coverage` fails if any TS-like source file is not covered by one of the checked tsconfig projects, which keeps VS Code Problems aligned with the repo gates.
- Do not convert the loader bootstraps to TS without replacing the bootstrap strategy first: those files run before the repo TypeScript loader is active.

**Scope Order:**
- Host source first: `apps/host/src/**/*.js`, because it is already covered by `tsconfig.host-checkjs.json`, `check:arch`, and `build:host-source`.
- Host tests second: `apps/host/test/**/*.js`, after source migration stabilizes.
- Tooling scripts third: `scripts/**/*.mjs`, `apps/host/scripts/**/*.mjs`, and `eval/**/*.js`, because they have different entrypoint/runtime contracts.
- Windows classic resources last: `apps/windows-client/resources/app-*.js`, because the host static whitelist, `index.html`, and smoke tests must move together.
- Generated Vite timestamp files are not migration targets.

**Global Verification For Each Source Slice:**
- Pre-change focused test for the module behavior.
- `npm run check:arch`
- `npm run check:host-types`
- `npm run check:js-boundary`
- `npm run check:ts-coverage`
- `npm run check`
- `npm run build:host-source`
- Focused `node scripts/run-host-node.mjs --cwd apps/host -- --test --import ../../test-setup.mjs ...`
- Commit with a Conventional Commits message after the slice is green.

---

### Task 1: Kimi Provider Adapters

**Files:**
- Rename: `apps/host/src/kimi/provider/{anthropic,index,kimi,openai-compatible}.js` to `.ts`
- Create: `apps/host/src/kimi/provider/types.ts`
- Modify: `tsconfig.host-checkjs.json`

- [x] Run baseline provider tests.
- [x] Convert provider registry and adapters to TS.
- [x] Move shared provider types below the registry to avoid import cycles.
- [x] Verify `npm run check`, `npm run build:host-source`, and focused provider tests.
- [x] Commit: `fb75986 refactor: migrate kimi provider adapters to ts`

### Task 2: Kimi Agent Leaf Modules

**Candidate Files:**
- `apps/host/src/kimi/agent/approval-gate.js`
- `apps/host/src/kimi/agent/parallel-agent-tool.js`
- `apps/host/src/kimi/agent/tool-call-executor.js`
- `apps/host/src/kimi/agent/tool-loop.js`
- `apps/host/src/kimi/agent/toolset-builder.js`

- [ ] Pick the smallest leaf module with direct tests first.
- [ ] Run the focused characterization tests before renaming.
- [ ] Rename to `.ts`, add explicit exported types only where call sites need them.
- [ ] Update `tsconfig.host-checkjs.json`.
- [ ] Run global verification and commit.

### Task 3: Kimi Top-Level Modules

**Candidate Files:**
- `apps/host/src/kimi/api-runner-config.js`
- `apps/host/src/kimi/api-runner-prompts.js`
- `apps/host/src/kimi/config-store.js`
- `apps/host/src/kimi/cli-runner.js`
- `apps/host/src/kimi/chat-stream.js`
- `apps/host/src/kimi/agent-runner.js`
- `apps/host/src/kimi/agent-tools*.js`

- [ ] Migrate config/prompt helpers before runner orchestration.
- [ ] Keep agent runner and chat stream for later because they cross several runtime contracts.
- [ ] Use focused tests for config, CLI, chat stream, tool loop, and agent behavior.
- [ ] Run global verification and commit per slice.

### Task 4: Other Host Domains

**Domains:**
- `artifacts/`
- `memory/`
- `recipes/`
- `runtime/`
- `routes/`
- `tools/`
- `server.js` and `main.js`

- [ ] Migrate low-level utility modules before routes and `server.js`.
- [ ] Do not migrate `server.js` until route/static/resource smoke tests are current.
- [ ] Treat every route domain as its own feature line with route tests.
- [ ] Run global verification and commit per domain slice.

### Task 5: Tests, Scripts, And Windows Resources

- [ ] Decide whether host tests should become `.test.ts` or remain `.test.js` until source migration is complete.
- [ ] Add or update a test runner path before converting tests.
- [ ] Convert scripts only after CLI/build/release entrypoints are checked.
- [ ] For Windows resources, update static whitelist, `index.html`, resource smoke tests, and installed-client smoke evidence in the same slice.
