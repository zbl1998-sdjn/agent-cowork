[CmdletBinding()]
param(
    [switch]$FailOnBlocked
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $PSCommandPath
$repoRoot = Split-Path -Parent $scriptDir
$buildRoot = Join-Path $repoRoot "build"
$exe = Join-Path $buildRoot "windows-client-vs\KimiCowork.exe"
$reportPath = Join-Path $buildRoot "windows-client-readiness.json"
$asrRuleId = "01443614-CD74-433A-B99E-2ECDC07BFC25"

if (-not (Test-Path -LiteralPath $buildRoot)) {
    New-Item -ItemType Directory -Path $buildRoot | Out-Null
}

$exeExists = Test-Path -LiteralPath $exe
$exclusions = @()
$hasExactExclusion = $false
$matchingExclusions = @()
$mpPreferenceError = $null

try {
    $mpPreference = Get-MpPreference
    $exclusions = @($mpPreference.ExclusionPath)
    $hasExactExclusion = $exclusions -contains $exe
    $matchingExclusions = @(
        $exclusions | Where-Object {
            $_ -eq $exe -or $exe.StartsWith($_, [System.StringComparison]::OrdinalIgnoreCase)
        }
    )
}
catch {
    $mpPreferenceError = $_.Exception.Message
}

$latestAsrEvent = $null
try {
    $events = Get-WinEvent -FilterHashtable @{
        LogName = "Microsoft-Windows-Windows Defender/Operational"
        Id = 1121
    } -MaxEvents 20 -ErrorAction Stop
    $latestAsrEvent = $events |
        Where-Object {
            $_.Message.Contains($asrRuleId) -and
            $_.Message.ToLowerInvariant().Contains($exe.ToLowerInvariant())
        } |
        Select-Object -First 1
}
catch {
    $latestAsrEvent = $null
}

$blockedByAsr = (-not $hasExactExclusion) -and ($null -ne $latestAsrEvent)
$readyToRunNativeSmoke = $exeExists -and $hasExactExclusion

$requiredUserAction = $null
if (-not $exeExists) {
    $requiredUserAction = "Build the Windows client first with scripts\smoke-windows-client.ps1 or the documented CMake commands."
}
elseif (-not $hasExactExclusion) {
    $requiredUserAction = "If you accept the security tradeoff, explicitly approve adding a Microsoft Defender exclusion for this exact file path: $exe"
}

$report = [ordered]@{
    ok = $readyToRunNativeSmoke
    generatedAt = (Get-Date).ToUniversalTime().ToString("o")
    repoRoot = $repoRoot
    executable = $exe
    executableExists = $exeExists
    defender = [ordered]@{
        asrRuleId = $asrRuleId
        hasExactExclusion = $hasExactExclusion
        matchingExclusions = $matchingExclusions
        exclusionPathCount = $exclusions.Count
        preferenceError = $mpPreferenceError
    }
    latestMatchingAsrEvent = if ($null -eq $latestAsrEvent) {
        $null
    }
    else {
        [ordered]@{
            timeCreated = $latestAsrEvent.TimeCreated.ToUniversalTime().ToString("o")
            providerName = $latestAsrEvent.ProviderName
            id = $latestAsrEvent.Id
            message = $latestAsrEvent.Message
        }
    }
    blockedByAsr = $blockedByAsr
    readyToRunNativeSmoke = $readyToRunNativeSmoke
    rerunCommand = "pwsh -NoProfile -ExecutionPolicy Bypass -File .\scripts\smoke-windows-client.ps1"
    fullVerificationCommand = "node .\scripts\verify-mvp.mjs --windows-client"
    requiredUserAction = $requiredUserAction
}

$report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $reportPath -Encoding utf8
$report | ConvertTo-Json -Depth 8
Write-Host "report: $reportPath"

if ($FailOnBlocked -and -not $readyToRunNativeSmoke) {
    exit 2
}
