# Changelog

All notable changes to this project will be documented in this file.

The format follows Keep a Changelog, and release versions use SemVer.

## [Unreleased]

### Added (2026-07-07 — 企业机密档安全基线 plan/08)

- 机密模式一键总开关 `KCW_CONFIDENTIAL=1`(L0 `security/confidential.ts`):`resolveSecurityMode` 强制返回 `air_gap` 且不可被任何配置/env 削弱(fail-closed);启动期 MCP(含 MASE)全丢、`/api/connectors/oauth/*` 一律 403、云模型/外网工具全部拒绝、本地 provider 仍可用;`/api/selfcheck` 暴露 `security.confidential`。
- 落盘加密(切片 2):可复用的 at-rest 信封(`security/at-rest.ts`)——随机 DEK 走 AES-256-GCM,DEK 只被 DPAPI(Windows)/环境派生密钥封印一次存 `.AgentCowork/security/at-rest.key`,避免每次写盘拉 PowerShell。开关 `KCW_ENCRYPT_AT_REST`(机密模式自动开),透明接入对话正文、运行记录、run/orchestrator checkpoints、长期记忆(MEMORY.md/笔记),读侧兼容遗留明文、开不了的密文按损坏跳过。附带修复 DPAPI 在 Windows PowerShell 5.1 下 `TypeNotFound`(缺 `Add-Type -AssemblyName System.Security`),该修复同时让连接器凭据存储在 5.1 环境可用。kimi apiKey(含 fallbacks)从明文落盘改为封印落盘。
- 数据生命周期(切片 2):工作区数据一键彻底销毁 + 保留期。`POST /api/security/data/purge-plan`(只读预览)、`/purge`(需 `confirm:true`,scope: conversations|runs|memory|content|everything,jail 固定服务端 `.AgentCowork`)、`/retention`(删除超 N 天的 run/对话 JSON)。计划先行 + 逐目标复核 jail,被篡改越界的计划抛错拒绝。
- OS 级出网强制(切片 3,计划模块):`security/egress-firewall.ts` 生成"对 app 进程树 program-scoped 出站 Block + loopback/内网网关 Allow"的可审查 Windows 防火墙规则计划(`npm run security:egress-firewall-plan`),含建规命令与一把回滚;非 IP 网关主机名不静默放行(要求 DNS pin)。诚实边界:Windows 防火墙 Block 优先于 Allow,纯规则无法完美"默认拒绝仅放行白名单",本切片为 best-effort OS 强制、应用层出口网关仍是主执行点;真机 apply + 零出网探测证据标"待验收"。
- 连接器治理(切片 4):机密档下连接器攻击面由三道闸锁死(启动 MCP 全丢 + OAuth 403 + connect 只接受本地 filesystem 内置),消除客户端注入任意 stdio 连接器出网的旁路;确认测试 `confidential-connector-posture.test.ts`。CA/EV 代码签名与外部渗透测试需外部条件(证书/第三方),已在 `plan/08` 标"待外部"。

### Added (2026-07-06 — agent runtime convergence & context window)

- Model-aware automatic history compaction: when a request does not pin `maxContextTokens`, the compaction threshold now adapts to the selected model's context window (conservative per-family floors, capped at 2M) instead of a hardcoded 12k. Local/BYO gateways (Ollama, LM Studio, custom OpenAI-compatible) do not get a guessed window (real `num_ctx` is unknowable from the model name and over-guessing risks overflow); declare it via `KCW_MODEL_CONTEXT_WINDOW` / per-request `contextWindowTokens`. Verified end-to-end through the real HTTP route against a real Ollama model.
- Auto-continue for oversized single-message tasks: when a turn runs out of its per-turn step budget while still working, the loop auto-extends by another window up to a hard cap `maxSteps*(1+maxAutoContinues)` (default 2 → up to 3 windows; `KCW_MAX_AUTO_CONTINUE` / `body.maxAutoContinues`, budget/timeout/loop/approval guards still apply). If even the hard cap is not enough, the run reports `stepsExhausted` and the UI surfaces a 继续 entry that resumes from the checkpoint without replaying completed writes. Verified with real Kimi (`kimi-k2.6`): a 10-step chain that used to be cut off at the 6-step budget now finishes naturally.
- Configurable convergence guardrails: a tool-use discipline block in the system prompt (batch parallel calls, stop when done, don't repeat) and a one-shot step-budget wrap-up reminder at ~70% of the budget. Both default-on and tunable/disable via `KCW_TOOL_DISCIPLINE` / `KCW_STEP_NUDGE_RATIO`. Real Ollama + Kimi A/B evidence archived under `reports/step-convergence/` (finding: capable models already converge, so these are zero-cost guardrails rather than a measured step reduction).

### Changed

- Marked the current Windows distributable and desktop shell as `Internal Beta` for small-circle testing, keeping production-release claims blocked on code signing, updater publishing, clean tag release, and external release evidence.
- Added a friend-test zip package with a Windows install guide, bundled installer SHA256, and beta scope notes for safer small-circle distribution.
- CI (`.github/workflows/ci.yml`) now runs the full local static gate (`npm run check` — arch/filesize/secrets/all TS type-checks/lint/ui-types/ts-coverage/js-boundary/icons) and a new UI unit-test job, instead of a narrower subset, so the local gate is no longer the only safety net.
- Documented the `services/` + `apps/local-agent` Go code as a frozen v1.0 pre-research skeleton that is not part of any build/CI (see `plan/00`), to remove architecture ambiguity.

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
