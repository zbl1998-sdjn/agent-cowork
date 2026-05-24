[CmdletBinding()]
param(
    [string]$InstalledExePath = $env:KCW_INSTALLED_EXE,
    [string]$InstallerPath = $env:KCW_INSTALLER_PATH,
    [string]$ReportPath = $env:KCW_WINDOWS_SMOKE_REPORT_PATH,
    [switch]$DryRun,
    [switch]$KeepOpen,
    [int]$HealthTimeoutSeconds = 20
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Assert-True {
    param(
        [Parameter(Mandatory = $true)][bool]$Condition,
        [Parameter(Mandatory = $true)][string]$Message
    )
    if (-not $Condition) {
        throw $Message
    }
}

function New-ReportPath {
    param([Parameter(Mandatory = $true)][string]$RepoRoot)

    $stamp = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ")
    $dir = Join-Path $RepoRoot "reports\windows-client-smoke"
    if (-not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir | Out-Null
    }
    return (Join-Path $dir "installed-tauri-smoke-$stamp.json")
}

function Write-SmokeReport {
    param(
        [Parameter(Mandatory = $true)]$Report,
        [Parameter(Mandatory = $true)][string]$Path
    )

    $dir = Split-Path -Parent $Path
    if (-not [string]::IsNullOrWhiteSpace($dir) -and -not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir | Out-Null
    }
    $Report | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $Path -Encoding utf8
    Write-Host "- installed Tauri smoke report: $Path"
}

function Get-SignatureSummary {
    param([string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path)) {
        return $null
    }
    $signature = Get-AuthenticodeSignature -LiteralPath $Path
    return [ordered]@{
        status = $signature.Status.ToString()
        subject = if ($signature.SignerCertificate) { $signature.SignerCertificate.Subject } else { $null }
        thumbprint = if ($signature.SignerCertificate) { $signature.SignerCertificate.Thumbprint } else { $null }
    }
}

function Wait-ForMainWindow {
    param(
        [Parameter(Mandatory = $true)][System.Diagnostics.Process]$Process,
        [int]$TimeoutSeconds = 15
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        $Process.Refresh()
        if ($Process.HasExited) {
            throw "Installed app exited before opening a main window"
        }
        if ($Process.MainWindowHandle -ne [IntPtr]::Zero) {
            return [ordered]@{
                handle = $Process.MainWindowHandle.ToInt64()
                title = $Process.MainWindowTitle
            }
        }
        Start-Sleep -Milliseconds 150
    }
    throw "Timed out waiting for installed app main window"
}

function Get-PortOwner {
    param([int]$Port = 3017)

    $conn = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $conn) {
        return $null
    }
    $proc = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
    return [ordered]@{
        pid = $conn.OwningProcess
        processName = if ($proc) { $proc.ProcessName } else { $null }
        path = if ($proc) { $proc.Path } else { $null }
    }
}

function Invoke-Json {
    param(
        [Parameter(Mandatory = $true)][string]$Uri,
        [string]$Method = "GET",
        [hashtable]$Headers = @{},
        [object]$Body = $null,
        [int]$TimeoutSec = 5
    )

    $args = @{
        Uri = $Uri
        Method = $Method
        Headers = $Headers
        TimeoutSec = $TimeoutSec
    }
    if ($null -ne $Body) {
        $args.ContentType = "application/json"
        $args.Body = ($Body | ConvertTo-Json -Depth 6)
    }
    return Invoke-RestMethod @args
}

function Wait-ForHostHealth {
    param(
        [Parameter(Mandatory = $true)][string]$BaseUrl,
        [int]$TimeoutSeconds = 20
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $lastError = $null
    while ((Get-Date) -lt $deadline) {
        try {
            $health = Invoke-Json -Uri "$BaseUrl/health" -TimeoutSec 2
            if ($health.ok -eq $true -and $health.service -eq "agent-cowork-host") {
                return $health
            }
        } catch {
            $lastError = $_.Exception.Message
        }
        Start-Sleep -Milliseconds 250
    }
    throw "Timed out waiting for installed sidecar health. Last error: $lastError"
}

$scriptDir = Split-Path -Parent $PSCommandPath
$repoRoot = Split-Path -Parent $scriptDir
$workspace = Join-Path $repoRoot "build\installed-tauri-smoke-workspace"
$baseUrl = "http://127.0.0.1:3017"

if ([string]::IsNullOrWhiteSpace($InstalledExePath)) {
    $InstalledExePath = Join-Path $env:LOCALAPPDATA "Agent Cowork\agent-cowork-desktop.exe"
}
if ([string]::IsNullOrWhiteSpace($ReportPath)) {
    $ReportPath = New-ReportPath -RepoRoot $repoRoot
}

$report = [ordered]@{
    ok = $false
    mode = if ($DryRun) { "dry-run" } else { "installed-tauri" }
    generatedAt = (Get-Date).ToUniversalTime().ToString("o")
    installedExe = $InstalledExePath
    installer = $InstallerPath
    workspace = $workspace
    checks = [ordered]@{}
    deferred = @(
        "deep WebView UI interaction",
        "real Kimi reply",
        "production signing trust chain"
    )
}

$process = $null
$caught = $null
$oldTrustedRoot = $env:KCW_TRUSTED_ROOT

try {
    $exeExists = Test-Path -LiteralPath $InstalledExePath
    Assert-True $exeExists "Installed Tauri executable not found: $InstalledExePath"
    $exe = (Resolve-Path -LiteralPath $InstalledExePath).Path
    $installDir = Split-Path -Parent $exe
    $sidecar = Join-Path $installDir "agent-cowork-host.exe"
    $sidecarExists = Test-Path -LiteralPath $sidecar
    Assert-True $sidecarExists "Installed host sidecar not found: $sidecar"

    $uninstallEntry = Get-ItemProperty HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\* -ErrorAction SilentlyContinue |
        Where-Object { $_.DisplayName -eq "Agent Cowork" } |
        Select-Object -First 1 DisplayName,DisplayVersion,InstallLocation,UninstallString

    $report.installedExe = $exe
    $report.installDir = $installDir
    $report.sidecar = $sidecar
    $report.signatures = [ordered]@{
        installedExe = Get-SignatureSummary -Path $exe
        installer = Get-SignatureSummary -Path $InstallerPath
    }
    $report.uninstallEntry = $uninstallEntry
    $report.liveReplyConfigured = [bool]($env:KIMI_API_KEY -or $env:MOONSHOT_API_KEY)

    if ($DryRun) {
        $report.ok = $true
        $report.checks.installedExeExists = $true
        $report.checks.sidecarExists = $true
        return
    }

    if (Test-Path -LiteralPath $workspace) {
        $resolvedWorkspace = (Resolve-Path -LiteralPath $workspace).Path
        $resolvedBuildRoot = (Resolve-Path -LiteralPath (Join-Path $repoRoot "build")).Path
        Assert-True ($resolvedWorkspace.StartsWith($resolvedBuildRoot, [System.StringComparison]::OrdinalIgnoreCase)) "Refusing to clean workspace outside build/: $resolvedWorkspace"
        Remove-Item -LiteralPath $workspace -Recurse -Force
    }
    New-Item -ItemType Directory -Path $workspace | Out-Null
    Set-Content -LiteralPath (Join-Path $workspace "installed-smoke.txt") -Encoding utf8 -Value "installed tauri smoke"

    $existingOwner = Get-PortOwner
    Assert-True ($null -eq $existingOwner) "Port 3017 is already in use before launch: $($existingOwner | ConvertTo-Json -Compress)"

    $env:KCW_TRUSTED_ROOT = $workspace
    $workspaceArg = "--workspace=`"$workspace`""
    $process = Start-Process -FilePath $exe -ArgumentList $workspaceArg -WorkingDirectory $installDir -PassThru -ErrorAction Stop

    $window = Wait-ForMainWindow -Process $process
    $health = Wait-ForHostHealth -BaseUrl $baseUrl -TimeoutSeconds $HealthTimeoutSeconds
    $owner = Get-PortOwner
    Assert-True ($null -ne $owner) "Installed sidecar health passed but port owner was not discoverable"
    Assert-True ($owner.path -eq $sidecar) "Port 3017 owner is not the installed sidecar: $($owner | ConvertTo-Json -Compress)"

    $guest = Invoke-Json -Uri "$baseUrl/api/auth/guest" -Method POST -Body @{}
    Assert-True (-not [string]::IsNullOrWhiteSpace($guest.token)) "Guest auth did not return a token"
    $authHeaders = @{ authorization = "Bearer $($guest.token)" }
    $me = Invoke-Json -Uri "$baseUrl/api/auth/me" -Headers $authHeaders
    $kimiInfo = Invoke-Json -Uri "$baseUrl/api/kimi/info" -Headers $authHeaders

    $report.ok = $true
    $report.process = [ordered]@{
        pid = $process.Id
        path = $exe
        window = $window
    }
    $report.host = [ordered]@{
        url = $baseUrl
        health = $health
        portOwner = $owner
    }
    $report.auth = [ordered]@{
        guestUserId = $guest.userId
        meUserId = $me.userId
        tenantId = $me.tenantId
    }
    $report.kimi = [ordered]@{
        configured = $kimiInfo.configured
        provider = $kimiInfo.provider
        model = $kimiInfo.model
    }
    $report.checks.installedExeExists = $true
    $report.checks.sidecarExists = $true
    $report.checks.mainWindow = "passed"
    $report.checks.sidecarHealth = "passed"
    $report.checks.authRoundTrip = "passed"
}
catch {
    $caught = $_
    $report.error = $_.Exception.Message
}
finally {
    if ($null -eq $oldTrustedRoot) {
        Remove-Item Env:KCW_TRUSTED_ROOT -ErrorAction SilentlyContinue
    } else {
        $env:KCW_TRUSTED_ROOT = $oldTrustedRoot
    }

    $cleanup = [ordered]@{}
    if ($null -ne $process -and -not $KeepOpen) {
        try {
            $process.Refresh()
            if (-not $process.HasExited) {
                $process.CloseMainWindow() | Out-Null
                if (-not $process.WaitForExit(5000)) {
                    $process.Kill()
                    $process.WaitForExit(5000) | Out-Null
                    $cleanup.killedDesktop = $true
                } else {
                    $cleanup.closedDesktop = $true
                }
            }
        } catch {
            $cleanup.desktopCloseError = $_.Exception.Message
        }
        $deadline = (Get-Date).AddSeconds(8)
        do {
            Start-Sleep -Milliseconds 250
            $ownerAfterClose = Get-PortOwner
        } while ($null -ne $ownerAfterClose -and (Get-Date) -lt $deadline)
        $cleanup.hostStoppedAfterClose = $null -eq $ownerAfterClose
        if ($null -ne $ownerAfterClose) {
            $cleanup.portOwnerAfterClose = $ownerAfterClose
            if ($report.ok) {
                $report.ok = $false
                $report.error = "Installed host sidecar was still listening after desktop exit"
            }
        }
    }
    $report.cleanup = $cleanup
    Write-SmokeReport -Report $report -Path $ReportPath
}

if ($null -ne $caught) {
    throw $caught
}
if (-not $report.ok) {
    throw $report.error
}
[pscustomobject]$report
