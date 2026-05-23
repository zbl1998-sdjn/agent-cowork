# Kimi API Host Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the product's Kimi CLI execution path with a server-side OpenAI-compatible Kimi API path.

**Architecture:** Keep the existing Host API endpoints (`/api/kimi/plan`, `/api/kimi/chat`) and run-record persistence, but change the default runner from a spawned local CLI process to an HTTP chat-completions client. Frontend code should reason about `kimiApi`, not `kimiCli`, while retaining local fallback behavior when no API key is configured.

**Tech Stack:** Node.js built-in `fetch`, existing Host HTTP server, existing run store / runs index, zero external npm dependencies.

---

### Task 1: API Runner

**Files:**
- Create: `apps/host/src/kimi/api-runner.js`
- Modify: `apps/host/test/server.test.js`

- [ ] Add a Kimi API runner that builds the same constrained plan/chat prompts used by the current Host flow.
- [ ] Send non-streaming OpenAI-compatible `POST /chat/completions` requests with bearer auth.
- [ ] Parse string or text-part response content and reject empty responses.
- [ ] Add tests through `createServer({ kimiPlanRunner })` and a direct API-runner unit test using an injected fake `fetch`.

### Task 2: Host Endpoint Switch

**Files:**
- Modify: `apps/host/src/server.js`
- Modify: `apps/host/src/main.js`
- Modify: `scripts/start-mvp.mjs`
- Modify: `scripts/start-tauri-host.mjs`

- [ ] Remove `detectKimiInfo` and default `runKimiCli*` imports from `server.js`.
- [ ] Return `/api/workspace.kimiApi` with `configured`, `planEnabled`, `chatEnabled`, `baseUrl`, and `model`.
- [ ] Return `/api/kimi/info` from API configuration only; never spawn `kimi info`.
- [ ] Configure API from `KIMI_API_KEY` or `MOONSHOT_API_KEY`, plus `KIMI_BASE_URL`, `MOONSHOT_BASE_URL`, `KIMI_MODEL`, `KIMI_API_TIMEOUT_MS`, and `KIMI_API_MAX_TOKENS`.

### Task 3: UI And Smoke Contract

**Files:**
- Modify: `apps/windows-client/resources/index.html`
- Modify: `apps/windows-client/resources/app.js`
- Modify: `scripts/smoke-live-mvp.mjs`
- Modify: `scripts/smoke-rendered-ui.mjs`
- Modify: `scripts/verify-mvp.mjs`

- [ ] Replace user-facing CLI status text with API status text.
- [ ] Keep local fallback when no API key is configured.
- [ ] Keep smoke tests deterministic by injecting fake Kimi runners instead of touching real network.
- [ ] Rename the optional live smoke script contract from CLI smoke to API smoke.

### Task 4: Docs And Verification

**Files:**
- Modify: `README.md`
- Modify: `docs/00-cowork-comparison-index.md`

- [ ] Document API env vars and remove instructions that make CLI the primary path.
- [ ] Mark Kimi API as the product path and CLI bridge as legacy/developer-only if mentioned.
- [ ] Run focused `node --check`, focused server tests, `npm run smoke:ui`, and `npm test`.
