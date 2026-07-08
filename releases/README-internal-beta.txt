Agent Cowork v0.3.0 Internal Beta

This folder's current friend-test installer is:

- Agent-Cowork-Setup-v0.3.0-internal-beta.exe
- Agent-Cowork-Setup-v0.3.0-internal-beta.exe.sha256
- INSTALL-Windows-internal-beta.md

The friend-test zip package is:

- Agent-Cowork-v0.3.0-internal-beta-windows-x64.zip

Use scope:

- Small-circle trusted friend testing.
- Local acceptance / internal beta only.
- Not a public production release.

Known release boundary:

- The installer is not code signed yet.
- Windows SmartScreen may show an unknown-publisher warning.
- Formal updater publishing, clean tag release, and external production release evidence are not closed.

SHA256:

AF054A896487E86048D9BC6BE5197EFA97008B80AF9C3370F08533043C582B5B  Agent-Cowork-Setup-v0.3.0-internal-beta.exe

Install guide:

Read INSTALL-Windows-internal-beta.md before running the installer.

What's new since v0.2.1 (see CHANGELOG.md [0.3.0] for full detail):

- New: built-in cross-session memory that works with MASE turned off. Conversations get a
  short-term turn buffer (same-session continuity), and on switching conversations the previous
  one is auto-distilled by the model into structured topic knowledge (confidence gate:
  high -> active / low -> pending, dedup/merge by topic, per-scope capacity eviction, DLP so no
  secrets are stored, provenance back to the source conversation). New conversations recall
  relevant active knowledge by relevance, and a read-only SearchMemory tool lets the agent look
  deeper on demand. The memory panel shows active/pending knowledge with approve/delete controls.
  Verified end-to-end on the real kimi-k2.6 model with MASE off.
- Fixed: long-context compaction used to fold the leading system message (which carries the agent
  instructions plus injected memory) into the summary and tail-truncate it, so long chats on
  small-window local models / very large MEMORY.md could lose long-term memory. Compaction now
  protects the leading system message.
