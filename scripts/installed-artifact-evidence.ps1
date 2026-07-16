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

function Get-KcwInstallerFrozenEvidence {
    param([Parameter(Mandatory = $true)][string]$InstallerPath)

    # 从 NSIS 安装包解出 desktop/sidecar 两个 exe,作为"安装完整性"的冻结基准。
    $sevenZip = "C:\Program Files\7-Zip\7z.exe"
    if (-not (Test-Path -LiteralPath $sevenZip -PathType Leaf)) {
        throw "7-Zip not found at $sevenZip; it is required to extract the frozen installer contents"
    }
    if (-not (Test-Path -LiteralPath $InstallerPath -PathType Leaf)) {
        throw "Installer not found: $InstallerPath"
    }
    $extractDir = Join-Path ([System.IO.Path]::GetTempPath()) ("acw-frozen-" + [System.Guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $extractDir | Out-Null
    try {
        & $sevenZip x "-o$extractDir" -y $InstallerPath "agent-cowork-desktop.exe" "agent-cowork-host.exe" | Out-Null
        if ($LASTEXITCODE -ne 0) {
            throw "7-Zip failed to extract the installer (exit $LASTEXITCODE): $InstallerPath"
        }
        $desktop = Get-ChildItem -Path $extractDir -Recurse -Filter "agent-cowork-desktop.exe" | Select-Object -First 1
        $sidecarItem = Get-ChildItem -Path $extractDir -Recurse -Filter "agent-cowork-host.exe" | Select-Object -First 1
        if ($null -eq $desktop) { throw "agent-cowork-desktop.exe not found inside the installer" }
        if ($null -eq $sidecarItem) { throw "agent-cowork-host.exe not found inside the installer" }
        return [ordered]@{
            desktop = Get-KcwArtifactEvidence -Path $desktop.FullName
            sidecar = Get-KcwArtifactEvidence -Path $sidecarItem.FullName
        }
    } finally {
        Remove-Item -LiteralPath $extractDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}
