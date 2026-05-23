<#
.SYNOPSIS
  Code-sign the Agent Cowork Windows installers (MSI + NSIS setup.exe).

.DESCRIPTION
  Production distribution should be signed with a certificate from a trusted CA
  (an OV or, ideally, EV code-signing certificate). An EV certificate is what
  removes the Microsoft SmartScreen "unknown publisher" warning immediately; an
  OV certificate earns reputation over time. A SELF-SIGNED certificate (the
  -SelfSigned switch here) is ONLY for verifying that the signing pipeline works
  end to end — it does NOT remove SmartScreen warnings for end users, because
  their machines don't trust your self-signed root.

  Three credential modes (pick one):
    -Pfx <path> [-Password <secure>]   sign with a PFX/P12 file (CI-friendly)
    -Thumbprint <sha1>                 sign with a cert already in the cert store
    -SelfSigned                        generate/reuse a dev self-signed cert

.EXAMPLE
  # Real certificate (recommended for distribution):
  ./sign-windows.ps1 -Pfx C:\secrets\codesign.pfx -Password (Read-Host -AsSecureString)

.EXAMPLE
  # Verify the pipeline with a throwaway self-signed cert:
  ./sign-windows.ps1 -SelfSigned
#>
[CmdletBinding(DefaultParameterSetName = 'SelfSigned')]
param(
  [Parameter(ParameterSetName = 'Pfx', Mandatory = $true)]
  [string] $Pfx,
  [Parameter(ParameterSetName = 'Pfx')]
  [System.Security.SecureString] $Password,

  [Parameter(ParameterSetName = 'Thumbprint', Mandatory = $true)]
  [string] $Thumbprint,

  [Parameter(ParameterSetName = 'SelfSigned')]
  [switch] $SelfSigned,

  [string[]] $Files,
  [string] $TimestampUrl = 'http://timestamp.digicert.com',
  [string] $Publisher = 'CN=Agent Cowork (DEV SELF-SIGNED)'
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot

function Find-SignTool {
  $cmd = Get-Command signtool.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $candidates = Get-ChildItem 'C:\Program Files (x86)\Windows Kits\10\bin' -Recurse -Filter 'signtool.exe' -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match '\\x64\\' } |
    Sort-Object FullName -Descending
  if ($candidates) { return $candidates[0].FullName }
  throw 'signtool.exe not found. Install the Windows 10/11 SDK (Windows Kits).'
}

# Default to the two installers produced by `cargo tauri build`, copied into installers\.
if (-not $Files -or $Files.Count -eq 0) {
  $Files = @(
    (Join-Path $repoRoot 'installers\Agent Cowork_0.1.0_x64-setup.exe'),
    (Join-Path $repoRoot 'installers\Agent Cowork_0.1.0_x64_en-US.msi')
  )
}

$signtool = Find-SignTool
Write-Host "signtool: $signtool"

# --- Resolve the signing credential into signtool arguments ----------------
$credArgs = @()
$selfCertThumb = $null
switch ($PSCmdlet.ParameterSetName) {
  'Pfx' {
    if (-not (Test-Path $Pfx)) { throw "PFX not found: $Pfx" }
    $credArgs += @('/f', $Pfx)
    if ($Password) {
      $plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
        [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Password))
      $credArgs += @('/p', $plain)
    }
  }
  'Thumbprint' {
    $credArgs += @('/sha1', ($Thumbprint -replace '\s', ''))
  }
  'SelfSigned' {
    Write-Warning 'SELF-SIGNED mode: proves the pipeline only. It does NOT remove SmartScreen warnings for end users.'
    $existing = Get-ChildItem Cert:\CurrentUser\My -ErrorAction SilentlyContinue |
      Where-Object { $_.Subject -eq $Publisher -and $_.NotAfter -gt (Get-Date) } |
      Select-Object -First 1
    if ($existing) {
      $cert = $existing
      Write-Host "Reusing self-signed cert: $($cert.Thumbprint)"
    } else {
      $cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject $Publisher `
        -CertStoreLocation Cert:\CurrentUser\My -KeyUsage DigitalSignature `
        -KeyExportPolicy Exportable -NotAfter (Get-Date).AddYears(2)
      Write-Host "Created self-signed cert: $($cert.Thumbprint)"
    }
    $selfCertThumb = $cert.Thumbprint
    $credArgs += @('/sha1', $cert.Thumbprint)
  }
}

# --- Sign each file --------------------------------------------------------
foreach ($file in $Files) {
  if (-not (Test-Path $file)) { Write-Warning "skip (missing): $file"; continue }
  Write-Host "`nSigning: $file"
  $args = @('sign', '/fd', 'SHA256') + $credArgs
  # RFC3161 timestamp keeps the signature valid after the cert expires. It needs
  # network access; for an offline self-signed dry run, fall back to no timestamp.
  $timestamped = $args + @('/tr', $TimestampUrl, '/td', 'SHA256', $file)
  & $signtool @timestamped
  if ($LASTEXITCODE -ne 0) {
    Write-Warning "timestamped sign failed (offline?); retrying without timestamp"
    & $signtool @($args + @($file))
    if ($LASTEXITCODE -ne 0) { throw "signing failed for $file" }
  }
}

# --- Verify ----------------------------------------------------------------
foreach ($file in $Files) {
  if (-not (Test-Path $file)) { continue }
  Write-Host "`nVerifying: $file"
  # /pa = use the "Default Authentication Verification Policy". For a self-signed
  # cert this reports an untrusted-root error (expected) — the signature itself is
  # still present and structurally valid, which is all the dry run proves.
  & $signtool verify /pa /v $file
  if ($LASTEXITCODE -ne 0 -and $selfCertThumb) {
    Write-Warning 'verify /pa failed — expected for a self-signed cert (untrusted root). Signature is present.'
  } elseif ($LASTEXITCODE -ne 0) {
    throw "verification failed for $file"
  }
}

Write-Host "`nDone. Signed: $($Files -join ', ')"
if ($selfCertThumb) {
  Write-Host "Reminder: self-signed only. For distribution, re-run with -Pfx <real CA cert>."
}
