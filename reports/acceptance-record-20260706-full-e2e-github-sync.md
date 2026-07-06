# 2026-07-06 Full E2E / GitHub Sync Prep

> Local date: 2026-07-06 Australia/Sydney. Command artifacts use UTC timestamps around 2026-07-05T22:xxZ.

## Result

Local full E2E for the current working tree passed, and the latest internal-beta installer was rebuilt, installed, smoked, and copied to `releases/`.

This is **internal beta / local acceptance**, not production release acceptance. Production code signing, updater publishing, clean tag release, and external production evidence remain blockers.

## Commands Run

| Area | Command / Evidence | Result |
| --- | --- | --- |
| Full gate | `python -X utf8 scripts\quality_gate.py --level full` | Pass |
| Security | `security:local-strict` inside full gate | Pass, zero actual external egress |
| UI build | `npm --prefix apps/windows-client/ui run build` | Pass |
| Host sidecar | `npm run build:host` | Pass |
| Tauri installer | `cargo tauri build --ci --bundles nsis` | Pass |
| Release checklist Q6 | `npm run smoke:e2e` | Pass, `reports/e2e-smoke/e2e-smoke-2026-07-05T22-05-09-867Z.json` |
| Release checklist Q7 | `npm run bench` | Pass, `reports/bench/bench-2026-07-05T22-05-09-910Z.json` |
| Release checklist Q8 dry run | `npm run smoke:installed-tauri -- -DryRun` | Pass, `reports/windows-client-smoke/installed-tauri-smoke-20260705T220508Z.json` |
| Silent install | NSIS installer with `/S` | Pass, exit code 0 |
| Installed app smoke | `npm run smoke:installed-tauri -- -InstallerPath <latest> -InstalledExePath <installed exe>` | Pass, `reports/windows-client-smoke/installed-tauri-smoke-20260705T220946Z.json` |
| Installed WebView/a11y | `node scripts/run-host-node.mjs scripts/smoke-installed-a11y.ts` | Pass, `reports/windows-client-smoke/installed-a11y-2026-07-05-221006Z.json` |
| Live Kimi re-smoke | `npm run smoke:kimi-api` | Blocked by missing `KIMI_API_KEY` / `MOONSHOT_API_KEY` in this shell |

## Test Counts From Full Gate

- `test:host`: 1019 passed / 1 skipped.
- `test:ui`: 375 passed.
- `eval`: 28/28 passed.
- `smoke:playwright-all`: passed and wrote `output/playwright/agent-cowork-all-smoke-report.json`.

## Latest Installer

- Build output: `apps/windows-client/src-tauri/target/release/bundle/nsis/Agent Cowork_0.2.0_x64-setup.exe`
- Release copy: `releases/Agent-Cowork-Setup-v0.2.0-internal-beta.exe`
- Size: `79,218,176` bytes
- SHA256: `5071F9BEBA6B854297911BBBA3F626AAD15D50F55A8D7C61ACD482B10F428A36`
- SHA file: `releases/Agent-Cowork-Setup-v0.2.0-internal-beta.exe.sha256`
- Authenticode: `NotSigned`

Installed files after silent install:

- Desktop exe: `%LOCALAPPDATA%\Agent Cowork\agent-cowork-desktop.exe`
  - Size: `16,015,872` bytes
  - SHA256: `7D5ADAA9019BE39B10C2014F96409D9AEDABC9D0321128E124DC827DAF59E5C8`
  - Authenticode: `NotSigned`
- Sidecar exe: `%LOCALAPPDATA%\Agent Cowork\agent-cowork-host.exe`
  - Size: `94,061,568` bytes
  - SHA256: `603CCF0B663A94A5918E3D7553D9C313F07DFE1D4896020A0507B6ABF74E4F5C`
  - Authenticode: `NotSigned`

## Installed Smoke Coverage

`reports/windows-client-smoke/installed-tauri-smoke-20260705T220946Z.json` recorded:

- current-user install root under `%LOCALAPPDATA%\Agent Cowork`
- HKCU uninstall entry present and HKLM all-machine entry absent
- WebView2 bootstrapper config present
- NSIS AppData cleanup hook configured and gated
- installed desktop exe, host sidecar, embedded Python present
- host `/health` available at `127.0.0.1:3017`
- guest auth round trip
- SQLite runtime available
- SQLite auth / memory / run / schedule persisted across installed app restart
- desktop and sidecar cleaned up after smoke

`reports/windows-client-smoke/installed-a11y-2026-07-05-221006Z.json` recorded:

- `viewsScanned=20`
- `contrastIssues=0`
- `sendButtonMinContrast=5.34`
- `timelineOk=true`
- `overflowIssues=[]`
- `mobileComposerOk=true`
- mobile viewport `390x844` with no page/composer overflow

## Package Cleanup

Latest release package body retained:

- `releases/Agent-Cowork-Setup-v0.2.0-internal-beta.exe`
- `releases/Agent-Cowork-Setup-v0.2.0-internal-beta.exe.sha256`

Old package bodies removed:

- `releases/agent-cowork-v0.2.0-internal-beta-20260705T184445Z.zip`
- `releases/agent-cowork-v0.2.0-internal-beta-20260705T184445Z.zip.sha256`
- `releases/internal-beta-v0.2.0-20260705T184445Z/`
- `releases/v0.1.0/Agent Cowork_0.1.0_x64_en-US.msi`
- `releases/v0.1.0/Agent Cowork_0.1.0_x64-setup.exe`
- `releases/v0.2.0/Agent Cowork_0.2.0_x64_en-US.msi`
- `releases/v0.2.0/Agent Cowork_0.2.0_x64-setup.exe`
- `installers/Agent Cowork_0.2.0_x64_en-US.msi`
- `installers/Agent Cowork_0.2.0_x64-setup.exe`

Historical `VERSION.txt`, source bundles, manifests, and smoke evidence were not deleted unless they were part of an obsolete package bundle directory.

## Remaining Blockers

- Production Windows code signing is still not closed: installer, installed desktop exe, and installed sidecar are `NotSigned`.
- Production updater publishing is still not closed: `bundle.createUpdaterArtifacts=false`, updater endpoint is still placeholder, and updater signing/private endpoint env is not configured.
- `npm run smoke:kimi-api` could not be rerun in this shell because no `KIMI_API_KEY` / `MOONSHOT_API_KEY` was present. Prior authorized live Kimi evidence remains `build/kimi-api-smoke-report.json`.
- No formal clean-tag release was executed in this pass.

## Current Source Verification

- Local command evidence from this pass: full quality gate, release checklist Q6/Q7/Q8, UI build, host build, Tauri NSIS build, silent install, installed smoke, installed a11y smoke, `Get-FileHash`, `Get-AuthenticodeSignature`.
- Local config evidence: `apps/windows-client/src-tauri/tauri.conf.json`, `scripts/release.ts`, `scripts/sign-windows.ps1`, `scripts/smoke-installed-tauri.ps1`, `scripts/smoke-installed-a11y.ts`.
