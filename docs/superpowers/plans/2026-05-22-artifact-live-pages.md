# Artifact Live Pages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Claude Cowork-style persistent HTML Artifact surface that indexes local artifacts and serves safe, self-contained HTML views from the trusted workspace.

**Architecture:** Keep the existing zero-dependency Node host and trusted-root boundary. Add an artifact catalog module under `apps/host/src/artifacts/`, expose catalog and HTML read routes through a focused route file, then wire the static frontend Artifacts view to list and open the generated live pages.

**Tech Stack:** Node.js ESM, built-in `node:test`, existing classic browser scripts, existing Host API helpers, existing trusted-root path policy.

---

### Task 1: Backend Artifact Catalog

**Files:**
- Create: `apps/host/src/artifacts/artifact-catalog.js`
- Create: `apps/host/src/routes/artifact-routes.js`
- Modify: `apps/host/src/server.js`
- Test: `apps/host/test/server.test.js`

- [ ] **Step 1: Write the failing route test**

Add a `server.test.js` test that creates `.KimiCowork/artifacts/report.md`, calls `GET /api/artifacts`, expects one catalog item, then calls `GET /api/artifacts/view?path=<encoded path>` and expects HTML containing the escaped Markdown content.

- [ ] **Step 2: Run the focused test**

Run: `node --test apps/host/test/server.test.js`

Expected before implementation: FAIL with `/api/artifacts` returning 404.

- [ ] **Step 3: Implement catalog and route**

Create `artifact-catalog.js` with `listArtifacts({ trustedRoot, limit })` and `renderArtifactHtml({ trustedRoot, artifactPath })`. The renderer must reject paths outside `.KimiCowork/artifacts`, escape HTML, and support `.md`, `.txt`, `.csv`, `.json`, `.html`, and binary files with a metadata-only fallback.

- [ ] **Step 4: Wire server route**

Import `handleArtifactRoutes` in `server.js` and invoke it after run routes and before file/workspace routes so `/api/artifacts` and `/api/artifacts/view` are handled by the artifact route.

- [ ] **Step 5: Verify backend**

Run: `node --test apps/host/test/server.test.js`

Expected after implementation: PASS.

### Task 2: Frontend Artifact Catalog

**Files:**
- Modify: `apps/windows-client/resources/index.html`
- Modify: `apps/windows-client/resources/app.js`
- Modify: `apps/windows-client/resources/app.css`
- Modify: `scripts/smoke-ui-contract.mjs`

- [ ] **Step 1: Add static DOM anchors**

Add `data-action="refresh-artifacts"` to the Artifacts header and replace the static artifact list with a `data-artifact-list` container. Keep the static fallback text so `file://` preview still has useful content.

- [ ] **Step 2: Add focused frontend code**

Add `loadArtifactCatalog()`, `renderArtifactCatalog(items)`, and `openArtifactView(item)` in `app.js`. They should call `/api/artifacts?limit=12`, render buttons into `[data-artifact-list]`, and open `/api/artifacts/view?path=<encoded item.path>` in a new window when Host API is available.

- [ ] **Step 3: Add modest styling**

Extend the existing `.artifact-list` rules only. Avoid changing global layout, media queries, or the conversation flow.

- [ ] **Step 4: Update smoke contract**

Update `scripts/smoke-ui-contract.mjs` to assert the index includes the artifact catalog anchors, scripts include `/api/artifacts`, and a backend smoke can list and view an applied artifact.

- [ ] **Step 5: Verify frontend syntax and smoke**

Run:

```powershell
node --check apps/windows-client/resources/app.js
node --check scripts/smoke-ui-contract.mjs
npm run smoke:ui
```

Expected: all pass.

### Task 3: Documentation Status

**Files:**
- Modify: `docs/00-cowork-comparison-index.md`

- [ ] **Step 1: Update status matrix**

Change `持久 HTML Artifact (活页)` from `❌` to `🟡` because the first local HTML view is implemented, while live connector-backed refresh and inline model calls remain future work.

- [ ] **Step 2: Add changelog entry**

Append a concise `2026-05-22` section describing the backend catalog, safe HTML renderer, frontend catalog, and verification commands.

- [ ] **Step 3: Verify docs are consistent**

Run: `Select-String -Path docs\00-cowork-comparison-index.md -Pattern '持久 HTML Artifact','2026-05-22'`

Expected: both the matrix and changelog mention the new partial implementation.

---

## Self-Review

Spec coverage: This plan implements one high-value Claude Cowork gap, the persistent HTML Artifact surface, without introducing MCP, connector, or React/Tauri scope creep.

Placeholder scan: No task uses open-ended placeholder steps; each task names the files, commands, and expected behavior.

Type consistency: The route names are `/api/artifacts` and `/api/artifacts/view`, and the frontend functions use those exact names.
