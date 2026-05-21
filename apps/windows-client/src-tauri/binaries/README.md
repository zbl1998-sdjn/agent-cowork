Kimi Cowork expects a packaged host sidecar named `kimi-cowork-host`.

Tauri resolves the target-specific binary from this directory via
`bundle.externalBin = ["binaries/kimi-cowork-host"]`. Development still uses
`scripts/start-tauri-host.mjs`; release packaging must place the compiled host
sidecar here with the platform suffix required by the Tauri CLI.
