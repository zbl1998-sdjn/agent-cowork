# Changelog

All notable changes to this project will be documented in this file.

The format follows Keep a Changelog, and release versions use SemVer.

## [Unreleased]

### Added (2.x milestone, backfilled 2026-07-04 — see `git log` for individual commits)

- Optional MASE MCP long-term memory bridge integrated into the main agent chat stream: layered recall (thread timeline + structured facts + cross-session history) on read, write-back with fact extraction on success, 2.5s hard recall timeout with safe no-memory fallback.
- Local security posture engine: five security modes (`local_demo` / `local_strict` / `enterprise_local` / `air_gap` / `controlled_hybrid`) plus a unified outbound egress gateway for model calls, WebFetch, WebSearch, connectors, and plugin downloads, with an audit trail (`.AgentCowork/security/egress-audit.jsonl`) and a frontend security status bar showing the active mode and bytes egressed.
- Multi-provider model catalog (14+ OpenAI-compatible/Anthropic-compatible providers, including major domestic model providers) with per-session BYO-key overrides and a serial fallback chain with per-`provider|baseUrl|model` circuit breakers; cost attribution by provider.
- Beginner-friendly one-click office recipes (weekly report draft, boss summary, chat-to-action-list, PPT draft, formal Word doc, email draft) producing Markdown/DOCX/XLSX/PPTX/PDF, plus "save this run as my recipe" capture for custom recipes.
- Parallel sub-agent dispatch (`/api/subagent/parallel`, `AgentParallel` tool) alongside the existing single sub-agent route, each with independent context budgets and step limits.
- Agent runtime resilience: loop guard (repeated-call/consecutive-failure breaker), bounded retry for transient errors, budget guard (token/cost/wall-clock hard limits), whole-run timeout, streaming-interrupt recovery, checkpoint/resume (crash-safe, does not replay completed writes), and an injection guard that wraps tool output as untrusted data and flags prompt-injection/tool-hijack/exfiltration/approval-bypass patterns.
- Deterministic eval framework: golden + red-team task sets, offline replay backend (ModelRecorder/Replayer), fail-closed without explicit replay records.
- Observability: automatic run metrics (token/cost/duration/tool/failure-rate), provider/version/config attribution, structured decision trace, and a frontend Observability panel.
- Runtime dependency manager covering SQLite, embedded Python, Node, CJK fonts, VC++ runtime, Chromium, OCR (Tesseract Chinese packs), Pandoc, MinGit, ffmpeg, and data-science components; only produces reviewable install/cleanup/update plans, never silent downloads or deletes.
- Beginner Home UI ("今天想完成什么" task cards) replacing the earlier dual-page conversation/collaboration model; the primary send path moved to the SSE `/api/agent/chat/stream` endpoint.
- Full `apps/host` source migrated from JS+JSDoc `checkJs` to native TypeScript (0 remaining `.js` sources under `apps/host/src`, 293 `.ts` files).

### Security (2026-07-04)

- Fixed a Windows filename-equivalence bypass of the sensitive-file guard in `path-policy` (trailing dot/space, NTFS alternate data stream `name::$DATA` were not normalized before the sensitive-basename match).
- Fixed `classifyToolRisk` missing the actual `WebSearch` tool name (it only matched the `web.fetch` family), which let `WebSearch` bypass the `local_strict`/`air_gap` "block external network tools" policy and still reach DuckDuckGo/Bing.
- MASE memory bridge writes (user log / assistant log / extracted facts) now go through the same DLP guard as built-in memory; credential/secret-bearing content is skipped rather than written to the external memory backend.
- Memory recalled from any backend is now redacted before injection into the model system prompt, as defense in depth against secrets stored before the write-side guard existed.
- Memory pause/incognito settings now gate both built-in layered memory and the MASE bridge consistently on the live chat path (previously only gated the settings-panel API, not the agent run itself).

### Added

- Added P2-A sandbox startup probing: Docker/WSL are detected at host boot, Docker is selected automatically when a configured image is present locally, and local fallback is reported through `/api/sandbox/info` and `/api/selfcheck`.
- Added a gated real Docker integration test for `--network=none` outbound network blocking (`KCW_SANDBOX_REAL_DOCKER_IMAGE=<local-image-with-sh-wget>`).
- Added a real React connectors smoke test that opens the connector panel, one-click connects the builtin filesystem MCP server, and verifies the imported `mcp__fs__read_text` tool.
- Added connector disconnect support so host-defined MCP connectors can be revoked and their imported tools removed from the registry.
- Added a GitHub OAuth device-flow connector prototype with server-side device-code sessions, protected credential storage, redacted status/revoke routes, and React connector-panel start/complete/revoke controls.
- Added OAuth connector permission approvals: allowlisted scopes, single-use approval receipts, high-risk scope labels, and React connector-panel approval controls.
- Added live artifact connector data sources for connected filesystem MCP reads, with tests for disconnected and high-risk connector tool rejection.
- Added sub-agent context-budget enforcement so over-large plans are rejected before any tool runs, while direct sub-agent routes remain read-only/approval-isolated.
- Added parallel sub-agent dispatch via `/api/subagent/parallel` and the `AgentParallel` model tool, including aggregate run records, configurable concurrency, child context budgets, and approval-gated route rejection.
- Added child-agent lifecycle events and React subtask grouping for `AgentParallel` runs.
- Added local Office artifact generation for `summary-report` recipes (DOCX/PPTX/PDF alongside Markdown) and explicit artifact kinds for Word, spreadsheet, presentation, and PDF outputs.
- Expanded the host `checkJs`/JSDoc type guard to cover live artifact specs, viz rendering, OAuth permissions, JSON stores, and the tool registry.
- Added the local `npm run ci` gate for architecture checks, file-size checks, host tests, and UI tests.
- Added a dry-run-first release skeleton for SemVer validation, VERSION planning, git bundle planning, installer signing/archive planning, and tag planning.
- Added testing and release checklist documentation for milestone gates.

## [0.2.0] - 2026-05-25

### Added

- Archived the P0 + FE-1 Windows release under `releases/v0.2.0/` with NSIS, MSI, VERSION, source bundle, manifest, and installed Tauri smoke evidence.

### Fixed

- Made the Windows signing script discover the current `Agent Cowork_*` installer names instead of hard-coding `0.1.0`.

## [0.1.0] - 2026-05-24

### Added

- Baseline local Agent Cowork MVP release snapshot under `releases/v0.1.0/`.
