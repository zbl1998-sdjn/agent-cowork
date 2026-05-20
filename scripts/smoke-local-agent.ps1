[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $PSCommandPath
$repoRoot = Split-Path -Parent $scriptDir
$agentDir = Join-Path $repoRoot "apps\local-agent"
$goTmp = Join-Path $repoRoot "build\go-tmp"

New-Item -ItemType Directory -Force -Path $goTmp | Out-Null
$env:GOTMPDIR = $goTmp

Push-Location -LiteralPath $agentDir
try {
    go test -tags cli_smoke ./cmd/kimi-cowork-agent -run TestCLIEndToEnd -count=1 -v
    if ($LASTEXITCODE -ne 0) {
        throw "Local Agent CLI smoke failed with exit code $LASTEXITCODE. If the error is Access is denied, check Microsoft Defender ASR events for a newly built Go test executable."
    }
}
finally {
    Pop-Location
}
