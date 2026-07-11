<#
.SYNOPSIS
  Code-sign or verify the explicitly supplied Agent Cowork Windows PE/MSI files.

.DESCRIPTION
  Production distribution should be signed with a certificate from a trusted CA
  (an OV or, ideally, EV code-signing certificate). An EV certificate is what
  removes the Microsoft SmartScreen "unknown publisher" warning immediately; an
  OV certificate earns reputation over time. A SELF-SIGNED certificate (the
  -SelfSigned switch here) is ONLY for verifying that the signing pipeline works
  end to end — it does NOT remove SmartScreen warnings for end users, because
  their machines don't trust your self-signed root.

  Four modes (pick one):
    -Pfx <path> [-Password <secure>]   sign with a PFX/P12 file (CI-friendly)
    -Thumbprint <sha1>                 sign with a cert already in the cert store
    -SelfSigned                        generate/reuse a dev self-signed cert
    -VerifyOnly -ExpectedThumbprint/-ExpectedPfx
                                        verify trust and the configured signer identity

  For non-interactive release automation, PFX mode may read the password from
  KCW_CODESIGN_PFX_PASSWORD or WINDOWS_SIGNING_PFX_PASSWORD. Prefer
  -Thumbprint with a cert already imported into the Windows certificate store
  when possible, so the PFX password never needs to enter process arguments.

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
  [Parameter(ParameterSetName = 'VerifyOnly')]
  [System.Security.SecureString] $Password,

  [Parameter(ParameterSetName = 'Thumbprint', Mandatory = $true)]
  [string] $Thumbprint,

  [Parameter(ParameterSetName = 'SelfSigned')]
  [switch] $SelfSigned,

  [Parameter(ParameterSetName = 'VerifyOnly', Mandatory = $true)]
  [switch] $VerifyOnly,

  [Parameter(ParameterSetName = 'VerifyOnly')]
  [string] $ExpectedThumbprint,

  [Parameter(ParameterSetName = 'VerifyOnly')]
  [string] $ExpectedPfx,

  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string[]] $Files,
  [string] $TimestampUrl = 'https://timestamp.digicert.com',
  [ValidateRange(1, 600)]
  [int] $SignToolTimeoutSeconds = 120,
  [string] $Publisher = 'CN=Agent Cowork (DEV SELF-SIGNED)'
)

$ErrorActionPreference = 'Stop'

function Normalize-Thumbprint {
  param([Parameter(Mandatory = $true)][string] $Value)
  $normalized = ($Value -replace '\s', '').ToUpperInvariant()
  if ($normalized -notmatch '^[0-9A-F]{40}$') {
    throw 'Certificate thumbprint must contain exactly 40 hexadecimal characters.'
  }
  return $normalized
}

function Resolve-PfxSignerThumbprint {
  param(
    [Parameter(Mandatory = $true)][string] $Path,
    [System.Security.SecureString] $PfxPassword
  )
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "PFX not found: $Path" }
  $plainPassword = $null
  $bstr = [IntPtr]::Zero
  $certificate = $null
  try {
    if ($PfxPassword) {
      $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($PfxPassword)
      $plainPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    }
    $flags = [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::EphemeralKeySet
    $certificate = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new(
      $Path,
      $plainPassword,
      $flags
    )
    if (-not $certificate.HasPrivateKey) {
      throw "PFX signer certificate has no private key: $Path"
    }
    $now = Get-Date
    if ($certificate.NotBefore -gt $now -or $certificate.NotAfter -le $now) {
      throw "PFX signer certificate is not currently valid: $($certificate.Subject)"
    }
    $eku = $certificate.Extensions |
      Where-Object { $_ -is [System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension] } |
      Select-Object -First 1
    if ($eku -and -not ($eku.EnhancedKeyUsages | Where-Object { $_.Value -eq '1.3.6.1.5.5.7.3.3' })) {
      throw "PFX certificate is not valid for code signing: $($certificate.Subject)"
    }
    return Normalize-Thumbprint -Value $certificate.Thumbprint
  } finally {
    if ($certificate) { $certificate.Dispose() }
    if ($bstr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
    $plainPassword = $null
  }
}

function Get-AuthenticodeSignerThumbprint {
  param([Parameter(Mandatory = $true)][string] $File)
  $signature = Get-AuthenticodeSignature -LiteralPath $File
  if (-not $signature.SignerCertificate -or -not $signature.SignerCertificate.Thumbprint) {
    return $null
  }
  return Normalize-Thumbprint -Value $signature.SignerCertificate.Thumbprint
}

function Assert-ExpectedSigner {
  param(
    [Parameter(Mandatory = $true)][string] $File,
    [Parameter(Mandatory = $true)][string] $ExpectedSignerThumbprint
  )
  $actual = Get-AuthenticodeSignerThumbprint -File $File
  if (-not $actual) { throw "Authenticode signer certificate missing for $File" }
  if ($actual -ne $ExpectedSignerThumbprint) {
    throw "Authenticode signer mismatch for $File (expected $ExpectedSignerThumbprint, actual $actual)"
  }
}

function Find-SignTool {
  $cmd = Get-Command signtool.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $candidates = Get-ChildItem 'C:\Program Files (x86)\Windows Kits\10\bin' -Recurse -Filter 'signtool.exe' -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match '\\x64\\' } |
    Sort-Object FullName -Descending
  if ($candidates) { return $candidates[0].FullName }
  throw 'signtool.exe not found. Install the Windows 10/11 SDK (Windows Kits).'
}

function Read-FirstEnvValue {
  param([string[]] $Names)
  foreach ($name in $Names) {
    $value = [Environment]::GetEnvironmentVariable($name)
    if (-not [string]::IsNullOrWhiteSpace($value)) { return $value }
  }
  return $null
}

function Invoke-SignTool {
  param(
    [Parameter(Mandatory = $true)]
    [string[]] $Arguments,
    [switch] $Quiet
  )
  $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $script:signtool
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  foreach ($argument in $Arguments) { [void] $startInfo.ArgumentList.Add($argument) }

  $process = [System.Diagnostics.Process]::new()
  $process.StartInfo = $startInfo
  try {
    if (-not $process.Start()) { throw 'signtool.exe failed to start' }
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit($SignToolTimeoutSeconds * 1000)) {
      $process.Kill($true)
      $process.WaitForExit()
      throw "signtool.exe timed out after $SignToolTimeoutSeconds seconds"
    }
    $stdout = $stdoutTask.GetAwaiter().GetResult().Trim()
    $stderr = $stderrTask.GetAwaiter().GetResult().Trim()
    if (-not $Quiet -and $stdout) { Write-Host $stdout }
    if (-not $Quiet -and $stderr) { Write-Warning $stderr }
    return $process.ExitCode
  } finally {
    $process.Dispose()
  }
}

foreach ($file in $Files) {
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
    throw "signing target missing: $file"
  }
}

$script:signtool = Find-SignTool
Write-Host "signtool: $signtool"

# --- Resolve the signing credential into signtool arguments ----------------
$credArgs = @()
$selfCertThumb = $null
$expectedSignerThumbprint = $null
switch ($PSCmdlet.ParameterSetName) {
  'Pfx' {
    if (-not $Password) {
      $envPassword = Read-FirstEnvValue -Names @('KCW_CODESIGN_PFX_PASSWORD', 'WINDOWS_SIGNING_PFX_PASSWORD')
      if ($envPassword) {
        $Password = ConvertTo-SecureString -String $envPassword -AsPlainText -Force
        Write-Host 'Using PFX password from environment variable (value hidden).'
      }
    }
    $expectedSignerThumbprint = Resolve-PfxSignerThumbprint -Path $Pfx -PfxPassword $Password
    $credArgs += @('/f', $Pfx)
    if ($Password) {
      $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Password)
      try {
        $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
      } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
      }
      $credArgs += @('/p', $plain)
    }
  }
  'Thumbprint' {
    $expectedSignerThumbprint = Normalize-Thumbprint -Value $Thumbprint
    $credArgs += @('/sha1', $expectedSignerThumbprint)
  }
  'VerifyOnly' {
    $hasExpectedThumbprint = -not [string]::IsNullOrWhiteSpace($ExpectedThumbprint)
    $hasExpectedPfx = -not [string]::IsNullOrWhiteSpace($ExpectedPfx)
    if ($hasExpectedThumbprint -eq $hasExpectedPfx) {
      throw 'VerifyOnly requires exactly one of -ExpectedThumbprint or -ExpectedPfx.'
    }
    if ($hasExpectedThumbprint) {
      $expectedSignerThumbprint = Normalize-Thumbprint -Value $ExpectedThumbprint
    } else {
      if (-not $Password) {
        $envPassword = Read-FirstEnvValue -Names @('KCW_CODESIGN_PFX_PASSWORD', 'WINDOWS_SIGNING_PFX_PASSWORD')
        if ($envPassword) { $Password = ConvertTo-SecureString -String $envPassword -AsPlainText -Force }
      }
      $expectedSignerThumbprint = Resolve-PfxSignerThumbprint -Path $ExpectedPfx -PfxPassword $Password
    }
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
    $expectedSignerThumbprint = Normalize-Thumbprint -Value $cert.Thumbprint
    $credArgs += @('/sha1', $expectedSignerThumbprint)
  }
}
if (-not $expectedSignerThumbprint) { throw 'Unable to resolve the expected signer thumbprint.' }

# --- Sign each file --------------------------------------------------------
if (-not $VerifyOnly) {
  foreach ($file in $Files) {
    $trustedSignature = (Invoke-SignTool -Arguments @('verify', '/pa', $file) -Quiet) -eq 0
    $existingSigner = Get-AuthenticodeSignerThumbprint -File $file
    if ($trustedSignature -and $existingSigner -eq $expectedSignerThumbprint) {
      Write-Host "`nAlready trusted-signed by the configured certificate; skipping: $file"
      continue
    }
    if ($trustedSignature -and $existingSigner) {
      Write-Warning "Trusted signature belongs to a different certificate ($existingSigner); replacing it: $file"
    }
    Write-Host "`nSigning: $file"
    $args = @('sign', '/fd', 'SHA256') + $credArgs
    # RFC3161 timestamp keeps the signature valid after the cert expires.
    $timestamped = $args + @('/tr', $TimestampUrl, '/td', 'SHA256', $file)
    $signExitCode = Invoke-SignTool -Arguments $timestamped
    if ($signExitCode -ne 0) {
      if (-not $selfCertThumb) {
        throw "timestamped signing failed for $file"
      }
      Write-Warning 'timestamped self-signed development sign failed; retrying without timestamp'
      $signExitCode = Invoke-SignTool -Arguments ($args + @($file))
      if ($signExitCode -ne 0) { throw "signing failed for $file" }
    }
  }
}

# --- Verify ----------------------------------------------------------------
foreach ($file in $Files) {
  Write-Host "`nVerifying: $file"
  # /pa = use the "Default Authentication Verification Policy". For a self-signed
  # cert this reports an untrusted-root error (expected) — the signature itself is
  # still present and structurally valid, which is all the dry run proves.
  $verifyExitCode = Invoke-SignTool -Arguments @('verify', '/pa', '/v', $file)
  if ($verifyExitCode -ne 0 -and $selfCertThumb) {
    Write-Warning 'verify /pa failed — expected for a self-signed cert (untrusted root). Signature is present.'
  } elseif ($verifyExitCode -ne 0) {
    throw "verification failed for $file"
  }
  Assert-ExpectedSigner -File $file -ExpectedSignerThumbprint $expectedSignerThumbprint
}

if ($VerifyOnly) {
  Write-Host "`nDone. Verified: $($Files -join ', ')"
} else {
  Write-Host "`nDone. Signed and verified: $($Files -join ', ')"
}
if ($selfCertThumb) {
  Write-Host "Reminder: self-signed only. For distribution, re-run with -Pfx <real CA cert>."
}
