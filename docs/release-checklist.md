# Release Checklist

Use this checklist for every milestone release.

## Before Release

- [ ] `docs/面试演示与上线预备验收标准.md` has been applied: P0/P1 are zero, no one-vote veto item remains, and any P2/P3 deferral is recorded with evidence.
- [ ] Version is valid SemVer and has a matching `CHANGELOG.md` entry.
- [ ] Q4: `npm run ci` passes locally.
- [ ] Q6: `npm run smoke:e2e` writes a JSON report under `reports/e2e-smoke/`.
- [ ] Q7: `npm run bench` writes a JSON baseline under `reports/bench/`; use `BENCH_FAIL_ON_REGRESSION=1 npm run bench` when enforcing thresholds.
- [ ] Q8/R5: Windows installer or installed-client smoke status is recorded as JSON under `reports/windows-client-smoke/` with `npm run smoke:installed-tauri -- -DryRun` at minimum, and with the installed executable path when available. `smoke:windows-client` is the legacy C/Win32 source-build harness.
- [ ] Known environment-only blockers are documented separately from code failures.
- [ ] No secrets, local credentials, or generated private data are included.
- [ ] Production signing credential is available before any executable release:
  - Preferred: import a trusted CA code-signing cert with private key, then set `KCW_CODESIGN_THUMBPRINT`.
  - Alternative: set `KCW_CODESIGN_PFX` and provide the password through `KCW_CODESIGN_PFX_PASSWORD` or a CI secret.
  - Do not use `scripts/sign-windows.ps1 -SelfSigned` for production distribution.

## Dry Run

Run:

```powershell
npm run smoke:e2e
npm run bench
npm run smoke:installed-tauri -- -DryRun
npm run release -- --version <semver>
```

Confirm the plan includes:

- `releases/v<semver>/VERSION.txt`
- `releases/v<semver>/agent-cowork-v<semver>.bundle`
- production signing step using `scripts/sign-windows.ps1 -Thumbprint ...` or `-Pfx ...` when installers exist
- installer archive copies from `installers/`
- annotated git tag `v<semver>`

Dry-run must not create tags, bundles, archives, or VERSION files.

## Execute

Only execute from a clean worktree:

```powershell
npm run ci
$env:E2E_SMOKE_REAL = "1"; npm run smoke:e2e; Remove-Item Env:E2E_SMOKE_REAL
$env:BENCH_FAIL_ON_REGRESSION = "1"; npm run bench; Remove-Item Env:BENCH_FAIL_ON_REGRESSION
$env:KCW_CODESIGN_THUMBPRINT = "<trusted-code-signing-cert-thumbprint>"
npm run smoke:installed-tauri -- -InstallerPath <path-to-installer> -InstalledExePath <path-to-installed-agent-cowork-desktop.exe>
npm run release -- --version <semver> --execute
Remove-Item Env:KCW_CODESIGN_THUMBPRINT
```

Expected artifacts:

- `releases/v<semver>/VERSION.txt`
- `releases/v<semver>/manifest.json`
- `releases/v<semver>/agent-cowork-v<semver>.bundle`
- archived installers, when available
- annotated tag `v<semver>`

## Rollback

- Do not delete the bundle or VERSION file after publication.
- If a release was executed accidentally before publication, delete the local tag only after confirming no one else consumed it.
- Keep the failed release notes in `CHANGELOG.md` with the reason it was superseded.
