[CmdletBinding()]
param(
    [switch]$KeepOpen
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Invoke-Checked {
    param(
        [Parameter(Mandatory = $true)][string]$Command,
        [Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments
    )

    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed with exit code ${LASTEXITCODE}: $Command $($Arguments -join ' ')"
    }
}

function Assert-True {
    param(
        [Parameter(Mandatory = $true)][bool]$Condition,
        [Parameter(Mandatory = $true)][string]$Message
    )

    if (-not $Condition) {
        throw $Message
    }
}

$scriptDir = Split-Path -Parent $PSCommandPath
$repoRoot = Split-Path -Parent $scriptDir
$buildRoot = Join-Path $repoRoot "build"
$workspace = Join-Path $buildRoot "windows-client-smoke-workspace"
$sourceDir = Join-Path $repoRoot "apps\windows-client"
$buildDir = Join-Path $buildRoot "windows-client-vs"
$exe = Join-Path $buildDir "KimiCowork.exe"
$vsDevShell = "C:\Program Files\Microsoft Visual Studio\18\Community\Common7\Tools\Launch-VsDevShell.ps1"

if (-not (Test-Path -LiteralPath $buildRoot)) {
    New-Item -ItemType Directory -Path $buildRoot | Out-Null
}

if (Test-Path -LiteralPath $workspace) {
    $resolvedWorkspace = (Resolve-Path -LiteralPath $workspace).Path
    $resolvedBuildRoot = (Resolve-Path -LiteralPath $buildRoot).Path
    Assert-True ($resolvedWorkspace.StartsWith($resolvedBuildRoot, [System.StringComparison]::OrdinalIgnoreCase)) "Refusing to clean workspace outside build/: $resolvedWorkspace"
    Remove-Item -LiteralPath $workspace -Recurse -Force
}

New-Item -ItemType Directory -Path $workspace | Out-Null
New-Item -ItemType Directory -Path (Join-Path $workspace "contracts") | Out-Null
New-Item -ItemType Directory -Path (Join-Path $workspace "finance") | Out-Null
Set-Content -LiteralPath (Join-Path $workspace "meeting-notes.md") -Encoding utf8 -Value "# Weekly meeting`n- Follow up with procurement`n- Prepare summary"
Set-Content -LiteralPath (Join-Path $workspace "contracts\sample-contract.txt") -Encoding utf8 -Value "Contract draft. Party A, Party B, renewal date, payment terms."
Set-Content -LiteralPath (Join-Path $workspace "finance\invoices.csv") -Encoding utf8 -Value "vendor,amount`nMoonshot,1280`nOffice,360"
Set-Content -LiteralPath (Join-Path $workspace "kimi-cowork.workspace") -Encoding ascii -Value "smoke"

Assert-True (Test-Path -LiteralPath $vsDevShell) "Visual Studio developer shell not found: $vsDevShell"
& $vsDevShell -Arch amd64 -HostArch amd64 -SkipAutomaticLocation | Out-Null

if (-not (Test-Path -LiteralPath (Join-Path $buildDir "build.ninja"))) {
    Invoke-Checked "cmake" "-S" $sourceDir "-B" $buildDir "-G" "Ninja"
}
Invoke-Checked "cmake" "--build" $buildDir "--config" "Debug"
Assert-True (Test-Path -LiteralPath $exe) "KimiCowork.exe was not built: $exe"

$nativeCode = @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Collections.Generic;

public sealed class KcwChildWindow {
    public IntPtr Hwnd;
    public string ClassName;
    public string Text;
}

public static class KcwSmokeWin32 {
    public delegate bool EnumChildProc(IntPtr hwnd, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumChildWindows(IntPtr hwndParent, EnumChildProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll")]
    public static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr wParam, StringBuilder lParam);

    public static string Text(IntPtr hwnd) {
        const uint WM_GETTEXT = 0x000D;
        const uint WM_GETTEXTLENGTH = 0x000E;
        int length = SendMessage(hwnd, WM_GETTEXTLENGTH, IntPtr.Zero, IntPtr.Zero).ToInt32();
        var text = new StringBuilder(Math.Max(length + 1, 8192));
        SendMessage(hwnd, WM_GETTEXT, (IntPtr)text.Capacity, text);
        return text.ToString();
    }

    public static KcwChildWindow[] Children(IntPtr parent) {
        var rows = new List<KcwChildWindow>();
        EnumChildWindows(parent, (h, l) => {
            var cls = new StringBuilder(128);
            GetClassName(h, cls, cls.Capacity);
            rows.Add(new KcwChildWindow { Hwnd = h, ClassName = cls.ToString(), Text = Text(h) });
            return true;
        }, IntPtr.Zero);
        return rows.ToArray();
    }
}
'@
Add-Type $nativeCode

function Wait-ForMainWindow {
    param(
        [Parameter(Mandatory = $true)][System.Diagnostics.Process]$Process,
        [int]$TimeoutSeconds = 10
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        $Process.Refresh()
        if ($Process.MainWindowHandle -ne [IntPtr]::Zero) {
            return $Process.MainWindowHandle
        }
        Start-Sleep -Milliseconds 100
    }
    throw "Timed out waiting for KimiCowork main window"
}

function Get-Children {
    param([Parameter(Mandatory = $true)][IntPtr]$Window)
    return [KcwSmokeWin32]::Children($Window)
}

function Find-Child {
    param(
        [Parameter(Mandatory = $true)]$Children,
        [Parameter(Mandatory = $true)][string]$ClassName,
        [string]$TextContains
    )

    foreach ($child in $Children) {
        if ($child.ClassName -ne $ClassName) {
            continue
        }
        if ([string]::IsNullOrEmpty($TextContains) -or $child.Text.Contains($TextContains)) {
            return $child
        }
    }
    return $null
}

function Get-LatestDefenderAsrEvent {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][datetime]$Since
    )

    try {
        $events = Get-WinEvent -FilterHashtable @{
            LogName = "Microsoft-Windows-Windows Defender/Operational"
            Id = 1121
        } -MaxEvents 12 -ErrorAction Stop
    }
    catch {
        return $null
    }

    $normalizedPath = $Path.ToLowerInvariant()
    foreach ($event in $events) {
        if ($event.Message.ToLowerInvariant().Contains($normalizedPath)) {
            return $event
        }
    }
    foreach ($event in $events) {
        if ($event.TimeCreated -ge $Since.AddMinutes(-1) -and $event.Message.Contains("01443614-CD74-433A-B99E-2ECDC07BFC25")) {
            return $event
        }
    }
    foreach ($event in $events) {
        if ($event.Message.Contains("01443614-CD74-433A-B99E-2ECDC07BFC25")) {
            return $event
        }
    }
    return $null
}

function New-AsrBlockedMessage {
    param(
        [Parameter(Mandatory = $true)][string]$ExePath,
        $Event
    )

    $eventText = "No matching Defender ASR event was found in the current log window."
    if ($null -ne $Event) {
        $eventText = $Event.Message
    }

    return @"
KimiCowork.exe could not be launched. This machine currently appears to block locally built executables before the window can be tested.

Executable:
$ExePath

Latest Defender ASR evidence:
$eventText

To complete this smoke test, allow this exact executable path in Microsoft Defender / enterprise ASR policy, then rerun:
Add-MpPreference -AttackSurfaceReductionOnlyExclusions "$ExePath"
pwsh -NoProfile -ExecutionPolicy Bypass -File .\scripts\smoke-windows-client.ps1
"@
}

$workspaceArg = "--workspace=`"$workspace`""
$launchAttemptAt = Get-Date
$process = $null
try {
    $process = Start-Process -FilePath $exe -ArgumentList $workspaceArg -WorkingDirectory $buildDir -PassThru -ErrorAction Stop
}
catch {
    Start-Sleep -Milliseconds 1500
    $asrEvent = Get-LatestDefenderAsrEvent -Path $exe -Since $launchAttemptAt.AddMinutes(-1)
    throw (New-AsrBlockedMessage -ExePath $exe -Event $asrEvent)
}

try {
    $window = Wait-ForMainWindow -Process $process
    Start-Sleep -Milliseconds 500

    $children = Get-Children -Window $window

    $newChat = Find-Child -Children $children -ClassName "Button" -TextContains "新建会话"
    $chooseWorkspace = Find-Child -Children $children -ClassName "Button" -TextContains "选择本地文件夹"
    $generatePlan = Find-Child -Children $children -ClassName "Button" -TextContains "生成计划"
    $approve = Find-Child -Children $children -ClassName "Button" -TextContains "审批执行"
    $developer = Find-Child -Children $children -ClassName "Button" -TextContains "Developer Mode"
    $fileList = Find-Child -Children $children -ClassName "ListBox"
    $artifact = Find-Child -Children $children -ClassName "Edit" -TextContains "工作区："

    Assert-True ($null -ne $newChat) "New chat button not found"
    Assert-True ($null -ne $chooseWorkspace) "Workspace picker button not found"
    Assert-True ($null -ne $generatePlan) "Generate plan button not found"
    Assert-True ($null -ne $approve) "Approval button not found"
    Assert-True ($null -ne $developer) "Developer Mode button not found"
    Assert-True ($null -ne $fileList) "File list not found"
    if ($null -eq $artifact) {
        $children |
            Where-Object { $_.ClassName -eq "Edit" } |
            ForEach-Object {
                $preview = $_.Text.Replace("`r", "<CR>").Replace("`n", "<LF>")
                Write-Host "Edit control text: $preview"
            }
    }
    Assert-True ($null -ne $artifact) "Artifact panel did not show auto-loaded workspace"

    $lbGetCount = 0x018B
    $fileCount = [KcwSmokeWin32]::SendMessage($fileList.Hwnd, $lbGetCount, [IntPtr]::Zero, [IntPtr]::Zero).ToInt32()
    Assert-True ($fileCount -ge 3) "Expected at least 3 scanned files, got $fileCount"

    $bmClick = 0x00F5
    [KcwSmokeWin32]::SendMessage($generatePlan.Hwnd, $bmClick, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
    Start-Sleep -Milliseconds 300
    $artifactText = [KcwSmokeWin32]::Text($artifact.Hwnd)
    Assert-True ($artifactText.Contains("Agent Cowork 执行计划")) "Generate plan did not update artifact panel"
    Assert-True ($artifactText.Contains("本地内容摘要")) "Generate plan did not include local content summary"
    Assert-True ($artifactText.Contains("已读取摘要文件")) "Generate plan did not include local read count"
    Assert-True ($artifactText.Contains("renewal date")) "Generate plan did not read trusted workspace file content"
    Assert-True ($artifactText.Contains("文件操作预览")) "Generate plan did not include file operation preview"
    Assert-True ($artifactText.Contains("类型：move")) "Generate plan did not include move preview"

    [KcwSmokeWin32]::SendMessage($approve.Hwnd, $bmClick, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
    Start-Sleep -Milliseconds 300
    $artifactText = [KcwSmokeWin32]::Text($artifact.Hwnd)
    Assert-True ($artifactText.Contains("审批记录")) "Approval did not append approval record"
    Assert-True ($artifactText.Contains("approved_applied")) "Approval did not apply the approved artifact"
    Assert-True ($artifactText.Contains("move_applied")) "Approval did not apply the approved move operation"

    $artifactDir = Join-Path $workspace ".KimiCowork\artifacts"
    $auditPath = Join-Path $workspace ".KimiCowork\audit\audit.jsonl"
    $rollbackDir = Join-Path $workspace ".KimiCowork\rollback"
    $artifactFiles = @(Get-ChildItem -LiteralPath $artifactDir -Filter "office-plan-*.md" -File -ErrorAction SilentlyContinue)
    $rollbackFiles = @(Get-ChildItem -LiteralPath $rollbackDir -Filter "rollback-*.jsonl" -File -ErrorAction SilentlyContinue)
    Assert-True ($artifactFiles.Count -eq 1) "Expected one generated Markdown artifact, got $($artifactFiles.Count)"
    Assert-True (Test-Path -LiteralPath $auditPath) "Audit log was not created: $auditPath"
    Assert-True ($rollbackFiles.Count -eq 1) "Expected one rollback journal, got $($rollbackFiles.Count)"

    $generatedArtifact = Get-Content -LiteralPath $artifactFiles[0].FullName -Raw
    $auditLog = Get-Content -LiteralPath $auditPath -Raw
    $rollbackLog = Get-Content -LiteralPath $rollbackFiles[0].FullName -Raw
    Assert-True ($generatedArtifact.Contains("Agent Cowork Office Mode 产物")) "Generated artifact content is missing title"
    Assert-True ($generatedArtifact.Contains("本地内容摘要")) "Generated artifact is missing local content summary"
    Assert-True ($auditLog.Contains('"event":"approval_apply"')) "Audit log does not contain approval_apply event"
    Assert-True ($auditLog.Contains('"event":"file_move_apply"')) "Audit log does not contain file_move_apply event"
    Assert-True ($rollbackLog.Contains('"operation":"write_new_artifact"')) "Rollback log does not contain write_new_artifact operation"
    Assert-True ($rollbackLog.Contains('"operation":"move_file"')) "Rollback log does not contain move_file operation"

    $moveRoot = Join-Path $workspace "Kimi_Cowork整理"
    $movedFiles = @(Get-ChildItem -LiteralPath $moveRoot -Recurse -File -ErrorAction SilentlyContinue)
    Assert-True ($movedFiles.Count -eq 1) "Expected one moved file under Kimi_Cowork整理, got $($movedFiles.Count)"
    $movedFilePath = $movedFiles[0].FullName
    Assert-True ($movedFilePath.StartsWith($moveRoot, [System.StringComparison]::OrdinalIgnoreCase)) "Moved file is outside the expected move root: $movedFilePath"

    [KcwSmokeWin32]::SendMessage($developer.Hwnd, $bmClick, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
    Start-Sleep -Milliseconds 300
    $artifactText = [KcwSmokeWin32]::Text($artifact.Hwnd)
    Assert-True ($artifactText.Contains("Developer Mode")) "Developer Mode did not update artifact panel"

    [pscustomobject]@{
        WindowTitle = $process.MainWindowTitle
        Workspace = $workspace
        ScannedFiles = $fileCount
        GeneratePlan = "passed"
        Approve = "passed"
        ArtifactPath = $artifactFiles[0].FullName
        MovedFilePath = $movedFilePath
        AuditPath = $auditPath
        RollbackPath = $rollbackFiles[0].FullName
        DeveloperMode = "passed"
    }
}
finally {
    if (-not $KeepOpen) {
        if (-not $process.HasExited) {
            $process.CloseMainWindow() | Out-Null
            if (-not $process.WaitForExit(2000)) {
                $process.Kill()
            }
        }
    }
}
