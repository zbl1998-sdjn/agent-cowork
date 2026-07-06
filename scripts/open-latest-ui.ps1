[CmdletBinding()]
param(
    [string]$Url = "http://127.0.0.1:5173/",
    [string]$HostHealthUrl = "http://127.0.0.1:3017/health",
    [int]$TimeoutSeconds = 30,
    [switch]$NoOpen
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $repoRoot "output\dev-server"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

function Test-HttpOk {
    param([Parameter(Mandatory = $true)][string]$ProbeUrl)
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri $ProbeUrl -TimeoutSec 2
        return ($response.StatusCode -ge 200 -and $response.StatusCode -lt 300)
    } catch {
        return $false
    }
}

function Get-PortOwner {
    param([Parameter(Mandatory = $true)][int]$Port)
    $conn = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $conn) { return $null }
    $proc = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
    return [ordered]@{
        pid = $conn.OwningProcess
        processName = if ($proc) { $proc.ProcessName } else { $null }
        path = if ($proc) { $proc.Path } else { $null }
    }
}

function Get-NpmCmd {
    $cmd = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $fallback = Get-Command npm -ErrorAction Stop
    return $fallback.Source
}

function Start-LoggedProcess {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $true)][string[]]$ArgumentList
    )
    $outLog = Join-Path $logDir "$Name.out.log"
    $errLog = Join-Path $logDir "$Name.err.log"
    Remove-Item -LiteralPath $outLog, $errLog -ErrorAction SilentlyContinue
    $process = Start-Process `
        -FilePath $FilePath `
        -ArgumentList $ArgumentList `
        -WorkingDirectory $repoRoot `
        -RedirectStandardOutput $outLog `
        -RedirectStandardError $errLog `
        -PassThru `
        -WindowStyle Hidden
    Set-Content -LiteralPath (Join-Path $logDir "$Name.pid") -Value $process.Id -Encoding utf8
    return $process
}

function Wait-ForRuntime {
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if ((Test-HttpOk -ProbeUrl $HostHealthUrl) -and (Test-HttpOk -ProbeUrl $Url)) {
            return
        }
        Start-Sleep -Milliseconds 500
    }

    $hostOk = Test-HttpOk -ProbeUrl $HostHealthUrl
    $uiOk = Test-HttpOk -ProbeUrl $Url
    $hostLog = Join-Path $logDir "agent-cowork-host.out.log"
    $hostErr = Join-Path $logDir "agent-cowork-host.err.log"
    $viteLog = Join-Path $logDir "agent-cowork-ui-vite.out.log"
    $viteErr = Join-Path $logDir "agent-cowork-ui-vite.err.log"
    Write-Host "hostOk=$hostOk uiOk=$uiOk"
    Write-Host "--- host stdout ---"
    Get-Content -LiteralPath $hostLog -ErrorAction SilentlyContinue -Tail 80
    Write-Host "--- host stderr ---"
    Get-Content -LiteralPath $hostErr -ErrorAction SilentlyContinue -Tail 80
    Write-Host "--- vite stdout ---"
    Get-Content -LiteralPath $viteLog -ErrorAction SilentlyContinue -Tail 80
    Write-Host "--- vite stderr ---"
    Get-Content -LiteralPath $viteErr -ErrorAction SilentlyContinue -Tail 80
    throw "Agent Cowork latest UI runtime did not become healthy."
}

$npm = Get-NpmCmd

if (-not (Test-HttpOk -ProbeUrl $HostHealthUrl)) {
    $owner = Get-PortOwner -Port 3017
    if ($owner) {
        throw "Port 3017 is already in use but $HostHealthUrl is not healthy: $($owner | ConvertTo-Json -Compress)"
    }
    Start-LoggedProcess -Name "agent-cowork-host" -FilePath $npm -ArgumentList @("run", "start:tauri-host") | Out-Null
}

if (-not (Test-HttpOk -ProbeUrl $Url)) {
    $owner = Get-PortOwner -Port 5173
    if ($owner) {
        throw "Port 5173 is already in use but $Url is not healthy: $($owner | ConvertTo-Json -Compress)"
    }
    Start-LoggedProcess -Name "agent-cowork-ui-vite" -FilePath $npm -ArgumentList @("--prefix", "apps/windows-client/ui", "run", "dev", "--", "--host", "127.0.0.1", "--port", "5173", "--strictPort") | Out-Null
}

Wait-ForRuntime

if (-not $NoOpen) {
    $chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
    if (Test-Path -LiteralPath $chrome) {
        Start-Process -FilePath $chrome -ArgumentList @("--new-window", $Url)
    } else {
        Start-Process $Url
    }
}

$health = Invoke-RestMethod -Uri $HostHealthUrl -TimeoutSec 5
$ports = Get-NetTCPConnection -State Listen |
    Where-Object { $_.LocalPort -in 3017, 5173 } |
    Select-Object LocalAddress, LocalPort, OwningProcess |
    Sort-Object LocalPort

[pscustomobject]@{
    ok = $true
    url = $Url
    hostHealthUrl = $HostHealthUrl
    hostHealth = $health
    ports = $ports
    logs = $logDir
}
