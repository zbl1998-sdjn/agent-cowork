[CmdletBinding()]
param(
    [string]$Version = "3.12.10",
    [ValidateSet("amd64")][string]$Arch = "amd64",
    [string]$Url = "",
    [string]$Sha256 = "156c7eea90d58cd7e91a23f28a0056616b13e9f4cf4901b7b99b837b7848c6da",
    [string]$TargetDir = "",
    [string]$CacheDir = "",
    [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Resolve-FullPath {
    param([Parameter(Mandatory = $true)][string]$Path)
    return [System.IO.Path]::GetFullPath($Path)
}

function Assert-Inside {
    param(
        [Parameter(Mandatory = $true)][string]$Child,
        [Parameter(Mandatory = $true)][string]$Parent,
        [Parameter(Mandatory = $true)][string]$Label
    )
    $childFull = Resolve-FullPath -Path $Child
    $parentFull = (Resolve-FullPath -Path $Parent).TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
    $prefix = $parentFull + [System.IO.Path]::DirectorySeparatorChar
    if (-not $childFull.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "$Label must stay inside $parentFull, got $childFull"
    }
}

function Get-ExpectedPythonArchiveName {
    param(
        [Parameter(Mandatory = $true)][string]$Version,
        [Parameter(Mandatory = $true)][string]$Arch
    )
    return "python-$Version-embeddable-$Arch.zip"
}

function Invoke-Download {
    param(
        [Parameter(Mandatory = $true)][string]$SourceUrl,
        [Parameter(Mandatory = $true)][string]$Destination
    )
    Write-Host "[python] download $SourceUrl"
    Invoke-WebRequest -Uri $SourceUrl -OutFile $Destination -UseBasicParsing
}

function Test-Sha256 {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $true)][string]$Expected
    )
    $actual = (Get-FileHash -LiteralPath $FilePath -Algorithm SHA256).Hash.ToLowerInvariant()
    $expectedLower = $Expected.ToLowerInvariant()
    if ($actual -ne $expectedLower) {
        throw "SHA256 mismatch for $FilePath. expected=$expectedLower actual=$actual"
    }
    return $actual
}

function Clear-TargetDirectory {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$AllowedRoot
    )
    Assert-Inside -Child $Path -Parent $AllowedRoot -Label "Embedded Python target"
    if (-not (Test-Path -LiteralPath $Path)) {
        New-Item -ItemType Directory -Path $Path | Out-Null
        return
    }
    Get-ChildItem -LiteralPath $Path -Force |
        Where-Object { $_.Name -ne "README.md" } |
        Remove-Item -Recurse -Force
}

function Update-PythonPathFile {
    param([Parameter(Mandatory = $true)][string]$PythonHome)

    $pth = Get-ChildItem -LiteralPath $PythonHome -Filter "python*._pth" -File | Select-Object -First 1
    if ($null -eq $pth) {
        throw "Embedded Python ._pth file not found under $PythonHome"
    }
    $lines = Get-Content -LiteralPath $pth.FullName
    if (-not ($lines -contains "Lib\site-packages")) {
        $insertAt = [Math]::Max(0, $lines.Count - 1)
        $updated = @()
        if ($insertAt -gt 0) {
            $updated += $lines[0..($insertAt - 1)]
        }
        $updated += "Lib\site-packages"
        $updated += $lines[$insertAt..($lines.Count - 1)]
        Set-Content -LiteralPath $pth.FullName -Encoding ascii -Value $updated
    }
}

function Test-EmbeddedPython {
    param([Parameter(Mandatory = $true)][string]$PythonExe)

    $probe = "import json,sys; print(json.dumps({'version':sys.version.split()[0],'executable':sys.executable,'prefix':sys.prefix}, ensure_ascii=True))"
    $output = & $PythonExe -I -c $probe 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "Embedded Python probe failed: $output"
    }
    return ($output | Select-Object -First 1)
}

$scriptDir = Split-Path -Parent $PSCommandPath
$repoRoot = Split-Path -Parent $scriptDir
$resourceRoot = Join-Path $repoRoot "apps\windows-client\resources"
if ([string]::IsNullOrWhiteSpace($TargetDir)) {
    $TargetDir = Join-Path $resourceRoot "python-embedded"
}
if ([string]::IsNullOrWhiteSpace($CacheDir)) {
    $CacheDir = Join-Path $repoRoot "build\cache\python"
}
if ([string]::IsNullOrWhiteSpace($Url)) {
    $Url = "https://www.python.org/ftp/python/$Version/$(Get-ExpectedPythonArchiveName -Version $Version -Arch $Arch)"
}

Assert-Inside -Child $TargetDir -Parent $resourceRoot -Label "Embedded Python target"
Assert-Inside -Child $CacheDir -Parent (Join-Path $repoRoot "build") -Label "Embedded Python cache"

New-Item -ItemType Directory -Path $CacheDir -Force | Out-Null
$archivePath = Join-Path $CacheDir (Split-Path -Leaf $Url)
if ($Force -or -not (Test-Path -LiteralPath $archivePath)) {
    Invoke-Download -SourceUrl $Url -Destination $archivePath
}
$actualSha = Test-Sha256 -FilePath $archivePath -Expected $Sha256

Clear-TargetDirectory -Path $TargetDir -AllowedRoot $resourceRoot
Expand-Archive -LiteralPath $archivePath -DestinationPath $TargetDir -Force
New-Item -ItemType Directory -Path (Join-Path $TargetDir "Lib\site-packages") -Force | Out-Null
Update-PythonPathFile -PythonHome $TargetDir

$pythonExe = Join-Path $TargetDir "python.exe"
if (-not (Test-Path -LiteralPath $pythonExe)) {
    throw "Embedded Python executable missing after extract: $pythonExe"
}
$probeJson = Test-EmbeddedPython -PythonExe $pythonExe
$probe = $probeJson | ConvertFrom-Json
if ($probe.version -ne $Version) {
    throw "Embedded Python version mismatch. expected=$Version actual=$($probe.version)"
}

$manifest = [ordered]@{
    id = "python-embedded"
    version = $Version
    arch = $Arch
    sourceUrl = $Url
    sha256 = $actualSha
    targetDir = $TargetDir
    pythonExe = $pythonExe
    generatedAt = (Get-Date).ToUniversalTime().ToString("o")
    probe = $probe
}
$manifestPath = Join-Path $TargetDir "PYTHON_EMBEDDED_MANIFEST.json"
$manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $manifestPath -Encoding utf8
Write-Host "[python] staged $Version ($Arch) -> $TargetDir"
Write-Host "[python] sha256 $actualSha"
