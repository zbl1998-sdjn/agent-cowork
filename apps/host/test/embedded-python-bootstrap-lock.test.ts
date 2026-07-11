import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const scriptPath = path.join(repoRoot, 'scripts', 'prepare-embedded-python.ps1');
const bootstrapLockPath = path.join(
  repoRoot,
  'apps',
  'windows-client',
  'resources',
  'python-bootstrap.lock',
);
const script = fs.readFileSync(scriptPath, 'utf8');
const bootstrapLock = fs.readFileSync(bootstrapLockPath, 'utf8');

test('pip bootstrap lock identifies one exact official wheel and SHA256', () => {
  assert.match(bootstrapLock, /^# schema: 1$/m);
  assert.match(
    bootstrapLock,
    /^# source-url: https:\/\/files\.pythonhosted\.org\/packages\/[a-f0-9/]+\/pip-26\.1\.2-py3-none-any\.whl$/m,
  );
  assert.match(bootstrapLock, /^pip==26\.1\.2 \\$/m);
  assert.match(
    bootstrapLock,
    /^\s+--hash=sha256:382ff9f685ee3bc25864f820aa50505825f10f5458ffff07e30a6d96e5715cab$/m,
  );
});

test('embedded Python stages the verified wheel and invokes installed pip without an index', () => {
  assert.match(script, /function\s+Get-PipBootstrapLock/);
  assert.match(script, /function\s+Get-VerifiedPipBootstrapWheel/);
  assert.match(script, /function\s+Expand-PipBootstrapWheel/);
  assert.match(script, /function\s+Install-PipBootstrap/);
  assert.match(script, /\[System\.IO\.Compression\.ZipFile\]::OpenRead/);
  assert.match(script, /["']-m["'],\s*["']pip["']/);
  assert.match(script, /['"]--isolated['"]/);
  assert.match(script, /['"]--no-index['"]/);
  assert.match(script, /['"]--no-deps['"]/);
  assert.match(script, /Test-Sha256 -FilePath \$WheelPath -Expected \$PipBootstrap\.Sha256/);
  assert.doesNotMatch(script, /runpy\.run_module/);
  assert.doesNotMatch(script, /bootstrap\.pypa\.io|\$GetPip|getPipPath/i);
});

test('pip bootstrap helpers fail closed on unsafe wheel entries, malformed locks, cache pollution, and tampering', () => {
  const harnessRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-pip-bootstrap-lock-'));
  const harnessPath = path.join(harnessRoot, 'bootstrap-harness.ps1');
  const escapedScriptPath = scriptPath.replaceAll("'", "''");
  const escapedLockPath = bootstrapLockPath.replaceAll("'", "''");
  const harness = String.raw`
$ErrorActionPreference = 'Stop'
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile('${escapedScriptPath}', [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -ne 0) { throw "script parse failed: $($parseErrors -join '; ')" }
$functions = $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)
foreach ($function in $functions) { . ([scriptblock]::Create($function.Extent.Text)) }

function Assert-Harness([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

$real = Get-PipBootstrapLock -LockPath '${escapedLockPath}'
Assert-Harness ($real.Version -eq '26.1.2') 'real bootstrap version was not parsed'
Assert-Harness ($real.Requirement -eq 'pip==26.1.2') 'real bootstrap requirement was not parsed'
Assert-Harness ($real.FileName -eq 'pip-26.1.2-py3-none-any.whl') 'real wheel filename was not parsed'
Assert-Harness ($real.Sha256 -eq '382ff9f685ee3bc25864f820aa50505825f10f5458ffff07e30a6d96e5715cab') 'real wheel hash was not parsed'

$root = Join-Path ([System.IO.Path]::GetTempPath()) ('kcw-pip-bootstrap-' + [guid]::NewGuid().ToString('N'))
try {
    $cache = Join-Path $root 'cache'
    $lockPath = Join-Path $root 'python-bootstrap.lock'
    $sourceWheel = Join-Path $root 'pip-1.2.3-py3-none-any.whl'
    New-Item -ItemType Directory -Path $cache -Force | Out-Null

    function Add-WheelTextEntry {
        param($Archive, [string]$Name, [string]$Text)
        $entry = $Archive.CreateEntry($Name)
        $writer = [System.IO.StreamWriter]::new($entry.Open(), [System.Text.UTF8Encoding]::new($false))
        try { $writer.Write($Text) } finally { $writer.Dispose() }
    }

    $archive = [System.IO.Compression.ZipFile]::Open($sourceWheel, [System.IO.Compression.ZipArchiveMode]::Create)
    try {
        Add-WheelTextEntry -Archive $archive -Name 'pip/__init__.py' -Text ("__version__ = '1.2.3'" + [Environment]::NewLine)
        Add-WheelTextEntry -Archive $archive -Name 'pip-1.2.3.dist-info/WHEEL' -Text ('Wheel-Version: 1.0' + [Environment]::NewLine + 'Root-Is-Purelib: true' + [Environment]::NewLine + 'Tag: py3-none-any' + [Environment]::NewLine)
        Add-WheelTextEntry -Archive $archive -Name 'pip-1.2.3.dist-info/METADATA' -Text ('Metadata-Version: 2.1' + [Environment]::NewLine + 'Name: pip' + [Environment]::NewLine + 'Version: 1.2.3' + [Environment]::NewLine)
        Add-WheelTextEntry -Archive $archive -Name 'pip-1.2.3.dist-info/RECORD' -Text ''
    } finally {
        $archive.Dispose()
    }
    $wheelSha = (Get-FileHash -LiteralPath $sourceWheel -Algorithm SHA256).Hash.ToLowerInvariant()
    Set-Content -LiteralPath $lockPath -Encoding ascii -Value @(
        '# schema: 1'
        '# source-url: https://files.pythonhosted.org/packages/test/pip-1.2.3-py3-none-any.whl'
        'pip==1.2.3 \'
        "    --hash=sha256:$wheelSha"
    )
    $config = Get-PipBootstrapLock -LockPath $lockPath
    $wheelhouse = Join-Path (Join-Path $cache 'pip-bootstrap') $wheelSha
    New-Item -ItemType Directory -Path $wheelhouse -Force | Out-Null
    $wheelPath = Join-Path $wheelhouse $config.FileName
    Copy-Item -LiteralPath $sourceWheel -Destination $wheelPath

    $script:downloadCount = 0
    function Invoke-Download { $script:downloadCount += 1; throw 'unexpected download' }
    $resolved = Get-VerifiedPipBootstrapWheel -PipBootstrap $config -CacheDir $cache -DownloadTimeoutSec 5
    Assert-Harness ($resolved -eq $wheelPath) 'verified cached wheel was not returned'
    Assert-Harness ($script:downloadCount -eq 0) 'cache hit unexpectedly downloaded the wheel'

    $script:processCount = 0
    function Invoke-BoundedProcess {
        param($FilePath, $Arguments, $TimeoutSec, $Label)
        $script:processCount += 1
        Assert-Harness ($Arguments[0] -eq '-I') 'bootstrap runner did not isolate Python'
        Assert-Harness ($Arguments[1] -eq '-m') 'bootstrap runner did not use an installed module entrypoint'
        Assert-Harness ($Arguments[2] -eq 'pip') 'bootstrap runner did not invoke installed pip'
        Assert-Harness ($Arguments -contains '--isolated') 'pip isolated mode is missing'
        Assert-Harness ($Arguments -contains '--no-index') 'pip index access was not disabled'
        Assert-Harness ($Arguments -contains '--no-deps') 'bootstrap dependency resolution was not disabled'
        Assert-Harness ($Arguments[-1] -eq $wheelPath) 'bootstrap runner did not receive the verified wheel'
        return [pscustomobject]@{ ExitCode = 0; Stdout = ''; Stderr = ''; Output = '' }
    }
    $pythonHome = Join-Path $root 'python-home'
    $pythonExe = Join-Path $pythonHome 'python.exe'
    $sitePackages = Join-Path $pythonHome 'Lib\site-packages'
    New-Item -ItemType Directory -Path $sitePackages -Force | Out-Null
    Set-Content -LiteralPath $pythonExe -Value 'fake' -NoNewline
    Install-PipBootstrap -PythonExe $pythonExe -WheelPath $resolved -PipBootstrap $config -ProcessTimeoutSec 5
    Assert-Harness ($script:processCount -eq 1) 'verified wheel did not execute exactly once'
    Assert-Harness (Test-Path -LiteralPath (Join-Path $sitePackages 'pip\__init__.py') -PathType Leaf) 'verified wheel was not staged into site-packages'
    $nonEmptyBlocked = $false
    try {
        Expand-PipBootstrapWheel -PythonExe $pythonExe -WheelPath $wheelPath -PipBootstrap $config | Out-Null
    } catch {
        $nonEmptyBlocked = $_.Exception.Message -match 'empty site-packages'
    }
    Assert-Harness $nonEmptyBlocked 'a non-empty bootstrap staging directory was accepted'

    Set-Content -LiteralPath $wheelPath -Value 'tampered' -NoNewline
    $tamperBlocked = $false
    try {
        Install-PipBootstrap -PythonExe $pythonExe -WheelPath $wheelPath -PipBootstrap $config -ProcessTimeoutSec 5
    } catch {
        $tamperBlocked = $_.Exception.Message -match 'SHA256 mismatch'
    }
    Assert-Harness $tamperBlocked 'tampered wheel was not rejected before execution'
    Assert-Harness ($script:processCount -eq 1) 'tampered wheel reached the Python process'

    Copy-Item -LiteralPath $sourceWheel -Destination $wheelPath -Force
    Set-Content -LiteralPath (Join-Path $wheelhouse 'unexpected.whl') -Value 'pollution' -NoNewline
    $pollutionBlocked = $false
    try {
        Get-VerifiedPipBootstrapWheel -PipBootstrap $config -CacheDir $cache -DownloadTimeoutSec 5 | Out-Null
    } catch {
        $pollutionBlocked = $_.Exception.Message -match 'exactly the locked wheel'
    }
    Assert-Harness $pollutionBlocked 'polluted wheelhouse was accepted'

    $maliciousHome = Join-Path $root 'malicious-python-home'
    $maliciousPython = Join-Path $maliciousHome 'python.exe'
    $maliciousSitePackages = Join-Path $maliciousHome 'Lib\site-packages'
    $maliciousWheelDir = Join-Path $root 'malicious-wheel'
    $maliciousWheel = Join-Path $maliciousWheelDir $config.FileName
    New-Item -ItemType Directory -Path $maliciousSitePackages, $maliciousWheelDir -Force | Out-Null
    Set-Content -LiteralPath $maliciousPython -Value 'fake' -NoNewline
    $archive = [System.IO.Compression.ZipFile]::Open($maliciousWheel, [System.IO.Compression.ZipArchiveMode]::Create)
    try {
        Add-WheelTextEntry -Archive $archive -Name 'pip/__init__.py' -Text ("__version__ = '1.2.3'" + [Environment]::NewLine)
        Add-WheelTextEntry -Archive $archive -Name 'pip-1.2.3.dist-info/WHEEL' -Text ('Wheel-Version: 1.0' + [Environment]::NewLine + 'Root-Is-Purelib: true' + [Environment]::NewLine + 'Tag: py3-none-any' + [Environment]::NewLine)
        Add-WheelTextEntry -Archive $archive -Name 'pip-1.2.3.dist-info/METADATA' -Text ('Metadata-Version: 2.1' + [Environment]::NewLine + 'Name: pip' + [Environment]::NewLine + 'Version: 1.2.3' + [Environment]::NewLine)
        Add-WheelTextEntry -Archive $archive -Name 'pip-1.2.3.dist-info/RECORD' -Text ''
        Add-WheelTextEntry -Archive $archive -Name '../escape.py' -Text 'unsafe'
    } finally {
        $archive.Dispose()
    }
    $maliciousConfig = $config.PSObject.Copy()
    $maliciousConfig.Sha256 = (Get-FileHash -LiteralPath $maliciousWheel -Algorithm SHA256).Hash.ToLowerInvariant()
    $unsafeEntryBlocked = $false
    try {
        Expand-PipBootstrapWheel -PythonExe $maliciousPython -WheelPath $maliciousWheel -PipBootstrap $maliciousConfig | Out-Null
    } catch {
        $unsafeEntryBlocked = $_.Exception.Message -match 'unsafe|traversal'
    }
    Assert-Harness $unsafeEntryBlocked 'wheel path traversal entry was accepted'
    Assert-Harness (-not (Test-Path -LiteralPath (Join-Path $maliciousHome 'Lib\escape.py'))) 'wheel path traversal escaped site-packages'

    $metadataHome = Join-Path $root 'metadata-python-home'
    $metadataPython = Join-Path $metadataHome 'python.exe'
    $metadataSitePackages = Join-Path $metadataHome 'Lib\site-packages'
    $metadataWheelDir = Join-Path $root 'metadata-wheel'
    $metadataWheel = Join-Path $metadataWheelDir $config.FileName
    New-Item -ItemType Directory -Path $metadataSitePackages, $metadataWheelDir -Force | Out-Null
    Set-Content -LiteralPath $metadataPython -Value 'fake' -NoNewline
    $archive = [System.IO.Compression.ZipFile]::Open($metadataWheel, [System.IO.Compression.ZipArchiveMode]::Create)
    try {
        Add-WheelTextEntry -Archive $archive -Name 'pip/__init__.py' -Text ("__version__ = '1.2.3'" + [Environment]::NewLine)
        Add-WheelTextEntry -Archive $archive -Name 'pip-1.2.3.dist-info/WHEEL' -Text ('Wheel-Version: 1.0' + [Environment]::NewLine + 'Root-Is-Purelib: true' + [Environment]::NewLine + 'Tag: py3-none-any' + [Environment]::NewLine)
        Add-WheelTextEntry -Archive $archive -Name 'pip-1.2.3.dist-info/METADATA' -Text ('Metadata-Version: 2.1' + [Environment]::NewLine + 'Name: pip' + [Environment]::NewLine + 'Version: 9.9.9' + [Environment]::NewLine)
        Add-WheelTextEntry -Archive $archive -Name 'pip-1.2.3.dist-info/RECORD' -Text ''
    } finally {
        $archive.Dispose()
    }
    $metadataConfig = $config.PSObject.Copy()
    $metadataConfig.Sha256 = (Get-FileHash -LiteralPath $metadataWheel -Algorithm SHA256).Hash.ToLowerInvariant()
    $metadataBlocked = $false
    try {
        Expand-PipBootstrapWheel -PythonExe $metadataPython -WheelPath $metadataWheel -PipBootstrap $metadataConfig | Out-Null
    } catch {
        $metadataBlocked = $_.Exception.Message -match 'METADATA'
    }
    Assert-Harness $metadataBlocked 'wheel metadata version drift was accepted'
    Assert-Harness (@(Get-ChildItem -LiteralPath $metadataSitePackages -Force).Count -eq 0) 'invalid metadata left partial bootstrap files'

    $linkHome = Join-Path $root 'link-python-home'
    $linkPython = Join-Path $linkHome 'python.exe'
    $linkSitePackages = Join-Path $linkHome 'Lib\site-packages'
    $linkWheelDir = Join-Path $root 'link-wheel'
    $linkWheel = Join-Path $linkWheelDir $config.FileName
    New-Item -ItemType Directory -Path $linkSitePackages, $linkWheelDir -Force | Out-Null
    Set-Content -LiteralPath $linkPython -Value 'fake' -NoNewline
    $archive = [System.IO.Compression.ZipFile]::Open($linkWheel, [System.IO.Compression.ZipArchiveMode]::Create)
    try {
        Add-WheelTextEntry -Archive $archive -Name 'pip/__init__.py' -Text ("__version__ = '1.2.3'" + [Environment]::NewLine)
        Add-WheelTextEntry -Archive $archive -Name 'pip-1.2.3.dist-info/WHEEL' -Text ('Wheel-Version: 1.0' + [Environment]::NewLine + 'Root-Is-Purelib: true' + [Environment]::NewLine + 'Tag: py3-none-any' + [Environment]::NewLine)
        Add-WheelTextEntry -Archive $archive -Name 'pip-1.2.3.dist-info/METADATA' -Text ('Metadata-Version: 2.1' + [Environment]::NewLine + 'Name: pip' + [Environment]::NewLine + 'Version: 1.2.3' + [Environment]::NewLine)
        Add-WheelTextEntry -Archive $archive -Name 'pip-1.2.3.dist-info/RECORD' -Text ''
        $linkEntry = $archive.CreateEntry('pip/link.py')
        $linkEntry.ExternalAttributes = [System.BitConverter]::ToInt32(
            [System.BitConverter]::GetBytes([uint32]2717843456),
            0
        )
        $linkWriter = [System.IO.StreamWriter]::new($linkEntry.Open(), [System.Text.UTF8Encoding]::new($false))
        try { $linkWriter.Write('target.py') } finally { $linkWriter.Dispose() }
    } finally {
        $archive.Dispose()
    }
    $linkConfig = $config.PSObject.Copy()
    $linkConfig.Sha256 = (Get-FileHash -LiteralPath $linkWheel -Algorithm SHA256).Hash.ToLowerInvariant()
    $linkBlocked = $false
    try {
        Expand-PipBootstrapWheel -PythonExe $linkPython -WheelPath $linkWheel -PipBootstrap $linkConfig | Out-Null
    } catch {
        $linkBlocked = $_.Exception.Message -match 'link or special'
    }
    Assert-Harness $linkBlocked 'wheel symlink entry was accepted'
    Assert-Harness (@(Get-ChildItem -LiteralPath $linkSitePackages -Force).Count -eq 0) 'symlink wheel left partial bootstrap files'

    Add-Content -LiteralPath $lockPath -Value 'other-package==9.0'
    $malformedBlocked = $false
    try { Get-PipBootstrapLock -LockPath $lockPath | Out-Null } catch { $malformedBlocked = $true }
    Assert-Harness $malformedBlocked 'bootstrap lock accepted an extra package'
} finally {
    if (Test-Path -LiteralPath $root) {
        Remove-Item -LiteralPath $root -Recurse -Force
    }
}
`;

  fs.writeFileSync(harnessPath, harness, 'utf8');
  const result = spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', harnessPath], {
    encoding: 'utf8',
    windowsHide: true,
  });
  fs.rmSync(harnessRoot, { recursive: true, force: true });
  assert.equal(result.status, 0, String(result.stdout) + String(result.stderr));
});
