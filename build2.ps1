# Legacy compatibility wrapper for the canonical local source gate and desktop build.
# It intentionally does not sign, archive, install, or claim release acceptance.
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSCommandPath
$tauriRoot = Join-Path $root 'apps\windows-client\src-tauri'

function Assert-NativeSuccess {
    param(
        [Parameter(Mandatory = $true)][string]$Step,
        [Parameter(Mandatory = $true)][int]$ExitCode
    )
    if ($ExitCode -ne 0) {
        throw "$Step failed with exit code $ExitCode"
    }
}

Set-Location -LiteralPath $root

Write-Host '[build2] 1/3 canonical full local source gate'
& python -X utf8 scripts/quality_gate.py --level full
Assert-NativeSuccess -Step 'full local source gate' -ExitCode $LASTEXITCODE

Write-Host '[build2] 2/3 canonical Host SEA build'
& npm run build:host
Assert-NativeSuccess -Step 'npm run build:host' -ExitCode $LASTEXITCODE

Write-Host '[build2] 3/3 canonical Tauri package build'
Push-Location -LiteralPath $tauriRoot
try {
    & cargo tauri build --ci --bundles nsis --no-sign -- --locked
    Assert-NativeSuccess -Step 'cargo tauri build --ci --bundles nsis --no-sign -- --locked' -ExitCode $LASTEXITCODE
} finally {
    Pop-Location
}

Write-Host '[build2] Local source gate and unsigned desktop package build completed.'
Write-Warning '[build2] Release acceptance remains pending: installed-tauri smoke and trusted signing verification.'
