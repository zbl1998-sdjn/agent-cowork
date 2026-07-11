[CmdletBinding()]
param(
    [string]$Version = "3.12.10",
    [ValidateSet("amd64")][string]$Arch = "amd64",
    [string]$Url = "",
    [string]$Sha256 = "156c7eea90d58cd7e91a23f28a0056616b13e9f4cf4901b7b99b837b7848c6da",
    [string]$PipBootstrapLockPath = "",
    [ValidateRange(1, 300)][int]$DownloadTimeoutSec = 120,
    [ValidateRange(1, 300)][int]$LockTimeoutSec = 60,
    [ValidateRange(1, 1800)][int]$ProcessTimeoutSec = 300,
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

function Assert-SafePath {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$AllowedRoot,
        [Parameter(Mandatory = $true)][string]$Label,
        [switch]$AllowRoot
    )

    $pathFull = Resolve-FullPath -Path $Path
    $rootFull = (Resolve-FullPath -Path $AllowedRoot).TrimEnd(
        [System.IO.Path]::DirectorySeparatorChar,
        [System.IO.Path]::AltDirectorySeparatorChar
    )
    if (-not (Test-Path -LiteralPath $rootFull -PathType Container)) {
        throw "$Label allowed root does not exist: $rootFull"
    }
    $isAllowedRoot = $pathFull.Equals($rootFull, [System.StringComparison]::OrdinalIgnoreCase)
    if (-not ($AllowRoot -and $isAllowedRoot)) {
        Assert-Inside -Child $pathFull -Parent $rootFull -Label $Label
    }

    # String containment is insufficient on Windows: a junction anywhere in the
    # existing parent chain can redirect writes outside the lexical jail.
    $cursor = $pathFull
    while ($true) {
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force
            if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "$Label contains a reparse point: $cursor"
            }
        }
        $parent = Split-Path -Parent $cursor
        if ([string]::IsNullOrWhiteSpace($parent) -or $parent.Equals($cursor, [System.StringComparison]::OrdinalIgnoreCase)) {
            break
        }
        $cursor = $parent
    }
}

function Assert-SafeDirectoryTree {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$AllowedRoot,
        [Parameter(Mandatory = $true)][string]$Label
    )

    Assert-SafePath -Path $Path -AllowedRoot $AllowedRoot -Label $Label
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
        throw "$Label directory does not exist: $Path"
    }
    $pending = [System.Collections.Generic.Stack[string]]::new()
    $pending.Push((Resolve-FullPath -Path $Path))
    while ($pending.Count -gt 0) {
        $directory = $pending.Pop()
        foreach ($child in Get-ChildItem -LiteralPath $directory -Force) {
            if (($child.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "$Label contains a reparse point: $($child.FullName)"
            }
            if ($child.PSIsContainer) {
                $pending.Push($child.FullName)
            }
        }
    }
}

function Remove-SafeTransactionDirectory {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$AllowedRoot
    )

    $leaf = Split-Path -Leaf $Path
    if ($leaf -notmatch '^\..+\.(staging|previous)-[a-zA-Z0-9-]+$') {
        throw "Refusing to remove a non-transaction directory: $Path"
    }
    if (-not (Test-Path -LiteralPath $Path)) {
        return
    }
    Assert-SafeDirectoryTree -Path $Path -AllowedRoot $AllowedRoot -Label "Embedded Python transaction cleanup"
    Remove-Item -LiteralPath $Path -Recurse -Force
}

function Publish-StagedDirectory {
    param(
        [Parameter(Mandatory = $true)][string]$StagingDir,
        [Parameter(Mandatory = $true)][string]$TargetDir,
        [Parameter(Mandatory = $true)][string]$AllowedRoot,
        [Parameter(Mandatory = $true)][scriptblock]$PublishedValidator
    )

    $StagingDir = Resolve-FullPath -Path $StagingDir
    $TargetDir = Resolve-FullPath -Path $TargetDir
    $targetParent = Split-Path -Parent $TargetDir
    $stagingParent = Split-Path -Parent $StagingDir
    if (-not $stagingParent.Equals($targetParent, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Embedded Python staging directory must be a sibling of the target"
    }
    Assert-SafeDirectoryTree -Path $StagingDir -AllowedRoot $AllowedRoot -Label "Embedded Python staging directory"
    Assert-SafePath -Path $TargetDir -AllowedRoot $AllowedRoot -Label "Embedded Python target"
    if (Test-Path -LiteralPath $TargetDir) {
        Assert-SafeDirectoryTree -Path $TargetDir -AllowedRoot $AllowedRoot -Label "Existing embedded Python target"
    }

    $targetLeaf = Split-Path -Leaf $TargetDir
    $BackupDir = Join-Path $targetParent (".$targetLeaf.previous-" + [guid]::NewGuid().ToString("N"))
    Assert-SafePath -Path $BackupDir -AllowedRoot $AllowedRoot -Label "Embedded Python rollback directory"
    $movedOriginal = $false
    $published = $false
    try {
        if (Test-Path -LiteralPath $TargetDir) {
            [System.IO.Directory]::Move($TargetDir, $BackupDir)
            $movedOriginal = $true
        }
        [System.IO.Directory]::Move($StagingDir, $TargetDir)
        $published = $true
        & $PublishedValidator $TargetDir | Out-Null
    } catch {
        $publishFailure = $_
        $rollbackFailures = [System.Collections.Generic.List[string]]::new()
        if ($published -and (Test-Path -LiteralPath $TargetDir)) {
            try {
                Assert-SafeDirectoryTree -Path $TargetDir -AllowedRoot $AllowedRoot -Label "Failed embedded Python publication"
                [System.IO.Directory]::Move($TargetDir, $StagingDir)
            } catch {
                $rollbackFailures.Add("could not move failed runtime back to staging: $($_.Exception.Message)")
            }
        }
        if ($movedOriginal -and (Test-Path -LiteralPath $BackupDir) -and -not (Test-Path -LiteralPath $TargetDir)) {
            try {
                [System.IO.Directory]::Move($BackupDir, $TargetDir)
            } catch {
                $rollbackFailures.Add("could not restore prior runtime: $($_.Exception.Message)")
            }
        }
        if ($rollbackFailures.Count -gt 0) {
            throw "Embedded Python publication failed ($($publishFailure.Exception.Message)); rollback also failed: $($rollbackFailures -join '; ')"
        }
        throw $publishFailure
    }

    if ($movedOriginal -and (Test-Path -LiteralPath $BackupDir)) {
        try {
            Remove-SafeTransactionDirectory -Path $BackupDir -AllowedRoot $AllowedRoot
        } catch {
            # Publication is already valid and cannot be reversed safely after a
            # partial recursive cleanup. Surface the retained backup explicitly.
            Write-Warning "Embedded Python published, but prior runtime cleanup failed; retained $BackupDir`: $($_.Exception.Message)"
        }
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
        [Parameter(Mandatory = $true)][string]$Destination,
        [Parameter(Mandatory = $true)][int]$TimeoutSec
    )
    Write-Host "[python] download $SourceUrl"
    Invoke-WebRequest -Uri $SourceUrl -OutFile $Destination -UseBasicParsing -TimeoutSec $TimeoutSec
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

function Enter-EmbeddedPythonLock {
    param(
        [Parameter(Mandatory = $true)][string]$LockPath,
        [Parameter(Mandatory = $true)][string]$AllowedRoot,
        [Parameter(Mandatory = $true)][int]$TimeoutSec
    )

    Assert-SafePath -Path $LockPath -AllowedRoot $AllowedRoot -Label "Embedded Python operation lock"
    $clock = [System.Diagnostics.Stopwatch]::StartNew()
    while ($true) {
        try {
            return [System.IO.File]::Open(
                $LockPath,
                [System.IO.FileMode]::OpenOrCreate,
                [System.IO.FileAccess]::ReadWrite,
                [System.IO.FileShare]::None
            )
        } catch [System.IO.IOException] {
            if ($clock.Elapsed.TotalSeconds -ge $TimeoutSec) {
                throw "Timed out acquiring embedded Python operation lock after $TimeoutSec seconds: $LockPath"
            }
            Start-Sleep -Milliseconds 100
        }
    }
}

function Exit-EmbeddedPythonLock {
    param([Parameter(Mandatory = $true)][System.IDisposable]$LockHandle)
    $LockHandle.Dispose()
}

function Invoke-BoundedProcess {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [Parameter(Mandatory = $true)][int]$TimeoutSec,
        [Parameter(Mandatory = $true)][string]$Label
    )

    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $FilePath
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    foreach ($argument in $Arguments) {
        $startInfo.ArgumentList.Add($argument)
    }

    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    try {
        if (-not $process.Start()) {
            throw "$Label failed to start: $FilePath"
        }
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit($TimeoutSec * 1000)) {
            try {
                $process.Kill($true)
            } catch {
                throw "$Label timed out after $TimeoutSec seconds and process-tree termination failed: $($_.Exception.Message)"
            }
            if (-not $process.WaitForExit(5000)) {
                throw "$Label timed out after $TimeoutSec seconds and did not exit after termination"
            }
            throw "$Label timed out after $TimeoutSec seconds"
        }
        $stdout = $stdoutTask.GetAwaiter().GetResult()
        $stderr = $stderrTask.GetAwaiter().GetResult()
        $outputLines = @($stdout.TrimEnd(), $stderr.TrimEnd()) |
            Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
        return [pscustomobject]@{
            ExitCode = $process.ExitCode
            Stdout = $stdout
            Stderr = $stderr
            Output = ($outputLines -join "`n")
        }
    } finally {
        $process.Dispose()
    }
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

function Get-PipBootstrapLock {
    param(
        [Parameter(Mandatory = $true)][string]$LockPath
    )

    if (-not (Test-Path -LiteralPath $LockPath -PathType Leaf)) {
        throw "Pinned pip bootstrap lock is missing: $LockPath"
    }
    $lockText = Get-Content -Raw -LiteralPath $LockPath
    $schemaMatches = [regex]::Matches($lockText, '(?m)^# schema: (?<schema>[0-9]+)\s*$')
    $sourceMatches = [regex]::Matches($lockText, '(?m)^# source-url: (?<url>\S+)\s*$')
    $activeLines = @(
        $lockText -split "`r?`n" |
            Where-Object { -not [string]::IsNullOrWhiteSpace($_) -and -not $_.StartsWith('#') }
    )
    if ($schemaMatches.Count -ne 1 -or $schemaMatches[0].Groups['schema'].Value -ne '1') {
        throw "Pip bootstrap lock must declare exactly '# schema: 1': $LockPath"
    }
    if ($sourceMatches.Count -ne 1 -or $activeLines.Count -ne 2) {
        throw "Pip bootstrap lock must contain one source URL and one exact hashed pip requirement: $LockPath"
    }

    $pin = [regex]::Match($activeLines[0], '^pip==(?<version>[0-9]+(?:\.[0-9]+){2}) \\$')
    $hash = [regex]::Match($activeLines[1], '^\s+--hash=sha256:(?<sha>[a-f0-9]{64})$')
    if (-not $pin.Success -or -not $hash.Success) {
        throw "Pip bootstrap lock must use an exact pip==X.Y.Z pin and one SHA256 hash: $LockPath"
    }

    $version = $pin.Groups['version'].Value
    $sourceUrl = $sourceMatches[0].Groups['url'].Value
    try {
        $sourceUri = [uri]$sourceUrl
    } catch {
        throw "Pip bootstrap wheel URL is invalid: $sourceUrl"
    }
    if (-not $sourceUri.IsAbsoluteUri -or
        $sourceUri.Scheme -cne 'https' -or
        $sourceUri.Host -cne 'files.pythonhosted.org' -or
        -not [string]::IsNullOrEmpty($sourceUri.Query) -or
        -not [string]::IsNullOrEmpty($sourceUri.Fragment)) {
        throw "Pip bootstrap wheel must use an exact HTTPS files.pythonhosted.org URL without query or fragment"
    }
    $fileName = [System.IO.Path]::GetFileName($sourceUri.AbsolutePath)
    $expectedFileName = "pip-$version-py3-none-any.whl"
    if ($fileName -cne $expectedFileName) {
        throw "Pip bootstrap wheel filename mismatch. expected=$expectedFileName actual=$fileName"
    }

    return [pscustomobject]@{
        LockPath = Resolve-FullPath -Path $LockPath
        LockSha256 = (Get-FileHash -LiteralPath $LockPath -Algorithm SHA256).Hash.ToLowerInvariant()
        Version = $version
        Requirement = "pip==$version"
        SourceUrl = $sourceUrl
        FileName = $fileName
        Sha256 = $hash.Groups['sha'].Value
    }
}

function Get-VerifiedPipBootstrapWheel {
    param(
        [Parameter(Mandatory = $true)][object]$PipBootstrap,
        [Parameter(Mandatory = $true)][string]$CacheDir,
        [Parameter(Mandatory = $true)][int]$DownloadTimeoutSec,
        [switch]$Force
    )

    $wheelCacheRoot = Join-Path $CacheDir 'pip-bootstrap'
    Assert-SafePath -Path $wheelCacheRoot -AllowedRoot $CacheDir -Label "Pip bootstrap cache"
    New-Item -ItemType Directory -Path $wheelCacheRoot -Force | Out-Null
    Assert-SafePath -Path $wheelCacheRoot -AllowedRoot $CacheDir -Label "Pip bootstrap cache"

    # A digest-specific directory makes the wheelhouse immutable by identity and
    # avoids deleting or reusing artifacts from a different bootstrap lock.
    $wheelhouse = Join-Path $wheelCacheRoot ([string]$PipBootstrap.Sha256)
    Assert-SafePath -Path $wheelhouse -AllowedRoot $wheelCacheRoot -Label "Pip bootstrap wheelhouse"
    New-Item -ItemType Directory -Path $wheelhouse -Force | Out-Null
    Assert-SafeDirectoryTree -Path $wheelhouse -AllowedRoot $wheelCacheRoot -Label "Pip bootstrap wheelhouse"
    $wheelPath = Join-Path $wheelhouse ([string]$PipBootstrap.FileName)
    Assert-SafePath -Path $wheelPath -AllowedRoot $wheelhouse -Label "Pip bootstrap wheel"

    if ($Force -or -not (Test-Path -LiteralPath $wheelPath -PathType Leaf)) {
        $temporaryPath = Join-Path $wheelhouse (".$($PipBootstrap.FileName).download-" + [guid]::NewGuid().ToString('N'))
        Assert-SafePath -Path $temporaryPath -AllowedRoot $wheelhouse -Label "Pip bootstrap temporary download"
        try {
            Invoke-Download -SourceUrl $PipBootstrap.SourceUrl -Destination $temporaryPath -TimeoutSec $DownloadTimeoutSec
            Test-Sha256 -FilePath $temporaryPath -Expected $PipBootstrap.Sha256 | Out-Null
            [System.IO.File]::Move($temporaryPath, $wheelPath, $true)
        } finally {
            if (Test-Path -LiteralPath $temporaryPath) {
                Assert-SafePath -Path $temporaryPath -AllowedRoot $wheelhouse -Label "Pip bootstrap temporary cleanup"
                Remove-Item -LiteralPath $temporaryPath -Force
            }
        }
    }

    Assert-SafeDirectoryTree -Path $wheelhouse -AllowedRoot $wheelCacheRoot -Label "Pip bootstrap wheelhouse"
    $entries = @(Get-ChildItem -LiteralPath $wheelhouse -Force)
    if ($entries.Count -ne 1 -or $entries[0].PSIsContainer -or $entries[0].Name -cne $PipBootstrap.FileName) {
        throw "Pip bootstrap wheelhouse must contain exactly the locked wheel: $wheelhouse"
    }
    Test-Sha256 -FilePath $wheelPath -Expected $PipBootstrap.Sha256 | Out-Null
    return $wheelPath
}

function Expand-PipBootstrapWheel {
    param(
        [Parameter(Mandatory = $true)][string]$PythonExe,
        [Parameter(Mandatory = $true)][string]$WheelPath,
        [Parameter(Mandatory = $true)][object]$PipBootstrap
    )

    # Validate the immutable artifact before looking at the destination so a
    # tampered cache entry always fails at the supply-chain boundary first.
    Test-Sha256 -FilePath $WheelPath -Expected $PipBootstrap.Sha256 | Out-Null
    if ((Split-Path -Leaf $WheelPath) -cne [string]$PipBootstrap.FileName) {
        throw "Pip bootstrap wheel filename does not match the lock: $WheelPath"
    }

    $pythonExeFull = Resolve-FullPath -Path $PythonExe
    if (-not (Test-Path -LiteralPath $pythonExeFull -PathType Leaf)) {
        throw "Embedded Python executable is missing before pip bootstrap: $pythonExeFull"
    }
    $pythonHome = Split-Path -Parent $pythonExeFull
    $sitePackages = Join-Path $pythonHome 'Lib\site-packages'
    if (-not (Test-Path -LiteralPath $sitePackages -PathType Container)) {
        throw "Embedded Python site-packages is missing before pip bootstrap: $sitePackages"
    }
    Assert-SafeDirectoryTree -Path $sitePackages -AllowedRoot $pythonHome -Label "Pip bootstrap site-packages"
    if (@(Get-ChildItem -LiteralPath $sitePackages -Force).Count -ne 0) {
        throw "Pip bootstrap requires an empty site-packages staging directory: $sitePackages"
    }

    $distInfoRoot = "pip-$($PipBootstrap.Version).dist-info"
    $requiredEntries = @(
        'pip/__init__.py',
        "$distInfoRoot/WHEEL",
        "$distInfoRoot/METADATA",
        "$distInfoRoot/RECORD"
    )
    $entryNames = [System.Collections.Generic.HashSet[string]]::new(
        [System.StringComparer]::OrdinalIgnoreCase
    )
    $destinationPaths = [System.Collections.Generic.HashSet[string]]::new(
        [System.StringComparer]::OrdinalIgnoreCase
    )
    $extractionPlan = [System.Collections.Generic.List[object]]::new()
    $archive = $null
    try {
        $archive = [System.IO.Compression.ZipFile]::OpenRead($WheelPath)
        if ($archive.Entries.Count -lt $requiredEntries.Count -or $archive.Entries.Count -gt 2048) {
            throw "Pip bootstrap wheel has an unsafe entry count: $($archive.Entries.Count)"
        }

        [long]$totalUncompressedBytes = 0
        $wheelMetadata = $null
        $packageMetadata = $null
        foreach ($entry in $archive.Entries) {
            $entryName = [string]$entry.FullName
            if ([string]::IsNullOrWhiteSpace($entryName) -or
                [string]::IsNullOrEmpty([string]$entry.Name) -or
                $entryName.Contains('\') -or
                $entryName.StartsWith('/', [System.StringComparison]::Ordinal) -or
                $entryName -match '^[a-zA-Z]:' -or
                $entryName.Contains([char]0)) {
                throw "Pip bootstrap wheel contains an unsafe entry path: $entryName"
            }

            $segments = @($entryName -split '/')
            if ($segments.Count -lt 2 -or
                @($segments | Where-Object {
                    [string]::IsNullOrEmpty($_) -or
                    $_ -eq '.' -or
                    $_ -eq '..' -or
                    $_.Contains(':') -or
                    $_.EndsWith(' ', [System.StringComparison]::Ordinal) -or
                    $_.EndsWith('.', [System.StringComparison]::Ordinal)
                }).Count -gt 0) {
                throw "Pip bootstrap wheel contains an unsafe or traversal entry: $entryName"
            }
            if ($segments[0] -cne 'pip' -and $segments[0] -cne $distInfoRoot) {
                throw "Pip bootstrap wheel contains an unexpected root: $entryName"
            }

            $unixFileType = (([int64]$entry.ExternalAttributes -shr 16) -band 0xf000)
            $dosAttributes = ([int64]$entry.ExternalAttributes -band 0xffff)
            if (($unixFileType -ne 0 -and $unixFileType -ne 0x8000) -or
                ($dosAttributes -band [int][System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Pip bootstrap wheel contains a link or special entry: $entryName"
            }
            if ($entry.Length -lt 0 -or $entry.Length -gt 33554432) {
                throw "Pip bootstrap wheel entry exceeds the size limit: $entryName"
            }
            $totalUncompressedBytes += [long]$entry.Length
            if ($totalUncompressedBytes -gt 67108864) {
                throw "Pip bootstrap wheel exceeds the uncompressed size limit"
            }

            $destination = Join-Path $sitePackages ($segments -join [System.IO.Path]::DirectorySeparatorChar)
            Assert-SafePath -Path $destination -AllowedRoot $sitePackages -Label "Pip bootstrap wheel entry"
            if (-not $entryNames.Add($entryName) -or -not $destinationPaths.Add($destination)) {
                throw "Pip bootstrap wheel contains a duplicate entry: $entryName"
            }
            $extractionPlan.Add([pscustomobject]@{
                Entry = $entry
                Destination = $destination
            })

            if ($entryName -ceq "$distInfoRoot/WHEEL") {
                if ($entry.Length -gt 65536) {
                    throw "Pip bootstrap WHEEL metadata exceeds the size limit"
                }
                $reader = [System.IO.StreamReader]::new(
                    $entry.Open(),
                    [System.Text.UTF8Encoding]::new($false, $true),
                    $true
                )
                try {
                    $wheelMetadata = $reader.ReadToEnd()
                } finally {
                    $reader.Dispose()
                }
            } elseif ($entryName -ceq "$distInfoRoot/METADATA") {
                if ($entry.Length -gt 262144) {
                    throw "Pip bootstrap METADATA exceeds the size limit"
                }
                $reader = [System.IO.StreamReader]::new(
                    $entry.Open(),
                    [System.Text.UTF8Encoding]::new($false, $true),
                    $true
                )
                try {
                    $packageMetadata = $reader.ReadToEnd()
                } finally {
                    $reader.Dispose()
                }
            }
        }

        foreach ($requiredEntry in $requiredEntries) {
            if (-not $entryNames.Contains($requiredEntry)) {
                throw "Pip bootstrap wheel is missing required entry: $requiredEntry"
            }
        }
        if ($wheelMetadata -notmatch '(?im)^Wheel-Version:\s*1\.0\s*$' -or
            $wheelMetadata -notmatch '(?im)^Root-Is-Purelib:\s*true\s*$' -or
            $wheelMetadata -notmatch '(?im)^Tag:\s*py3-none-any\s*$') {
            throw "Pip bootstrap wheel must declare the locked purelib py3-none-any format"
        }
        $versionPattern = '(?im)^Version:\s*' + [regex]::Escape([string]$PipBootstrap.Version) + '\s*$'
        if ($packageMetadata -notmatch '(?im)^Name:\s*pip\s*$' -or
            $packageMetadata -notmatch $versionPattern) {
            throw "Pip bootstrap METADATA does not match $($PipBootstrap.Requirement)"
        }

        # All entries are validated before the first write, so a malicious path
        # cannot leave a partially extracted wheel in staging.
        foreach ($plannedEntry in $extractionPlan) {
            $parent = Split-Path -Parent ([string]$plannedEntry.Destination)
            [System.IO.Directory]::CreateDirectory($parent) | Out-Null
            Assert-SafePath -Path $parent -AllowedRoot $sitePackages -Label "Pip bootstrap wheel parent"
            $source = $plannedEntry.Entry.Open()
            $destinationStream = [System.IO.File]::Open(
                [string]$plannedEntry.Destination,
                [System.IO.FileMode]::CreateNew,
                [System.IO.FileAccess]::Write,
                [System.IO.FileShare]::None
            )
            try {
                $source.CopyTo($destinationStream)
            } finally {
                $destinationStream.Dispose()
                $source.Dispose()
            }
        }
    } finally {
        if ($null -ne $archive) {
            $archive.Dispose()
        }
    }

    Test-Sha256 -FilePath $WheelPath -Expected $PipBootstrap.Sha256 | Out-Null
    Assert-SafeDirectoryTree -Path $sitePackages -AllowedRoot $pythonHome -Label "Staged pip bootstrap"
    return $sitePackages
}

function Install-PipBootstrap {
    param(
        [Parameter(Mandatory = $true)][string]$PythonExe,
        [Parameter(Mandatory = $true)][string]$WheelPath,
        [Parameter(Mandatory = $true)][object]$PipBootstrap,
        [Parameter(Mandatory = $true)][int]$ProcessTimeoutSec
    )

    # Stage the purelib wheel first, then use the supported Python module entry
    # point to reinstall that same verified local artifact with normal pip
    # installation semantics.
    Expand-PipBootstrapWheel -PythonExe $PythonExe -WheelPath $WheelPath -PipBootstrap $PipBootstrap | Out-Null
    Write-Host "[python] bootstrap $($PipBootstrap.Requirement) from verified wheel"
    $result = Invoke-BoundedProcess -FilePath $PythonExe -Arguments @(
        "-I",
        "-m",
        "pip",
        "--isolated",
        "--disable-pip-version-check",
        "--no-input",
        "--no-cache-dir",
        "install",
        "--no-warn-script-location",
        "--no-index",
        "--no-deps",
        "--only-binary=:all:",
        "--force-reinstall",
        $WheelPath
    ) -TimeoutSec $ProcessTimeoutSec -Label "Bootstrapping pip"
    if ($result.ExitCode -ne 0) {
        throw "Bootstrapping pip failed (exit $($result.ExitCode))`n$($result.Output)"
    }
}

function ConvertTo-NormalizedPackageSet {
    param(
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][object[]]$Packages,
        [Parameter(Mandatory = $true)][string]$Label
    )

    $seen = [System.Collections.Generic.Dictionary[string, string]]::new(
        [System.StringComparer]::OrdinalIgnoreCase
    )
    foreach ($package in @($Packages)) {
        $rawName = [string]$package.name
        $version = [string]$package.version
        if ([string]::IsNullOrWhiteSpace($rawName) -or [string]::IsNullOrWhiteSpace($version)) {
            throw "$Label contains a package without a name or version"
        }
        $name = [regex]::Replace($rawName.Trim().ToLowerInvariant(), "[-_.]+", "-")
        if ($seen.ContainsKey($name)) {
            throw "$Label contains duplicate package name: $name"
        }
        $seen.Add($name, $version.Trim())
    }

    return @(
        $seen.GetEnumerator() |
            Sort-Object -Property Key |
            ForEach-Object { [pscustomobject]@{ name = $_.Key; version = $_.Value } }
    )
}

function Get-LockedPackageSet {
    param([Parameter(Mandatory = $true)][string]$RequirementsPath)

    if (-not (Test-Path -LiteralPath $RequirementsPath -PathType Leaf)) {
        throw "Pinned Python requirements lock is missing: $RequirementsPath"
    }
    $packages = [System.Collections.Generic.List[object]]::new()
    foreach ($line in Get-Content -LiteralPath $RequirementsPath) {
        if ($line -match '^\s*(?<name>[A-Za-z0-9][A-Za-z0-9._-]*)==(?<version>[^\s\\;]+)\s*\\?\s*$') {
            $packages.Add([pscustomobject]@{
                name = $Matches.name
                version = $Matches.version
            })
        }
    }
    if ($packages.Count -eq 0) {
        throw "Pinned Python requirements lock contains no exact package pins: $RequirementsPath"
    }
    return @(ConvertTo-NormalizedPackageSet -Packages $packages.ToArray() -Label "Python requirements lock")
}

function Assert-ExactPackageSet {
    param(
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][object[]]$ExpectedPackages,
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][object[]]$ActualPackages,
        [Parameter(Mandatory = $true)][string]$Label
    )

    $expected = @(ConvertTo-NormalizedPackageSet -Packages $ExpectedPackages -Label "$Label expected inventory")
    $actual = @(ConvertTo-NormalizedPackageSet -Packages $ActualPackages -Label "$Label actual inventory")
    $expectedJson = $expected | ConvertTo-Json -Compress
    $actualJson = $actual | ConvertTo-Json -Compress
    if ($expectedJson -cne $actualJson) {
        throw "$Label package inventory mismatch. expected=$expectedJson actual=$actualJson"
    }
}

function Assert-LockedPackageSet {
    param(
        [Parameter(Mandatory = $true)][object[]]$LockedPackages,
        [Parameter(Mandatory = $true)][object[]]$InstalledPackages,
        [Parameter(Mandatory = $true)][string]$PipVersion
    )

    $locked = @(ConvertTo-NormalizedPackageSet -Packages $LockedPackages -Label "Python requirements lock")
    $expected = [System.Collections.Generic.List[object]]::new()
    foreach ($package in $locked) {
        if ($package.name -eq 'pip') {
            throw "Application Python requirements lock must not redefine the pip bootstrap package"
        }
        $expected.Add($package)
    }
    if ([string]::IsNullOrWhiteSpace($PipVersion)) {
        throw "Pip bootstrap version is required for installed inventory validation"
    }
    $expected.Add([pscustomobject]@{ name = 'pip'; version = $PipVersion })
    Assert-ExactPackageSet -ExpectedPackages $expected.ToArray() -ActualPackages $InstalledPackages -Label "Python requirements and bootstrap locks"
}

function Get-InstalledPackageSet {
    param(
        [Parameter(Mandatory = $true)][string]$PythonExe,
        [Parameter(Mandatory = $true)][int]$ProcessTimeoutSec
    )

    $inventoryProbe = @(
        "import importlib.metadata as metadata",
        "import json",
        "packages = []",
        "for distribution in metadata.distributions():",
        "    name = distribution.metadata.get('Name')",
        "    version = distribution.version",
        "    if name and version:",
        "        packages.append({'name': name, 'version': str(version)})",
        "print(json.dumps(packages, separators=(',', ':')))"
    ) -join "`n"
    $importlibResult = Invoke-BoundedProcess -FilePath $PythonExe -Arguments @(
        "-I",
        "-c",
        $inventoryProbe
    ) -TimeoutSec $ProcessTimeoutSec -Label "Reading embedded Python importlib.metadata inventory"
    if ($importlibResult.ExitCode -ne 0) {
        throw "importlib.metadata inventory failed (exit $($importlibResult.ExitCode)): $($importlibResult.Output)"
    }

    $pipResult = Invoke-BoundedProcess -FilePath $PythonExe -Arguments @(
        "-I",
        "-m",
        "pip",
        "list",
        "--format=json",
        "--disable-pip-version-check"
    ) -TimeoutSec $ProcessTimeoutSec -Label "Reading embedded Python pip inventory"
    if ($pipResult.ExitCode -ne 0) {
        throw "pip inventory failed (exit $($pipResult.ExitCode)): $($pipResult.Output)"
    }

    try {
        $importlibPackages = @($importlibResult.Stdout | ConvertFrom-Json -ErrorAction Stop)
        $pipPackages = @($pipResult.Stdout | ConvertFrom-Json -ErrorAction Stop)
        Assert-ExactPackageSet -ExpectedPackages $importlibPackages -ActualPackages $pipPackages -Label "importlib.metadata and pip"
        return @(ConvertTo-NormalizedPackageSet -Packages $importlibPackages -Label "Installed Python inventory")
    } catch {
        throw "Installed Python package inventory is invalid: $($_.Exception.Message)"
    }
}

function Install-RequirementsLock {
    param(
        [Parameter(Mandatory = $true)][string]$PythonExe,
        [Parameter(Mandatory = $true)][string]$RequirementsPath,
        [Parameter(Mandatory = $true)][int]$ProcessTimeoutSec,
        [Parameter(Mandatory = $true)][string]$PipVersion
    )
    if (-not (Test-Path -LiteralPath $RequirementsPath)) {
        throw "Pinned Python requirements lock is missing: $RequirementsPath"
    }
    Write-Host "[python] pip install --require-hashes --only-binary=:all: -r $RequirementsPath"
    $installResult = Invoke-BoundedProcess -FilePath $PythonExe -Arguments @(
        "-I",
        "-m",
        "pip",
        "install",
        "--no-warn-script-location",
        "--disable-pip-version-check",
        "--require-hashes",
        "--only-binary=:all:",
        "-r",
        $RequirementsPath
    ) -TimeoutSec $ProcessTimeoutSec -Label "Installing embedded Python requirements"
    if ($installResult.ExitCode -ne 0) {
        throw "pip install -r requirements.lock failed (exit $($installResult.ExitCode))`n$($installResult.Output)"
    }
    $lockedPackages = @(Get-LockedPackageSet -RequirementsPath $RequirementsPath)
    $installedPackages = @(Get-InstalledPackageSet -PythonExe $PythonExe -ProcessTimeoutSec $ProcessTimeoutSec)
    Assert-LockedPackageSet -LockedPackages $lockedPackages -InstalledPackages $installedPackages -PipVersion $PipVersion
    return $installedPackages
}

function Test-EmbeddedPython {
    param(
        [Parameter(Mandatory = $true)][string]$PythonExe,
        [Parameter(Mandatory = $true)][int]$ProcessTimeoutSec
    )

    $probe = "import json,sys; print(json.dumps({'version':sys.version.split()[0],'executable':sys.executable,'prefix':sys.prefix}, ensure_ascii=True))"
    $result = Invoke-BoundedProcess -FilePath $PythonExe -Arguments @(
        "-I",
        "-c",
        $probe
    ) -TimeoutSec $ProcessTimeoutSec -Label "Probing embedded Python"
    if ($result.ExitCode -ne 0) {
        throw "Embedded Python probe failed (exit $($result.ExitCode)): $($result.Output)"
    }
    return ($result.Stdout -split "`r?`n" | Select-Object -First 1)
}

function Test-ReusableEmbeddedPython {
    param(
        [Parameter(Mandatory = $true)][string]$TargetDir,
        [Parameter(Mandatory = $true)][string]$Version,
        [Parameter(Mandatory = $true)][string]$Arch,
        [Parameter(Mandatory = $true)][string]$Url,
        [Parameter(Mandatory = $true)][string]$ArchiveSha,
        [Parameter(Mandatory = $true)][object]$PipBootstrap,
        [Parameter(Mandatory = $true)][string]$RequirementsPath,
        [Parameter(Mandatory = $true)][string]$RequirementsSha,
        [Parameter(Mandatory = $true)][int]$ProcessTimeoutSec
    )

    $pythonExe = Join-Path $TargetDir "python.exe"
    $manifestPath = Join-Path $TargetDir "PYTHON_EMBEDDED_MANIFEST.json"
    if (-not (Test-Path -LiteralPath $pythonExe -PathType Leaf) -or
        -not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
        Write-Host "[python] reuse miss: runtime executable or manifest is absent"
        return $false
    }

    try {
        $manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json -ErrorAction Stop
        $expectedTarget = Resolve-FullPath -Path $TargetDir
        $expectedPython = Resolve-FullPath -Path $pythonExe
        $expectedRequirements = Resolve-FullPath -Path $RequirementsPath
        $checks = [ordered]@{
            id = ([string]$manifest.id -eq "python-embedded")
            version = ([string]$manifest.version -eq $Version)
            arch = ([string]$manifest.arch -eq $Arch)
            sourceUrl = ([string]$manifest.sourceUrl -ceq $Url)
            archiveSha256 = ([string]$manifest.sha256).Equals($ArchiveSha, [System.StringComparison]::OrdinalIgnoreCase)
            pipBootstrapLockPath = (Resolve-FullPath -Path ([string]$manifest.pipBootstrap.lockPath)).Equals($PipBootstrap.LockPath, [System.StringComparison]::OrdinalIgnoreCase)
            pipBootstrapLockSha256 = ([string]$manifest.pipBootstrap.lockSha256).Equals($PipBootstrap.LockSha256, [System.StringComparison]::OrdinalIgnoreCase)
            pipBootstrapVersion = ([string]$manifest.pipBootstrap.version -ceq $PipBootstrap.Version)
            pipBootstrapRequirement = ([string]$manifest.pipBootstrap.requirement -ceq $PipBootstrap.Requirement)
            pipBootstrapInstaller = ([string]$manifest.pipBootstrap.installer -ceq 'verified-wheel-extract-and-pip')
            pipBootstrapWheelFileName = ([string]$manifest.pipBootstrap.wheel.fileName -ceq $PipBootstrap.FileName)
            pipBootstrapWheelSourceUrl = ([string]$manifest.pipBootstrap.wheel.sourceUrl -ceq $PipBootstrap.SourceUrl)
            pipBootstrapWheelSha256 = ([string]$manifest.pipBootstrap.wheel.sha256).Equals($PipBootstrap.Sha256, [System.StringComparison]::OrdinalIgnoreCase)
            requirementsPath = (Resolve-FullPath -Path ([string]$manifest.requirements.path)).Equals($expectedRequirements, [System.StringComparison]::OrdinalIgnoreCase)
            requirementsSha256 = ([string]$manifest.requirements.sha256).Equals($RequirementsSha, [System.StringComparison]::OrdinalIgnoreCase)
            targetDir = (Resolve-FullPath -Path ([string]$manifest.targetDir)).Equals($expectedTarget, [System.StringComparison]::OrdinalIgnoreCase)
            pythonExe = (Resolve-FullPath -Path ([string]$manifest.pythonExe)).Equals($expectedPython, [System.StringComparison]::OrdinalIgnoreCase)
            packages = (@($manifest.packages).Count -gt 0)
        }
    } catch {
        Write-Host "[python] reuse miss: manifest is invalid: $($_.Exception.Message)"
        return $false
    }

    $mismatches = @($checks.GetEnumerator() | Where-Object { -not $_.Value } | ForEach-Object { $_.Key })
    if ($mismatches.Count -gt 0) {
        Write-Host "[python] reuse miss: manifest mismatch: $($mismatches -join ', ')"
        return $false
    }

    try {
        $probeJson = Test-EmbeddedPython -PythonExe $pythonExe -ProcessTimeoutSec $ProcessTimeoutSec
        $probe = $probeJson | ConvertFrom-Json -ErrorAction Stop
        if ([string]$probe.version -ne $Version) {
            Write-Host "[python] reuse miss: runtime version is $($probe.version), expected $Version"
            return $false
        }
        $lockedPackages = @(Get-LockedPackageSet -RequirementsPath $RequirementsPath)
        $installedPackages = @(Get-InstalledPackageSet -PythonExe $pythonExe -ProcessTimeoutSec $ProcessTimeoutSec)
        Assert-ExactPackageSet -ExpectedPackages @($manifest.packages) -ActualPackages $installedPackages -Label "Embedded Python manifest"
        Assert-LockedPackageSet -LockedPackages $lockedPackages -InstalledPackages $installedPackages -PipVersion $PipBootstrap.Version
        $health = Invoke-BoundedProcess -FilePath $pythonExe -Arguments @(
            "-I",
            "-m",
            "pip",
            "check"
        ) -TimeoutSec $ProcessTimeoutSec -Label "Checking embedded Python dependencies"
        if ($health.ExitCode -ne 0) {
            Write-Host "[python] reuse miss: pip check failed: $($health.Output)"
            return $false
        }
    } catch {
        Write-Host "[python] reuse miss: runtime health check failed: $($_.Exception.Message)"
        return $false
    }

    Write-Host "[python] reuse hit: verified existing embedded Python runtime"
    return $true
}

$scriptDir = Split-Path -Parent $PSCommandPath
$repoRoot = Split-Path -Parent $scriptDir
$resourceRoot = Resolve-FullPath -Path (Join-Path $repoRoot "apps\windows-client\resources")
$buildRoot = Resolve-FullPath -Path (Join-Path $repoRoot "build")
Assert-SafePath -Path $buildRoot -AllowedRoot $repoRoot -Label "Embedded Python build root"
New-Item -ItemType Directory -Path $buildRoot -Force | Out-Null
Assert-SafePath -Path $buildRoot -AllowedRoot $repoRoot -Label "Embedded Python build root"
if ([string]::IsNullOrWhiteSpace($TargetDir)) {
    $TargetDir = Join-Path $resourceRoot "python-embedded"
}
if ([string]::IsNullOrWhiteSpace($CacheDir)) {
    $CacheDir = Join-Path $repoRoot "build\cache\python"
}
if ([string]::IsNullOrWhiteSpace($PipBootstrapLockPath)) {
    $PipBootstrapLockPath = Join-Path $resourceRoot "python-bootstrap.lock"
}
if ([string]::IsNullOrWhiteSpace($Url)) {
    $Url = "https://www.python.org/ftp/python/$Version/$(Get-ExpectedPythonArchiveName -Version $Version -Arch $Arch)"
}
$TargetDir = Resolve-FullPath -Path $TargetDir
$CacheDir = Resolve-FullPath -Path $CacheDir
$PipBootstrapLockPath = Resolve-FullPath -Path $PipBootstrapLockPath

$lockRoot = Join-Path $buildRoot "locks"
Assert-SafePath -Path $lockRoot -AllowedRoot $buildRoot -Label "Embedded Python lock directory"
New-Item -ItemType Directory -Path $lockRoot -Force | Out-Null
Assert-SafePath -Path $lockRoot -AllowedRoot $buildRoot -Label "Embedded Python lock directory"
$lockPath = Join-Path $lockRoot "embedded-python.lock"
$operationLock = Enter-EmbeddedPythonLock -LockPath $lockPath -AllowedRoot $lockRoot -TimeoutSec $LockTimeoutSec
try {
Assert-SafePath -Path $TargetDir -AllowedRoot $resourceRoot -Label "Embedded Python target"
if (Test-Path -LiteralPath $TargetDir) {
    Assert-SafeDirectoryTree -Path $TargetDir -AllowedRoot $resourceRoot -Label "Existing embedded Python target"
}
$targetParent = Split-Path -Parent $TargetDir
Assert-SafePath -Path $targetParent -AllowedRoot $resourceRoot -Label "Embedded Python target parent" -AllowRoot
New-Item -ItemType Directory -Path $targetParent -Force | Out-Null
Assert-SafePath -Path $targetParent -AllowedRoot $resourceRoot -Label "Embedded Python target parent" -AllowRoot

Assert-SafePath -Path $CacheDir -AllowedRoot $buildRoot -Label "Embedded Python cache"
New-Item -ItemType Directory -Path $CacheDir -Force | Out-Null
Assert-SafePath -Path $CacheDir -AllowedRoot $buildRoot -Label "Embedded Python cache"
$archivePath = Join-Path $CacheDir (Split-Path -Leaf $Url)
Assert-SafePath -Path $archivePath -AllowedRoot $buildRoot -Label "Embedded Python archive"
if ($Force -or -not (Test-Path -LiteralPath $archivePath)) {
    Invoke-Download -SourceUrl $Url -Destination $archivePath -TimeoutSec $DownloadTimeoutSec
}
Assert-SafePath -Path $archivePath -AllowedRoot $buildRoot -Label "Embedded Python archive"
$actualSha = Test-Sha256 -FilePath $archivePath -Expected $Sha256

$requirementsPath = Join-Path $resourceRoot "python-packages.lock"
Assert-SafePath -Path $requirementsPath -AllowedRoot $resourceRoot -Label "Embedded Python requirements lock"
if (-not (Test-Path -LiteralPath $requirementsPath -PathType Leaf)) {
    throw "Pinned Python requirements lock is missing: $requirementsPath"
}
$requirementsSha = (Get-FileHash -LiteralPath $requirementsPath -Algorithm SHA256).Hash.ToLowerInvariant()
$pipBootstrapLock = Get-PipBootstrapLock -LockPath $PipBootstrapLockPath
Assert-SafePath -Path $pipBootstrapLock.LockPath -AllowedRoot $resourceRoot -Label "Pip bootstrap lock"

$reuseParameters = @{
    TargetDir = $TargetDir
    Version = $Version
    Arch = $Arch
    Url = $Url
    ArchiveSha = $actualSha
    PipBootstrap = $pipBootstrapLock
    RequirementsPath = $requirementsPath
    RequirementsSha = $requirementsSha
    ProcessTimeoutSec = $ProcessTimeoutSec
}
if (-not $Force -and (Test-ReusableEmbeddedPython @reuseParameters)) {
    Write-Host "[python] staged $Version ($Arch) -> $TargetDir (reused)"
    Write-Host "[python] sha256 $actualSha"
    return
}

$targetLeaf = Split-Path -Leaf $TargetDir
$stagingDir = Join-Path $targetParent (".$targetLeaf.staging-" + [guid]::NewGuid().ToString("N"))
Assert-SafePath -Path $stagingDir -AllowedRoot $resourceRoot -Label "Embedded Python staging directory"
$operationFailure = $null
try {
    New-Item -ItemType Directory -Path $stagingDir | Out-Null
    Assert-SafeDirectoryTree -Path $stagingDir -AllowedRoot $resourceRoot -Label "Embedded Python staging directory"

    # Preserve the tracked resource README while replacing only generated
    # payload. It is copied into staging before any formal target is moved.
    $readmePath = Join-Path $TargetDir "README.md"
    if (Test-Path -LiteralPath $readmePath) {
        Assert-SafePath -Path $readmePath -AllowedRoot $resourceRoot -Label "Embedded Python README"
        if (-not (Test-Path -LiteralPath $readmePath -PathType Leaf)) {
            throw "Embedded Python README is not a regular file: $readmePath"
        }
        Copy-Item -LiteralPath $readmePath -Destination (Join-Path $stagingDir "README.md")
    }

    Expand-Archive -LiteralPath $archivePath -DestinationPath $stagingDir -Force
    Assert-SafeDirectoryTree -Path $stagingDir -AllowedRoot $resourceRoot -Label "Extracted embedded Python runtime"
    New-Item -ItemType Directory -Path (Join-Path $stagingDir "Lib\site-packages") -Force | Out-Null
    Update-PythonPathFile -PythonHome $stagingDir

    $stagingPythonExe = Join-Path $stagingDir "python.exe"
    if (-not (Test-Path -LiteralPath $stagingPythonExe -PathType Leaf)) {
        throw "Embedded Python executable missing after extract: $stagingPythonExe"
    }
    $probeJson = Test-EmbeddedPython -PythonExe $stagingPythonExe -ProcessTimeoutSec $ProcessTimeoutSec
    $probe = $probeJson | ConvertFrom-Json
    if ($probe.version -ne $Version) {
        throw "Embedded Python version mismatch. expected=$Version actual=$($probe.version)"
    }

    # Complete the full dependency installation inside staging. A download,
    # bootstrap, install, or probe failure cannot mutate the prior runtime.
    $pipBootstrapWheel = Get-VerifiedPipBootstrapWheel -PipBootstrap $pipBootstrapLock -CacheDir $CacheDir -DownloadTimeoutSec $DownloadTimeoutSec -Force:$Force
    Install-PipBootstrap -PythonExe $stagingPythonExe -WheelPath $pipBootstrapWheel -PipBootstrap $pipBootstrapLock -ProcessTimeoutSec $ProcessTimeoutSec
    $installed = Install-RequirementsLock -PythonExe $stagingPythonExe -RequirementsPath $requirementsPath -ProcessTimeoutSec $ProcessTimeoutSec -PipVersion $pipBootstrapLock.Version
    $packages = @($installed)
    Write-Host "[python] installed $($packages.Count) packages (incl. transitive deps)"

    $finalPythonExe = Join-Path $TargetDir "python.exe"
    $manifest = [ordered]@{
        id = "python-embedded"
        version = $Version
        arch = $Arch
        sourceUrl = $Url
        sha256 = $actualSha
        pipBootstrap = [ordered]@{
            lockPath = $pipBootstrapLock.LockPath
            lockSha256 = $pipBootstrapLock.LockSha256
            version = $pipBootstrapLock.Version
            requirement = $pipBootstrapLock.Requirement
            installer = 'verified-wheel-extract-and-pip'
            wheel = [ordered]@{
                fileName = $pipBootstrapLock.FileName
                sourceUrl = $pipBootstrapLock.SourceUrl
                sha256 = $pipBootstrapLock.Sha256
            }
        }
        requirements = [ordered]@{
            path = $requirementsPath
            sha256 = $requirementsSha
        }
        targetDir = $TargetDir
        pythonExe = $finalPythonExe
        generatedAt = (Get-Date).ToUniversalTime().ToString("o")
        probe = [ordered]@{
            version = $probe.version
            executable = $finalPythonExe
            prefix = $TargetDir
        }
        packages = $packages
    }
    $manifestPath = Join-Path $stagingDir "PYTHON_EMBEDDED_MANIFEST.json"
    $manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $manifestPath -Encoding utf8
    Assert-SafeDirectoryTree -Path $stagingDir -AllowedRoot $resourceRoot -Label "Completed embedded Python staging directory"

    Publish-StagedDirectory -StagingDir $stagingDir -TargetDir $TargetDir -AllowedRoot $resourceRoot -PublishedValidator {
        param($publishedRoot)
        Assert-SafeDirectoryTree -Path $publishedRoot -AllowedRoot $resourceRoot -Label "Published embedded Python runtime"
        foreach ($requiredFile in @("python.exe", "PYTHON_EMBEDDED_MANIFEST.json")) {
            $requiredPath = Join-Path $publishedRoot $requiredFile
            if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
                throw "Published embedded Python runtime is incomplete: $requiredPath"
            }
        }
    }
} catch {
    $operationFailure = $_
    throw
} finally {
    if (Test-Path -LiteralPath $stagingDir) {
        try {
            Remove-SafeTransactionDirectory -Path $stagingDir -AllowedRoot $resourceRoot
        } catch {
            if ($null -ne $operationFailure) {
                throw "Embedded Python staging failed ($($operationFailure.Exception.Message)); staging cleanup also failed: $($_.Exception.Message)"
            }
            throw
        }
    }
}

Write-Host "[python] staged $Version ($Arch) -> $TargetDir"
Write-Host "[python] sha256 $actualSha"
} finally {
    Exit-EmbeddedPythonLock -LockHandle $operationLock
}
