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
    $changed = $false
    if (-not ($lines -contains "Lib\site-packages")) {
        $lines = @($lines + "Lib\site-packages")
        $changed = $true
    }
    # Embedded Python ships with `#import site` commented out, which freezes
    # sys.path to just python312.zip + the ._pth entries — that means pip
    # CAN'T find its own modules even after `pip install`. Flip it to
    # `import site` so packages installed into Lib\site-packages are
    # actually importable.
    $hasImportSite = $false
    $resolved = @()
    foreach ($line in $lines) {
        if ($line -eq "import site") { $hasImportSite = $true }
        if ($line -eq "#import site") {
            $resolved += "import site"
            $hasImportSite = $true
            $changed = $true
        } else {
            $resolved += $line
        }
    }
    if (-not $hasImportSite) {
        $resolved += "import site"
        $changed = $true
    }
    if ($changed) {
        Set-Content -LiteralPath $pth.FullName -Encoding ascii -Value $resolved
    }
}

function Install-PipBootstrap {
    param(
        [Parameter(Mandatory = $true)][string]$PythonExe,
        [Parameter(Mandatory = $true)][string]$CacheDir
    )
    # Embedded Python doesn't ship pip. Bootstrap it via the official get-pip.py
    # shim — kept in our cache after first download to keep subsequent runs
    # offline-friendly.
    $getPipPath = Join-Path $CacheDir "get-pip.py"
    if (-not (Test-Path -LiteralPath $getPipPath)) {
        Write-Host "[python] download get-pip.py"
        Invoke-WebRequest -Uri "https://bootstrap.pypa.io/get-pip.py" -OutFile $getPipPath -UseBasicParsing
    }
    Write-Host "[python] bootstrap pip via get-pip.py"
    & $PythonExe $getPipPath --no-warn-script-location 2>&1 | Tee-Object -Variable getPipOutput | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "Bootstrapping pip failed (exit $LASTEXITCODE)`n$($getPipOutput -join "`n")"
    }
}

function Install-RequirementsLock {
    param(
        [Parameter(Mandatory = $true)][string]$PythonExe,
        [Parameter(Mandatory = $true)][string]$RequirementsPath
    )
    if (-not (Test-Path -LiteralPath $RequirementsPath)) {
        Write-Host "[python] no requirements.lock; skipping bulk install"
        return @()
    }
    Write-Host "[python] pip install -r $RequirementsPath"
    & $PythonExe -m pip install --no-warn-script-location --disable-pip-version-check -r $RequirementsPath 2>&1 | Tee-Object -Variable pipOutput | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "pip install -r requirements.lock failed (exit $LASTEXITCODE)`n$($pipOutput -join "`n")"
    }
    # Capture what actually got installed (resolved versions incl. transitive)
    # so the manifest can record it for audit.
    $listJson = & $PythonExe -m pip list --format=json --disable-pip-version-check 2>$null
    if ($LASTEXITCODE -ne 0) { return @() }
    return ($listJson | ConvertFrom-Json | ForEach-Object { @{ name = $_.name; version = $_.version } })
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

# Bootstrap pip + install the locked data-analysis packages. Skipping pip is
# what made `import pandas` fail inside sandbox.run-code — embedded Python
# zip ships stdlib-only.
$packages = @()
# requirements.lock lives in resources/ (sibling of python-embedded/) so the
# Clear-TargetDirectory pass above doesn't nuke it on every re-stage.
$requirementsPath = Join-Path $resourceRoot "python-packages.lock"
try {
    Install-PipBootstrap -PythonExe $pythonExe -CacheDir $CacheDir
    $installed = Install-RequirementsLock -PythonExe $pythonExe -RequirementsPath $requirementsPath
    # PowerShell collapses an empty array return into $null; coerce to array.
    $packages = @($installed)
    Write-Host "[python] installed $($packages.Count) packages (incl. transitive deps)"
} catch {
    # Don't fail the whole bundle if pip install hits a network hiccup — the
    # embeddable still works for stdlib-only sandbox tasks. The agent will
    # surface ModuleNotFoundError gracefully via humanizeError on first use.
    Write-Warning "[python] package install failed; proceeding with stdlib only: $($_.Exception.Message)"
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
    packages = $packages
}
$manifestPath = Join-Path $TargetDir "PYTHON_EMBEDDED_MANIFEST.json"
$manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $manifestPath -Encoding utf8
Write-Host "[python] staged $Version ($Arch) -> $TargetDir"
Write-Host "[python] sha256 $actualSha"
