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

function Normalize-DefenderPath {
    param([AllowNull()][string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) {
        return ""
    }
    return $Path.Trim().TrimEnd("\", "/")
}

function Test-ExactDefenderPath {
    param(
        [AllowNull()][string]$Candidate,
        [Parameter(Mandatory = $true)][string]$Target
    )
    $candidatePath = Normalize-DefenderPath -Path $Candidate
    $targetPath = Normalize-DefenderPath -Path $Target
    return $candidatePath.Equals($targetPath, [System.StringComparison]::OrdinalIgnoreCase)
}

function Test-DefenderPathCovers {
    param(
        [AllowNull()][string]$Candidate,
        [Parameter(Mandatory = $true)][string]$Target
    )
    $candidatePath = Normalize-DefenderPath -Path $Candidate
    $targetPath = Normalize-DefenderPath -Path $Target
    if ($candidatePath.Length -eq 0) {
        return $false
    }
    return $targetPath.Equals($candidatePath, [System.StringComparison]::OrdinalIgnoreCase) -or
        $targetPath.StartsWith("$candidatePath\", [System.StringComparison]::OrdinalIgnoreCase)
}

$exeExists = Test-Path -LiteralPath $exe
$standardExclusions = @()
$asrOnlyExclusions = @()
$hasExactStandardExclusion = $false
$hasExactAsrOnlyExclusion = $false
$standardMatchingExclusions = @()
$asrOnlyMatchingExclusions = @()
$standardAncestorExclusions = @()
$asrOnlyAncestorExclusions = @()
$targetAsrAction = $null
$mpPreferenceError = $null

try {
    $mpPreference = Get-MpPreference
    $standardExclusions = @($mpPreference.ExclusionPath)
    $asrOnlyExclusions = @($mpPreference.AttackSurfaceReductionOnlyExclusions)
    $hasExactStandardExclusion = @($standardExclusions | Where-Object { Test-ExactDefenderPath -Candidate $_ -Target $exe }).Count -gt 0
    $hasExactAsrOnlyExclusion = @($asrOnlyExclusions | Where-Object { Test-ExactDefenderPath -Candidate $_ -Target $exe }).Count -gt 0
    $standardMatchingExclusions = @(
        $standardExclusions | Where-Object { Test-DefenderPathCovers -Candidate $_ -Target $exe }
    )
    $asrOnlyMatchingExclusions = @(
        $asrOnlyExclusions | Where-Object { Test-DefenderPathCovers -Candidate $_ -Target $exe }
    )
    $standardAncestorExclusions = @(
        $standardMatchingExclusions | Where-Object { -not (Test-ExactDefenderPath -Candidate $_ -Target $exe) }
    )
    $asrOnlyAncestorExclusions = @(
        $asrOnlyMatchingExclusions | Where-Object { -not (Test-ExactDefenderPath -Candidate $_ -Target $exe) }
    )
    $asrRuleIds = @($mpPreference.AttackSurfaceReductionRules_Ids)
    $asrRuleActions = @($mpPreference.AttackSurfaceReductionRules_Actions)
    for ($i = 0; $i -lt $asrRuleIds.Count; $i++) {
        if ($asrRuleIds[$i].Equals($asrRuleId, [System.StringComparison]::OrdinalIgnoreCase)) {
            if ($i -lt $asrRuleActions.Count) {
                $targetAsrAction = $asrRuleActions[$i]
            }
            break
        }
    }
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

$blockedByAsr = (-not $hasExactAsrOnlyExclusion) -and ($null -ne $latestAsrEvent)
$readyToRunNativeSmoke = $exeExists -and $hasExactAsrOnlyExclusion
$exactExclusionRequired = $exeExists -and (-not $hasExactAsrOnlyExclusion)
$unblockCommand = "Add-MpPreference -AttackSurfaceReductionOnlyExclusions `"$exe`""

$requiredUserAction = $null
if (-not $exeExists) {
    $requiredUserAction = "Build the Windows client first with scripts\smoke-windows-client.ps1 or the documented CMake commands."
}
elseif (-not $hasExactAsrOnlyExclusion) {
    $requiredUserAction = "If you accept the security tradeoff, explicitly approve adding a Microsoft Defender ASR-only exclusion for this exact file path: $exe"
}

$diagnosis = if (-not $exeExists) {
    "The native Windows client executable has not been built yet."
}
elseif ($hasExactAsrOnlyExclusion) {
    "The exact executable path is already listed in Microsoft Defender ASR-only exclusions; native window smoke can be retried."
}
elseif (($standardMatchingExclusions.Count -gt 0 -or $standardAncestorExclusions.Count -gt 0) -and $blockedByAsr) {
    "A regular Defender ExclusionPath already covers this executable, but the latest ASR event still names it. Treat the native window smoke as blocked until this exact executable path is explicitly approved with AttackSurfaceReductionOnlyExclusions and then retested."
}
elseif ($blockedByAsr) {
    "The latest Defender ASR event names this executable and no exact ASR-only exclusion is present."
}
else {
    "No exact ASR-only executable exclusion is present. Add one only after explicit approval, then rerun the native window smoke."
}

$report = [ordered]@{
    ok = $readyToRunNativeSmoke
    generatedAt = (Get-Date).ToUniversalTime().ToString("o")
    repoRoot = $repoRoot
    executable = $exe
    executableExists = $exeExists
    defender = [ordered]@{
        asrRuleId = $asrRuleId
        targetAsrAction = $targetAsrAction
        hasExactAsrOnlyExclusion = $hasExactAsrOnlyExclusion
        hasExactStandardExclusion = $hasExactStandardExclusion
        standardMatchingExclusions = $standardMatchingExclusions
        standardAncestorExclusions = $standardAncestorExclusions
        asrOnlyMatchingExclusions = $asrOnlyMatchingExclusions
        asrOnlyAncestorExclusions = $asrOnlyAncestorExclusions
        standardExclusionPathCount = $standardExclusions.Count
        asrOnlyExclusionPathCount = $asrOnlyExclusions.Count
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
    explicitApprovalText = "同意为 $exe 添加 Microsoft Defender ASR-only 精确路径排除项"
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
