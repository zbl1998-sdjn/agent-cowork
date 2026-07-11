Set-StrictMode -Version Latest

function Get-KcwArtifactEvidence {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Artifact file not found: $Path"
    }
    $resolved = (Resolve-Path -LiteralPath $Path).Path
    $item = Get-Item -LiteralPath $resolved
    return [ordered]@{
        path = $resolved
        bytes = $item.Length
        sha256 = (Get-FileHash -LiteralPath $resolved -Algorithm SHA256).Hash.ToUpperInvariant()
        ProductVersion = [string]$item.VersionInfo.ProductVersion
        FileVersion = [string]$item.VersionInfo.FileVersion
    }
}

function Assert-KcwArtifactVersion {
    param(
        [Parameter(Mandatory = $true)]$Evidence,
        [Parameter(Mandatory = $true)][string]$ExpectedVersion,
        [Parameter(Mandatory = $true)][string]$Label
    )

    if ([string]$Evidence.ProductVersion -ne $ExpectedVersion) {
        throw "$Label ProductVersion '$($Evidence.ProductVersion)' does not match ExpectedVersion '$ExpectedVersion'"
    }
    if ([string]$Evidence.FileVersion -ne $ExpectedVersion) {
        throw "$Label FileVersion '$($Evidence.FileVersion)' does not match ExpectedVersion '$ExpectedVersion'"
    }
}

function Assert-KcwArtifactSha256 {
    param(
        [Parameter(Mandatory = $true)][string]$Actual,
        [Parameter(Mandatory = $true)][string]$Expected,
        [Parameter(Mandatory = $true)][string]$Label
    )

    if ($Expected -notmatch '^[0-9A-Fa-f]{64}$') {
        throw "$Label expected SHA256 is invalid"
    }
    if (-not $Actual.Equals($Expected, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "$Label SHA256 does not match the frozen build artifact"
    }
}

function Resolve-KcwExpectedVersion {
    param(
        [Parameter(Mandatory = $true)][string]$RepoRoot,
        [string]$RequestedVersion
    )

    $configPath = Join-Path $RepoRoot 'apps\windows-client\src-tauri\tauri.conf.json'
    if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
        throw "Tauri config not found: $configPath"
    }
    $configuredVersion = [string]((Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json).version)
    $resolved = if ([string]::IsNullOrWhiteSpace($RequestedVersion)) { $configuredVersion } else { $RequestedVersion.Trim() }
    if ($resolved -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$') {
        throw "ExpectedVersion is not valid SemVer: $resolved"
    }
    if ($configuredVersion -ne $resolved) {
        throw "Tauri version '$configuredVersion' does not match ExpectedVersion '$resolved'"
    }
    return $resolved
}

function Get-KcwSourceCommit {
    param([Parameter(Mandatory = $true)][string]$RepoRoot)

    $safeRoot = [System.IO.Path]::GetFullPath($RepoRoot).Replace('\', '/')
    $output = & git -c "safe.directory=$safeRoot" -C $RepoRoot rev-parse HEAD 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to resolve source commit: $output"
    }
    $commit = [string]($output | Select-Object -First 1)
    if ($commit -notmatch '^[0-9a-fA-F]{40}$') {
        throw "Resolved source commit is invalid: $commit"
    }
    return $commit.ToLowerInvariant()
}
