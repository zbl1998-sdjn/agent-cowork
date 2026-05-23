param([string]$Out)
$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class CapW {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
"@
# Make this capture process DPI-aware, otherwise on a 125% display GetWindowRect
# returns scaled-down logical coords (1381x898 for a real 1726x1122 window) and
# CopyFromScreen crops the right-side drawers.
[CapW]::SetProcessDPIAware() | Out-Null
# Pick the LARGEST top-level window among the desktop processes (the chat shell
# is 1726x1122; a stray secondary window is smaller and would crop side drawers).
$cands = Get-Process -Name 'agent-cowork-desktop' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 }
if (-not $cands) { "no Agent Cowork window"; exit 1 }
$best = $null; $bestArea = -1
foreach ($c in $cands) {
  $rr = New-Object CapW+RECT
  [CapW]::GetWindowRect($c.MainWindowHandle, [ref]$rr) | Out-Null
  $area = ($rr.Right - $rr.Left) * ($rr.Bottom - $rr.Top)
  if ($area -gt $bestArea) { $bestArea = $area; $best = $c }
}
$h = $best.MainWindowHandle
[CapW]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 700
$r = New-Object CapW+RECT
[CapW]::GetWindowRect($h, [ref]$r) | Out-Null
$w = $r.Right - $r.Left; $hh = $r.Bottom - $r.Top
$bmp = New-Object System.Drawing.Bitmap($w, $hh)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($r.Left, $r.Top, 0, 0, $bmp.Size)
$dir = Split-Path $Out -Parent
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
"SAVED $Out ($w x $hh)"
