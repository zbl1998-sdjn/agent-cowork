Agent Cowork v0.2.1 Internal Beta

This folder's current friend-test installer is:

- Agent-Cowork-Setup-v0.2.1-internal-beta.exe
- Agent-Cowork-Setup-v0.2.1-internal-beta.exe.sha256
- INSTALL-Windows-internal-beta.md

The friend-test zip package is:

- Agent-Cowork-v0.2.1-internal-beta-windows-x64.zip

Use scope:

- Small-circle trusted friend testing.
- Local acceptance / internal beta only.
- Not a public production release.

Known release boundary:

- The installer is not code signed yet.
- Windows SmartScreen may show an unknown-publisher warning.
- Formal updater publishing, clean tag release, and external production release evidence are not closed.

SHA256:

B5F6DA1A8959287B03F8FF68FA4DB99B6123CADAF77E3B60C4A4ED365584F8D1  Agent-Cowork-Setup-v0.2.1-internal-beta.exe

Install guide:

Read INSTALL-Windows-internal-beta.md before running the installer.

What's new since v0.2.0 (see CHANGELOG.md [0.2.1] for full detail):

- Security fixes: CSV formula/DDE injection, three confidential-mode egress bypasses
  (AI recipe extraction, orchestrator tasks, web.fetch/WebSearch), OOXML control-character
  file corruption, visualization CDN dependency under air_gap, sandbox strict-mode tool
  registration.
- New: 6 built-in office recipes now use real AI extraction (meeting actions, summaries,
  contract digest, feedback clustering, weekly report, table cleaning) with template fallback;
  scheduled/cron recipes get the same AI path; preview cards show an "AI generated" badge.
- Fixed: referenced/@-mentioned files not reaching recipe/chat context, thinking-model
  `<think>` blocks polluting JSON extraction, and several UI/UX papercuts.
- Fixed (2026-07-09 dogfood pass): chart/flowchart/live-artifact outputs now render inside the
  app window (previously blocked by the desktop CSP because charts loaded scripts from a CDN /
  used inline scripts; now bundled locally). The component panel no longer falsely reports the
  bundled Python, CJK fonts, or WebView2 runtime as missing (detection now probes the real files,
  not just env vars). Plus one more P0 egress-gateway fix for the main chat WebFetch tool.
