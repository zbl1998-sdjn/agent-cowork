# Changelog

All notable changes to this project will be documented in this file.

The format follows Keep a Changelog, and release versions use SemVer.

## [Unreleased]

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
