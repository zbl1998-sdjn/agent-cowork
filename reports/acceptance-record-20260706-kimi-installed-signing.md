# 2026-07-06 Kimi / Installed App / Signing Closeout

> Local date: 2026-07-06 Australia/Sydney. Command artifacts use UTC timestamps around 2026-07-05T14:xxZ.
> Latest full E2E / installer cleanup evidence is now tracked in `reports/acceptance-record-20260706-full-e2e-github-sync.md`.

## Closed

- Real Kimi API smoke passed with current model `kimi-k2.7-code`.
  - Report: `build/kimi-api-smoke-report.json`
  - generatedAt: `2026-07-05T14:12:20.751Z`
  - runId: `run_20260705141206_77c6936b`
  - baseUrl: `https://api.moonshot.cn/v1`
  - durationMs: `13955`
- Current source installer was rebuilt and silently installed.
  - Command evidence: `npm --prefix apps/windows-client/ui run build`; `npm run build:host`; `cargo tauri build --ci --bundles nsis`
  - Installer: `apps/windows-client/src-tauri/target/release/bundle/nsis/Agent Cowork_0.2.0_x64-setup.exe`
  - Size: `79,222,537` bytes
  - SHA256: `9B19D12DD00A3DAC9A86C78D3FF01BCD83F02F16EFBDF9CF880DDC0784D5D6A5`
  - Authenticode: `NotSigned`
- Installed app smoke passed after reinstall.
  - Report: `reports/windows-client-smoke/installed-tauri-smoke-20260705T142258Z.json`
  - generatedAt: `2026-07-05T14:22:58.9592113Z`
  - verified: current-user install, WebView2 bootstrapper config, NSIS cleanup hook, installed desktop/sidecar existence, host health, guest auth, `/api/kimi/info`, SQLite write chain, embedded Python, restart persistence, process cleanup
  - Kimi config observed by installed app: `provider=kimi-api`, `model=kimi-k2.7-code`
- Installed WebView2 deep smoke passed after UI and smoke-script drift fixes.
  - Report: `reports/windows-client-smoke/installed-a11y-2026-07-05-142323Z.json`
  - generatedAt: `2026-07-05T14:23:26.022Z`
  - summary: `viewsScanned=20`, `contrastIssues=0`, `sendButtonMinContrast=5.34`, `liveRegionCount=2`, `timelineOk=true`, `overflowIssues=[]`, `mobileComposerOk=true`
- Full local quality gate passed after the closeout edits.
  - Command: `python -X utf8 scripts\quality_gate.py --level full`
  - Result: `full gate passed`
  - Covered: `security:local-strict`, `build:ui`, `smoke:playwright-all`, `ci`, `test:host` 1019 passed / 1 skipped, `test:ui` 375 passed, `eval` 28/28.
  - Non-blocking warnings: existing soft file-size warnings remain and should stay tracked as architecture debt, not release blockers for this slice.

## Code/Script Adjustments

- `scripts/smoke-kimi-api.ts`: default smoke report model now matches current host default `kimi-k2.7-code`.
- `scripts/smoke-installed-a11y.ts`: updated installed WebView smoke to current UI contracts:
  - panel navigation now uses left rail `.rail-nav-item` with legacy header fallback;
  - settings opening now supports the command palette entry `API 设置`;
  - mobile composer scan now targets the current always-visible composer footer/model controls instead of removed `composer-insert` / `composer-advanced` details.
- `apps/windows-client/ui/src/styles/17-claude-align.css`:
  - fixed `.context-count` contrast from 4.23 to passing small-text contrast;
  - fixed mobile composer provider-select internal overflow by widening the first grid track.

## Remaining External Blockers

- Production Windows code signing is not closed.
  - `Get-AuthenticodeSignature` remains `NotSigned` for the NSIS installer, installed desktop exe, and installed sidecar exe.
  - `signtool.exe` is available in Windows Kits, but no production PFX/signing env vars are configured.
  - Current user code-signing certificates are local/self-signed development certs, not a production CA trust chain.
- Production updater publishing is not closed.
  - `tauri.conf.json`: `bundle.createUpdaterArtifacts=false`
  - updater endpoint remains placeholder `https://updates.agent-cowork.local/...`
  - `apps/windows-client/src-tauri/src/config.rs`: `UPDATES_CONFIGURED=false`
  - no `TAURI_SIGNING_PRIVATE_KEY`, private-key path, or real update endpoint env var is configured.

## Current Source Verification

- Local command evidence: `npm run check:script-types`, `npm --prefix apps/windows-client/ui run build`, `npm run build:host`, `cargo tauri build --ci --bundles nsis`, `scripts/smoke-kimi-api.ts`, `scripts/smoke-installed-tauri.ps1`, `scripts/smoke-installed-a11y.ts`, `python -X utf8 scripts\quality_gate.py --level full`.
- Local config evidence: `apps/windows-client/src-tauri/tauri.conf.json`, `apps/windows-client/src-tauri/src/config.rs`, `Get-AuthenticodeSignature`, code-signing certificate store probe.
- Kimi model currentness: use `reports/model-currentness-audit-20260705.md`, Kimi official Model List `https://platform.kimi.ai/docs/models`, and the real API smoke above; do not regress smoke/defaults to `kimi-k2.6`.
