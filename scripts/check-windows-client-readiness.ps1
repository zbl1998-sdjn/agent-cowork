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
$ancestorExclusions = @()
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
    $ancestorExclusions = @(
        $matchingExclusions | Where-Object {
            $_ -ne $exe
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
$exactExclusionRequired = $exeExists -and (-not $hasExactExclusion)
$unblockCommand = "Add-MpPreference -ExclusionPath `"$exe`""

$requiredUserAction = $null
if (-not $exeExists) {
    $requiredUserAction = "Build the Windows client first with scripts\smoke-windows-client.ps1 or the documented CMake commands."
}
elseif (-not $hasExactExclusion) {
    $requiredUserAction = "If you accept the security tradeoff, explicitly approve adding a Microsoft Defender exclusion for this exact file path: $exe"
}

$diagnosis = if (-not $exeExists) {
    "The native Windows client executable has not been built yet."
}
elseif ($hasExactExclusion) {
    "The exact executable path is already listed in Microsoft Defender exclusions; native window smoke can be retried."
}
elseif ($ancestorExclusions.Count -gt 0 -and $blockedByAsr) {
    "A broader exclusion exists, but the latest Defender ASR event still names this executable. Treat the native window smoke as blocked until this exact executable path is explicitly approved and then retested."
}
elseif ($blockedByAsr) {
    "The latest Defender ASR event names this executable and no exact path exclusion is present."
}
else {
    "No exact executable exclusion is present. Add one only after explicit approval, then rerun the native window smoke."
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
        ancestorExclusions = $ancestorExclusions
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
    exactExclusionRequired = $exactExclusionRequired
    diagnosis = $diagnosis
    explicitApprovalText = "同意为 $exe 添加 Microsoft Defender 精确路径排除项"
    proposedUnblockCommand = $unblockCommand
    rerunCommand = "pwsh -NoProfile -ExecutionPolicy Bypass -File .\scripts\smoke-windows-client.ps1"
    fullVerificationCommand = "node .\scripts\verify-mvp.mjs --windows-client"
    strictAuditCommand = "npm run audit:mvp -- --strict"
    requiredUserAction = $requiredUserAction
}

$report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $reportPath -Encoding utf8
$report | ConvertTo-Json -Depth 8
Write-Host "report: $reportPath"

if ($FailOnBlocked -and -not $readyToRunNativeSmoke) {
    exit 2
}
