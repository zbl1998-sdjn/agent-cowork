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

function Get-AgentCoworkUninstallEntry {
    param([Parameter(Mandatory = $true)][ValidateSet("HKCU", "HKLM")][string]$Hive)

    $roots = if ($Hive -eq "HKCU") {
        @("HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall")
    } else {
        @(
            "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall",
            "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"
        )
    }
    foreach ($root in $roots) {
        $entries = Get-ItemProperty -Path (Join-Path $root "*") -ErrorAction SilentlyContinue |
            Where-Object {
                $name = $_.PSObject.Properties["DisplayName"]
                $name -and $name.Value -eq "Agent Cowork"
            } |
            Select-Object -First 1 DisplayName,DisplayVersion,InstallLocation,UninstallString,PSPath
        if ($entries) {
            return $entries
        }
    }
    return $null
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

function Get-NsisCleanupHookStatus {
    param([Parameter(Mandatory = $true)][string]$RepoRoot)

    $tauriRoot = Join-Path $RepoRoot "apps\windows-client\src-tauri"
    $configPath = Join-Path $tauriRoot "tauri.conf.json"
    Assert-True (Test-Path -LiteralPath $configPath) "Tauri config not found: $configPath"

    $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    $hookRel = $config.bundle.windows.nsis.installerHooks
    Assert-True (-not [string]::IsNullOrWhiteSpace($hookRel)) "NSIS installerHooks is not configured"

    $hookPath = [System.IO.Path]::GetFullPath((Join-Path $tauriRoot $hookRel))
    $tauriRootFull = [System.IO.Path]::GetFullPath($tauriRoot).TrimEnd("\")
    $tauriRootPrefix = $tauriRootFull + [System.IO.Path]::DirectorySeparatorChar
    Assert-True ($hookPath.StartsWith($tauriRootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) "NSIS hook path escapes src-tauri: $hookPath"
    Assert-True (Test-Path -LiteralPath $hookPath) "NSIS hook file not found: $hookPath"

    $hookText = Get-Content -LiteralPath $hookPath -Raw
    Assert-True $hookText.Contains("NSIS_HOOK_POSTUNINSTALL") "NSIS hook does not define post-uninstall cleanup"
    Assert-True $hookText.Contains('$DeleteAppDataCheckboxState = 1') "NSIS cleanup is not gated by delete-data confirmation"
    Assert-True $hookText.Contains('$UpdateMode <> 1') "NSIS cleanup is not gated away from update mode"
    $cleanupMatches = [regex]::Matches($hookText, 'RmDir\s+/r\s+"\$APPDATA\\AgentCowork"')
    Assert-True ($cleanupMatches.Count -eq 1) "NSIS cleanup must contain exactly one precise AgentCowork AppData removal"

    return [ordered]@{
        configured = $true
        configPath = $configPath
        hookPath = $hookPath
        safeRoot = '$APPDATA\AgentCowork'
        gatedBy = @("DeleteAppDataCheckboxState", "not UpdateMode")
    }
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
$oldStore = $env:KCW_STORE
$oldSqlitePath = $env:KCW_SQLITE_PATH

try {
    $nsisCleanupHook = Get-NsisCleanupHookStatus -RepoRoot $repoRoot
    $report.installerCleanupHook = $nsisCleanupHook
    $report.checks.nsisCleanupHook = "passed"

    $exeExists = Test-Path -LiteralPath $InstalledExePath
    Assert-True $exeExists "Installed Tauri executable not found: $InstalledExePath"
    $exe = (Resolve-Path -LiteralPath $InstalledExePath).Path
    $installDir = Split-Path -Parent $exe
    $sidecar = Join-Path $installDir "agent-cowork-host.exe"
    $sidecarExists = Test-Path -LiteralPath $sidecar
    Assert-True $sidecarExists "Installed host sidecar not found: $sidecar"

    $expectedInstallRoot = [System.IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA "Agent Cowork")).TrimEnd("\")
    $resolvedInstallDir = [System.IO.Path]::GetFullPath($installDir).TrimEnd("\")
    Assert-True ($resolvedInstallDir.StartsWith($expectedInstallRoot, [System.StringComparison]::OrdinalIgnoreCase)) "Installed app is not under the per-user LOCALAPPDATA root: $resolvedInstallDir"

    $hkcuUninstallEntry = Get-AgentCoworkUninstallEntry -Hive HKCU
    $hklmUninstallEntry = Get-AgentCoworkUninstallEntry -Hive HKLM
    Assert-True ($null -ne $hkcuUninstallEntry) "Per-user HKCU uninstall entry not found for Agent Cowork"
    Assert-True ($null -eq $hklmUninstallEntry) "All-machine HKLM uninstall entry found for Agent Cowork; installer must default to currentUser"

    $report.installedExe = $exe
    $report.installDir = $installDir
    $report.sidecar = $sidecar
    $report.signatures = [ordered]@{
        installedExe = Get-SignatureSummary -Path $exe
        installer = Get-SignatureSummary -Path $InstallerPath
    }
    $report.installScope = [ordered]@{
        expected = "currentUser"
        expectedRoot = $expectedInstallRoot
        resolvedInstallDir = $resolvedInstallDir
        hkcuUninstallEntry = $hkcuUninstallEntry
        hklmUninstallEntry = $hklmUninstallEntry
    }
    $report.uninstallEntry = $hkcuUninstallEntry
    $report.liveReplyConfigured = [bool]($env:KIMI_API_KEY -or $env:MOONSHOT_API_KEY)

    if ($DryRun) {
        $report.ok = $true
        $report.checks.installedExeExists = $true
        $report.checks.sidecarExists = $true
        $report.checks.perUserInstallRoot = "passed"
        $report.checks.hkcuUninstallEntry = "passed"
        $report.checks.hklmUninstallEntryAbsent = "passed"
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
    $sqliteDir = Join-Path $workspace ".AgentCowork"
    $sqlitePath = Join-Path $sqliteDir "state.sqlite"
    New-Item -ItemType Directory -Path $sqliteDir | Out-Null

    $existingOwner = Get-PortOwner
    Assert-True ($null -eq $existingOwner) "Port 3017 is already in use before launch: $($existingOwner | ConvertTo-Json -Compress)"

    $env:KCW_TRUSTED_ROOT = $workspace
    $env:KCW_STORE = "sqlite"
    $env:KCW_SQLITE_PATH = $sqlitePath
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
    $runtimeDependencies = Invoke-Json -Uri "$baseUrl/api/runtime/dependencies" -Headers $authHeaders
    $sqliteDependency = $runtimeDependencies.dependencies | Where-Object { $_.id -eq "sqlite" } | Select-Object -First 1
    Assert-True ($null -ne $sqliteDependency) "Runtime dependency catalog did not include sqlite"
    Assert-True ($sqliteDependency.status -eq "available") "Installed sidecar SQLite runtime unavailable: $($sqliteDependency | ConvertTo-Json -Compress)"

    $memoryFact = Invoke-Json -Uri "$baseUrl/api/memory/facts" -Method POST -Headers $authHeaders -Body @{
        key = "安装版 SQLite"
        value = "sidecar write chain persisted"
    }
    $runHeaders = @{ authorization = "Bearer $($guest.token)"; "idempotency-key" = "installed-sqlite-run" }
    $recipeRun = Invoke-Json -Uri "$baseUrl/api/recipes/meeting-actions/run" -Method POST -Headers $runHeaders -Body @{
        prompt = "安装版 SQLite smoke"
        files = @()
    }
    Assert-True (-not [string]::IsNullOrWhiteSpace($recipeRun.runId)) "Recipe run did not return runId"

    $scheduleHeaders = @{ authorization = "Bearer $($guest.token)"; "idempotency-key" = "installed-sqlite-schedule" }
    $schedule = Invoke-Json -Uri "$baseUrl/api/schedules" -Method POST -Headers $scheduleHeaders -Body @{
        name = "installed-sqlite-smoke"
        fireAt = (Get-Date).ToUniversalTime().AddMinutes(1).ToString("o")
        payload = @{ recipeId = "meeting-actions" }
    }
    Assert-True (-not [string]::IsNullOrWhiteSpace($schedule.schedule.id)) "Schedule create did not return schedule id"
    Assert-True (Test-Path -LiteralPath $sqlitePath) "SQLite state database was not created: $sqlitePath"

    $process.Refresh()
    if (-not $process.HasExited) {
        $process.CloseMainWindow() | Out-Null
        if (-not $process.WaitForExit(5000)) {
            $process.Kill()
            $process.WaitForExit(5000) | Out-Null
        }
    }
    $deadline = (Get-Date).AddSeconds(8)
    do {
        Start-Sleep -Milliseconds 250
        $ownerAfterRestartClose = Get-PortOwner
    } while ($null -ne $ownerAfterRestartClose -and (Get-Date) -lt $deadline)
    Assert-True ($null -eq $ownerAfterRestartClose) "Installed sidecar was still listening before SQLite restart check: $($ownerAfterRestartClose | ConvertTo-Json -Compress)"
    $process = $null

    $process = Start-Process -FilePath $exe -ArgumentList $workspaceArg -WorkingDirectory $installDir -PassThru -ErrorAction Stop
    $restartWindow = Wait-ForMainWindow -Process $process
    $restartHealth = Wait-ForHostHealth -BaseUrl $baseUrl -TimeoutSeconds $HealthTimeoutSeconds
    $meAfterRestart = Invoke-Json -Uri "$baseUrl/api/auth/me" -Headers $authHeaders
    Assert-True ($meAfterRestart.userId -eq $me.userId) "SQLite auth token did not persist through installed restart"
    $memoryAfterRestart = Invoke-Json -Uri "$baseUrl/api/memory" -Headers $authHeaders
    Assert-True ($memoryAfterRestart.memory.text -like "*安装版 SQLite*") "SQLite memory fact did not persist through installed restart"
    $runsAfterRestart = Invoke-Json -Uri "$baseUrl/api/runs/index" -Headers $authHeaders
    $persistedRun = $runsAfterRestart.runs | Where-Object { $_.id -eq $recipeRun.runId } | Select-Object -First 1
    Assert-True ($null -ne $persistedRun) "SQLite runs index did not persist through installed restart"
    $schedulesAfterRestart = Invoke-Json -Uri "$baseUrl/api/schedules" -Headers $authHeaders
    $persistedSchedule = $schedulesAfterRestart.schedules | Where-Object { $_.id -eq $schedule.schedule.id } | Select-Object -First 1
    Assert-True ($null -ne $persistedSchedule) "SQLite schedule did not persist through installed restart"

    $report.ok = $true
    $report.process = [ordered]@{
        pid = $process.Id
        path = $exe
        window = $window
        restartWindow = $restartWindow
    }
    $report.host = [ordered]@{
        url = $baseUrl
        health = $health
        restartHealth = $restartHealth
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
    $report.sqlite = [ordered]@{
        dbPath = $sqlitePath
        dependency = $sqliteDependency
        dependencySummary = $runtimeDependencies.summary
        memoryFactFile = $memoryFact.file
        runId = $recipeRun.runId
        scheduleId = $schedule.schedule.id
        persistedAfterRestart = [ordered]@{
            auth = $true
            memory = $true
            run = $true
            schedule = $true
        }
    }
    $report.checks.installedExeExists = $true
    $report.checks.sidecarExists = $true
    $report.checks.perUserInstallRoot = "passed"
    $report.checks.hkcuUninstallEntry = "passed"
    $report.checks.hklmUninstallEntryAbsent = "passed"
    $report.checks.mainWindow = "passed"
    $report.checks.sidecarHealth = "passed"
    $report.checks.authRoundTrip = "passed"
    $report.checks.sqliteRuntime = "passed"
    $report.checks.sqliteWriteChain = "passed"
    $report.checks.sqliteRestartPersistence = "passed"
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
    if ($null -eq $oldStore) {
        Remove-Item Env:KCW_STORE -ErrorAction SilentlyContinue
    } else {
        $env:KCW_STORE = $oldStore
    }
    if ($null -eq $oldSqlitePath) {
        Remove-Item Env:KCW_SQLITE_PATH -ErrorAction SilentlyContinue
    } else {
        $env:KCW_SQLITE_PATH = $oldSqlitePath
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
