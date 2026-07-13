import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const scriptPath = path.join(workspaceRoot, 'scripts', 'prepare-embedded-python.ps1');
const script = fs.readFileSync(scriptPath, 'utf8');
const input = fs.readFileSync(
  path.join(workspaceRoot, 'apps', 'windows-client', 'resources', 'python-packages.in'),
  'utf8',
);
const lock = fs.readFileSync(
  path.join(workspaceRoot, 'apps', 'windows-client', 'resources', 'python-packages.lock'),
  'utf8',
);

test('embedded Python bootstrap verifies the locked pip wheel before execution', () => {
  assert.match(script, /\$PipBootstrapLockPath\s*=\s*""/);
  assert.match(script, /Get-PipBootstrapLock -LockPath \$PipBootstrapLockPath/);
  assert.match(script, /Get-VerifiedPipBootstrapWheel/);
  assert.match(script, /Test-Sha256 -FilePath \$WheelPath -Expected \$PipBootstrap\.Sha256/);
  assert.match(script, /\[ValidateRange\(1,\s*300\)\]\[int\]\$DownloadTimeoutSec\s*=\s*120/);
  assert.match(script, /Invoke-WebRequest[^\r\n]+-TimeoutSec \$TimeoutSec/);
  assert.match(script, /['"]--no-index['"]/);
  assert.match(script, /['"]--no-deps['"]/);
  assert.doesNotMatch(script, /bootstrap\.pypa\.io|\$GetPip|getPipPath/i);
});

test('embedded Python package install is hash-locked, binary-only, and fail-closed', () => {
  assert.match(script, /--require-hashes/);
  assert.match(script, /--only-binary=:all:/);
  assert.doesNotMatch(script, /proceeding with stdlib only/i);
  assert.doesNotMatch(script, /package install failed; proceeding/i);
});

test('embedded Python lock retains the audited vulnerability-fixed direct pins', () => {
  const inputLines = new Set(input.split(/\r?\n/));
  for (const pin of ['lxml==6.1.0', 'pillow==12.3.0', 'requests==2.33.0']) {
    assert.ok(inputLines.has(pin), pin + ' must remain a direct pin');
    assert.ok(lock.toLowerCase().includes(pin + ' \\'), pin + ' must appear in the resolved lock');
  }
  for (const vulnerablePin of ['lxml==5.3.0', 'pillow==11.0.0', 'requests==2.32.3']) {
    assert.ok(!inputLines.has(vulnerablePin), vulnerablePin + ' must not return');
  }
});

test('embedded Python publication is staged beside the target and rolls back before reporting failure', () => {
  assert.match(script, /function\s+Publish-StagedDirectory/);
  assert.match(script, /\.staging-/);
  assert.match(script, /\.previous-/);
  assert.match(script, /\[System\.IO\.Directory\]::Move\(\$StagingDir,\s*\$TargetDir\)/);
  assert.match(script, /\[System\.IO\.Directory\]::Move\(\$BackupDir,\s*\$TargetDir\)/);
  assert.match(script, /finally\s*\{[\s\S]*Remove-SafeTransactionDirectory/);
  assert.doesNotMatch(script, /Clear-TargetDirectory/);
});

test('embedded Python paths reject reparse points and every Python child process has a hard timeout', () => {
  assert.match(script, /\[System\.IO\.FileAttributes\]::ReparsePoint/);
  assert.match(script, /function\s+Assert-SafePath/);
  assert.match(script, /function\s+Invoke-BoundedProcess/);
  assert.match(script, /\[ValidateRange\(1,\s*1800\)\]\[int\]\$ProcessTimeoutSec\s*=\s*300/);
  assert.match(script, /\.WaitForExit\(\$TimeoutSec\s*\*\s*1000\)/);
  assert.match(script, /\.Kill\(\$true\)/);
  assert.match(
    script,
    /Assert-SafePath -Path \$buildRoot -AllowedRoot \$repoRoot[\s\S]{0,300}New-Item -ItemType Directory -Path \$buildRoot/,
  );
  assert.doesNotMatch(script, /&\s*\$PythonExe/);
});

test('shared embedded Python state uses a bounded cross-process lock that is always released', () => {
  assert.match(script, /\[ValidateRange\(1,\s*300\)\]\[int\]\$LockTimeoutSec\s*=\s*60/);
  assert.match(script, /function\s+Enter-EmbeddedPythonLock/);
  assert.match(script, /\[System\.IO\.FileShare\]::None/);
  assert.match(script, /Timed out acquiring embedded Python operation lock/);
  assert.match(script, /finally\s*\{[\s\S]*Exit-EmbeddedPythonLock -LockHandle \$operationLock/);

  const harnessRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-python-lock-test-'));
  const harnessPath = path.join(harnessRoot, 'lock-harness.ps1');
  const escapedScriptPath = scriptPath.replaceAll("'", "''");
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

$root = Join-Path ([System.IO.Path]::GetTempPath()) ('kcw-python-lock-' + [guid]::NewGuid().ToString('N'))
$first = $null
try {
    New-Item -ItemType Directory -Path $root -Force | Out-Null
    $lockPath = Join-Path $root 'embedded-python.lock'
    $first = Enter-EmbeddedPythonLock -LockPath $lockPath -AllowedRoot $root -TimeoutSec 1

    $clock = [System.Diagnostics.Stopwatch]::StartNew()
    $timedOut = $false
    try {
        Enter-EmbeddedPythonLock -LockPath $lockPath -AllowedRoot $root -TimeoutSec 1 | Out-Null
    } catch {
        $timedOut = $_.Exception.Message -match 'Timed out acquiring embedded Python operation lock after 1 seconds'
    }
    $clock.Stop()
    Assert-Harness $timedOut 'a concurrent lock holder did not cause an explicit timeout'
    Assert-Harness ($clock.Elapsed.TotalSeconds -lt 4) 'lock acquisition exceeded its bounded timeout grace'

    Exit-EmbeddedPythonLock -LockHandle $first
    $first = $null
    $afterRelease = Enter-EmbeddedPythonLock -LockPath $lockPath -AllowedRoot $root -TimeoutSec 1
    Exit-EmbeddedPythonLock -LockHandle $afterRelease

    $afterFailure = $null
    try {
        $afterFailure = Enter-EmbeddedPythonLock -LockPath $lockPath -AllowedRoot $root -TimeoutSec 1
        throw 'simulated preparation failure'
    } catch {
        Assert-Harness ($_.Exception.Message -match 'simulated preparation failure') 'simulated failure was not surfaced'
    } finally {
        if ($null -ne $afterFailure) {
            Exit-EmbeddedPythonLock -LockHandle $afterFailure
        }
    }
    $afterFinally = Enter-EmbeddedPythonLock -LockPath $lockPath -AllowedRoot $root -TimeoutSec 1
    Exit-EmbeddedPythonLock -LockHandle $afterFinally
} finally {
    if ($null -ne $first) {
        Exit-EmbeddedPythonLock -LockHandle $first
    }
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
  const output = String(result.stdout ?? '') + String(result.stderr ?? '');
  assert.equal(result.status, 0, output);
});

test('transaction helpers preserve the prior runtime, publish idempotently, block junctions, and time out', () => {
  const harnessRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-python-transaction-test-'));
  const harnessPath = path.join(harnessRoot, 'transaction-harness.ps1');
  const escapedScriptPath = scriptPath.replaceAll("'", "''");
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

$root = Join-Path ([System.IO.Path]::GetTempPath()) ('kcw-python-transaction-' + [guid]::NewGuid().ToString('N'))
$junction = $null
try {
$allowedRoot = Join-Path $root 'resources'
$outside = Join-Path $root 'outside'
New-Item -ItemType Directory -Path $allowedRoot, $outside -Force | Out-Null
$target = Join-Path $allowedRoot 'python-embedded'
$stage1 = Join-Path $allowedRoot '.python-embedded.staging-one'
New-Item -ItemType Directory -Path $target, $stage1 -Force | Out-Null
Set-Content -LiteralPath (Join-Path $target 'marker.txt') -Value 'old' -NoNewline
Set-Content -LiteralPath (Join-Path $stage1 'marker.txt') -Value 'new-v1' -NoNewline

Publish-StagedDirectory -StagingDir $stage1 -TargetDir $target -AllowedRoot $allowedRoot -PublishedValidator {
    param($publishedRoot)
    if ((Get-Content -Raw -LiteralPath (Join-Path $publishedRoot 'marker.txt')) -ne 'new-v1') {
        throw 'published content validation failed'
    }
}
Assert-Harness ((Get-Content -Raw -LiteralPath (Join-Path $target 'marker.txt')) -eq 'new-v1') 'first publish did not install the staged runtime'
Assert-Harness (-not (Test-Path -LiteralPath $stage1)) 'successful publish must consume the staging directory'

$stage2 = Join-Path $allowedRoot '.python-embedded.staging-two'
New-Item -ItemType Directory -Path $stage2 -Force | Out-Null
Set-Content -LiteralPath (Join-Path $stage2 'marker.txt') -Value 'new-v2' -NoNewline
$failed = $false
try {
    Publish-StagedDirectory -StagingDir $stage2 -TargetDir $target -AllowedRoot $allowedRoot -PublishedValidator {
        throw 'simulated post-publish validation failure'
    }
} catch {
    $failed = $_.Exception.Message -match 'simulated post-publish validation failure'
}
Assert-Harness $failed 'simulated publication failure was not surfaced'
Assert-Harness ((Get-Content -Raw -LiteralPath (Join-Path $target 'marker.txt')) -eq 'new-v1') 'publication failure did not restore the prior runtime'
Assert-Harness ((Get-Content -Raw -LiteralPath (Join-Path $stage2 'marker.txt')) -eq 'new-v2') 'failed staged runtime was not moved back for caller cleanup'
Remove-SafeTransactionDirectory -Path $stage2 -AllowedRoot $allowedRoot

$stage3 = Join-Path $allowedRoot '.python-embedded.staging-three'
New-Item -ItemType Directory -Path $stage3 -Force | Out-Null
Set-Content -LiteralPath (Join-Path $stage3 'marker.txt') -Value 'new-v3' -NoNewline
Publish-StagedDirectory -StagingDir $stage3 -TargetDir $target -AllowedRoot $allowedRoot -PublishedValidator { param($publishedRoot) }
Assert-Harness ((Get-Content -Raw -LiteralPath (Join-Path $target 'marker.txt')) -eq 'new-v3') 'repeat publication was not idempotent'
Assert-Harness (@(Get-ChildItem -LiteralPath $allowedRoot -Directory -Filter '.python-embedded.previous-*').Count -eq 0) 'successful publication left backup directories behind'

$junction = Join-Path $allowedRoot 'junction-parent'
New-Item -ItemType Junction -Path $junction -Target $outside | Out-Null
$blocked = $false
try {
    Assert-SafePath -Path (Join-Path $junction 'python-embedded') -AllowedRoot $allowedRoot -Label 'junction test'
} catch {
    $blocked = $_.Exception.Message -match 'reparse point'
}
Assert-Harness $blocked 'junction parent was not rejected'

$timeoutClock = [System.Diagnostics.Stopwatch]::StartNew()
$timedOut = $false
try {
    Invoke-BoundedProcess -FilePath (Get-Process -Id $PID).Path -Arguments @(
        '-NoProfile',
        '-Command',
        'Start-Sleep -Seconds 10'
    ) -TimeoutSec 1 -Label 'simulated hung child' | Out-Null
} catch {
    $timedOut = $_.Exception.Message -match 'timed out after 1 seconds'
}
$timeoutClock.Stop()
Assert-Harness $timedOut 'hung child process did not surface a timeout'
Assert-Harness ($timeoutClock.Elapsed.TotalSeconds -lt 5) 'hung child process was not terminated within the bounded grace period'
} finally {
    if ($null -ne $junction -and (Test-Path -LiteralPath $junction)) {
        Remove-Item -LiteralPath $junction -Force
    }
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
  const output = String(result.stdout ?? '') + String(result.stderr ?? '');
  assert.equal(result.status, 0, output);
});

test('embedded Python staging reuses only an input-identical runtime that passes an offline health check', () => {
  assert.match(script, /function\s+Test-ReusableEmbeddedPython/);
  assert.match(script, /function\s+Get-LockedPackageSet/);
  assert.match(script, /function\s+Get-InstalledPackageSet/);
  assert.match(script, /importlib\.metadata/);
  assert.match(script, /"list",\s*"--format=json"/);
  assert.match(script, /function\s+Assert-ExactPackageSet/);
  assert.match(script, /if\s*\(-not \$Force -and \(Test-ReusableEmbeddedPython[\s\S]+?\)\)\s*\{[\s\S]+?return/);
  assert.match(script, /"-m",\s*"pip",\s*"check"/);
  const harnessRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-python-reuse-test-'));
  const harnessPath = path.join(harnessRoot, 'reuse-harness.ps1');
  const escapedScriptPath = scriptPath.replaceAll("'", "''");
  const escapedRequirementsLockPath = path
    .join(workspaceRoot, 'apps', 'windows-client', 'resources', 'python-packages.lock')
    .replaceAll("'", "''");
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

$realLockedPackages = @(Get-LockedPackageSet -RequirementsPath '${escapedRequirementsLockPath}')
Assert-Harness ($realLockedPackages.Count -gt 9) 'the real resolved lock was not parsed into exact package pins'

$root = Join-Path ([System.IO.Path]::GetTempPath()) ('kcw-python-reuse-' + [guid]::NewGuid().ToString('N'))
try {
    $pollutedSite = Join-Path $root 'external-site'
    $pollutedMetadata = Join-Path $pollutedSite 'external_pollution-9.0.dist-info\METADATA'
    New-Item -ItemType Directory -Path (Split-Path -Parent $pollutedMetadata) -Force | Out-Null
    Set-Content -LiteralPath $pollutedMetadata -Value @'
Metadata-Version: 2.1
Name: external-pollution
Version: 9.0
'@
    $previousPythonPath = [Environment]::GetEnvironmentVariable('PYTHONPATH', 'Process')
    try {
        [Environment]::SetEnvironmentVariable('PYTHONPATH', $pollutedSite, 'Process')
        $hostPython = (Get-Command python -ErrorAction Stop).Source
        $pollutionProbe = @(
            'import importlib.metadata as metadata'
            'names = [distribution.metadata.get("Name") for distribution in metadata.distributions()]'
            'print("external-pollution" in names)'
        ) -join [Environment]::NewLine
        $pollutionResult = Invoke-BoundedProcess -FilePath $hostPython -Arguments @(
            '-I'
            '-c'
            $pollutionProbe
        ) -TimeoutSec 30 -Label 'Checking isolated inventory against PYTHONPATH pollution'
        Assert-Harness ($pollutionResult.ExitCode -eq 0) 'isolated inventory pollution probe failed'
        Assert-Harness ($pollutionResult.Stdout.Trim() -eq 'False') 'PYTHONPATH package leaked into isolated inventory'
    } finally {
        [Environment]::SetEnvironmentVariable('PYTHONPATH', $previousPythonPath, 'Process')
    }

    $target = Join-Path $root 'python-embedded'
    $requirementsPath = Join-Path $root 'python-packages.lock'
    $bootstrapLockPath = Join-Path $root 'python-bootstrap.lock'
    $pipBootstrap = [pscustomobject]@{
        LockPath = $bootstrapLockPath
        LockSha256 = 'bootstrap-lock-sha'
        Version = '26.1.2'
        Requirement = 'pip==26.1.2'
        FileName = 'pip-26.1.2-py3-none-any.whl'
        SourceUrl = 'https://files.pythonhosted.org/packages/test/pip-26.1.2-py3-none-any.whl'
        Sha256 = 'wheel-sha'
    }
    New-Item -ItemType Directory -Path $target -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $target 'python.exe') -Value 'fake' -NoNewline
    Set-Content -LiteralPath $requirementsPath -Value @'
alpha-package==1.0 \
    --hash=sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
'@
    $manifestPath = Join-Path $target 'PYTHON_EMBEDDED_MANIFEST.json'
    $manifest = [ordered]@{
        id = 'python-embedded'
        version = '3.12.10'
        arch = 'amd64'
        sourceUrl = 'https://example.test/python.zip'
        sha256 = 'archive-sha'
        pipBootstrap = [ordered]@{
            lockPath = $bootstrapLockPath
            lockSha256 = 'bootstrap-lock-sha'
            version = '26.1.2'
            requirement = 'pip==26.1.2'
            installer = 'verified-wheel-extract-and-pip'
            wheel = [ordered]@{
                fileName = 'pip-26.1.2-py3-none-any.whl'
                sourceUrl = 'https://files.pythonhosted.org/packages/test/pip-26.1.2-py3-none-any.whl'
                sha256 = 'wheel-sha'
            }
        }
        requirements = [ordered]@{ path = $requirementsPath; sha256 = 'requirements-sha' }
        targetDir = $target
        pythonExe = (Join-Path $target 'python.exe')
        packages = @(
            [ordered]@{ name = 'alpha-package'; version = '1.0' },
            [ordered]@{ name = 'pip'; version = '26.1.2' }
        )
    }
    $manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $manifestPath -Encoding utf8

    function Test-EmbeddedPython { return '{"version":"3.12.10"}' }
    $script:ImportlibInventoryJson = '[{"name":"alpha_package","version":"1.0"},{"name":"pip","version":"26.1.2"}]'
    $script:PipInventoryJson = '[{"name":"alpha-package","version":"1.0"},{"name":"pip","version":"26.1.2"}]'
    $script:PipCheckExitCode = 0
    function Invoke-BoundedProcess {
        param($FilePath, $Arguments, $TimeoutSec, $Label)
        if ($Label -eq 'Reading embedded Python importlib.metadata inventory') {
            Assert-Harness ($Arguments[0] -eq '-I') 'importlib inventory did not use isolated mode'
            Assert-Harness (([string]$Arguments[2]).Contains([char]10)) 'the importlib.metadata probe was not separated by real newlines'
            return [pscustomobject]@{ ExitCode = 0; Stdout = $script:ImportlibInventoryJson; Stderr = ''; Output = $script:ImportlibInventoryJson }
        }
        if ($Label -eq 'Reading embedded Python pip inventory') {
            Assert-Harness ($Arguments[0] -eq '-I') 'pip inventory did not use isolated mode'
            return [pscustomobject]@{ ExitCode = 0; Stdout = $script:PipInventoryJson; Stderr = ''; Output = $script:PipInventoryJson }
        }
        if ($Label -eq 'Checking embedded Python dependencies') {
            Assert-Harness ($Arguments[0] -eq '-I') 'pip check did not use isolated mode'
            return [pscustomobject]@{ ExitCode = $script:PipCheckExitCode; Stdout = ''; Stderr = ''; Output = '' }
        }
        if ($Label -eq 'Installing embedded Python requirements') {
            Assert-Harness ($Arguments[0] -eq '-I') 'pip install did not use isolated mode'
            return [pscustomobject]@{ ExitCode = 0; Stdout = ''; Stderr = ''; Output = '' }
        }
        throw "unexpected bounded process label: $Label"
    }

    $installedFromLock = @(Install-RequirementsLock -PythonExe (Join-Path $target 'python.exe') -RequirementsPath $requirementsPath -ProcessTimeoutSec 5 -PipVersion $pipBootstrap.Version)
    Assert-Harness ($installedFromLock.Count -eq 2) 'isolated lock installation did not return the verified inventory'

    $parameters = @{
        TargetDir = $target
        Version = '3.12.10'
        Arch = 'amd64'
        Url = 'https://example.test/python.zip'
        ArchiveSha = 'archive-sha'
        PipBootstrap = $pipBootstrap
        RequirementsPath = $requirementsPath
        RequirementsSha = 'requirements-sha'
        ProcessTimeoutSec = 5
    }
    Assert-Harness (Test-ReusableEmbeddedPython @parameters) 'matching healthy runtime was not reused'

    $manifest.packages = @(
        [ordered]@{ name = 'alpha-package'; version = '2.0' },
        [ordered]@{ name = 'pip'; version = '26.1.2' }
    )
    $manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $manifestPath -Encoding utf8
    $script:ImportlibInventoryJson = '[{"name":"alpha-package","version":"2.0"},{"name":"pip","version":"26.1.2"}]'
    $script:PipInventoryJson = $script:ImportlibInventoryJson
    Assert-Harness (-not (Test-ReusableEmbeddedPython @parameters)) 'a lock-pinned package replaced in both runtime and manifest was reused'

    $manifest.packages = @(
        [ordered]@{ name = 'alpha-package'; version = '1.0' },
        [ordered]@{ name = 'pip'; version = '26.1.2' },
        [ordered]@{ name = 'surprise-package'; version = '9.0' }
    )
    $manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $manifestPath -Encoding utf8
    $script:ImportlibInventoryJson = '[{"name":"alpha-package","version":"1.0"},{"name":"pip","version":"26.1.2"},{"name":"surprise-package","version":"9.0"}]'
    $script:PipInventoryJson = $script:ImportlibInventoryJson
    Assert-Harness (-not (Test-ReusableEmbeddedPython @parameters)) 'an undeclared lock-external package present in both runtime and manifest was reused'

    $manifest.packages = @(
        [ordered]@{ name = 'alpha-package'; version = '1.0' },
        [ordered]@{ name = 'pip'; version = '26.1.2' }
    )
    $manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $manifestPath -Encoding utf8
    $script:ImportlibInventoryJson = '[{"name":"alpha-package","version":"1.0"},{"name":"pip","version":"26.1.2"}]'
    $script:PipInventoryJson = '[{"name":"alpha-package","version":"1.0"},{"name":"pip","version":"26.1.3"}]'
    Assert-Harness (-not (Test-ReusableEmbeddedPython @parameters)) 'disagreement between importlib.metadata and pip inventory was reused'

    $manifest.packages = @(
        [ordered]@{ name = 'alpha-package'; version = '1.0' },
        [ordered]@{ name = 'pip'; version = '26.1.3' }
    )
    $manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $manifestPath -Encoding utf8
    $script:ImportlibInventoryJson = '[{"name":"alpha-package","version":"1.0"},{"name":"pip","version":"26.1.3"}]'
    $script:PipInventoryJson = $script:ImportlibInventoryJson
    Assert-Harness (-not (Test-ReusableEmbeddedPython @parameters)) 'a runtime and manifest with an unpinned pip version was reused'

    $manifest.packages = @(
        [ordered]@{ name = 'alpha-package'; version = '1.0' },
        [ordered]@{ name = 'pip'; version = '26.1.2' }
    )
    $script:ImportlibInventoryJson = '[{"name":"alpha-package","version":"1.0"},{"name":"pip","version":"26.1.2"}]'
    $script:PipInventoryJson = $script:ImportlibInventoryJson
    $manifest.pipBootstrap.lockSha256 = 'stale-bootstrap-lock'
    $manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $manifestPath -Encoding utf8
    Assert-Harness (-not (Test-ReusableEmbeddedPython @parameters)) 'stale pip bootstrap lock was reused'

    $manifest.pipBootstrap.lockSha256 = 'bootstrap-lock-sha'
    $manifest.requirements.sha256 = 'stale-lock'
    $manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $manifestPath -Encoding utf8
    Assert-Harness (-not (Test-ReusableEmbeddedPython @parameters)) 'stale requirements lock was reused'

    $manifest.requirements.sha256 = 'requirements-sha'
    $manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $manifestPath -Encoding utf8
    $script:PipCheckExitCode = 1
    Assert-Harness (-not (Test-ReusableEmbeddedPython @parameters)) 'runtime with a failing pip check was reused'
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
  const output = String(result.stdout ?? '') + String(result.stderr ?? '');
  assert.equal(result.status, 0, output);
});

test('the generated Python lock covers every direct input and hashes every resolved package', () => {
  const directPins = [...input.matchAll(/^([a-z0-9][a-z0-9-]*)==([^\s#]+)$/gim)]
    .map((match) => String(match[1]).toLowerCase() + '==' + String(match[2]));
  assert.equal(directPins.length, 9);
  const normalizedLock = lock.toLowerCase();
  for (const pin of directPins) {
    assert.ok(normalizedLock.includes(pin + ' \\'), pin + ' must appear in the resolved lock');
  }

  const requirementStarts = [...lock.matchAll(/^([a-z0-9][a-z0-9-]*)==([^\s\\]+) \\\r?$/gim)];
  assert.ok(requirementStarts.length > directPins.length, 'lock must include transitive dependencies');
  for (let index = 0; index < requirementStarts.length; index += 1) {
    const current = requirementStarts[index];
    assert.ok(current);
    const start = current.index;
    const end = requirementStarts[index + 1]?.index ?? lock.length;
    assert.match(lock.slice(start, end), /--hash=sha256:[a-f0-9]{64}/i, String(current[1]) + ' must be hash locked');
  }
});

test('the Python lock generation is time-fenced and its header matches the declared command', () => {
  const cutoff = '2026-07-10T08:00:00Z';
  const declaredLine = input.split(/\r?\n/).find((line) => line.startsWith('# uv pip compile '));
  const generatedLine = lock.split(/\r?\n/).find((line) => line.startsWith('#    uv pip compile '));
  assert.ok(declaredLine, 'python-packages.in must declare the lock generation command');
  assert.ok(generatedLine, 'python-packages.lock must record the generation command');

  const declaredCommand = declaredLine.slice('# '.length);
  const generatedCommand = generatedLine.slice('#    '.length);
  assert.equal(generatedCommand, declaredCommand);
  assert.match(declaredCommand, new RegExp(`(?:^|\\s)--exclude-newer ${cutoff.replaceAll('.', '\\.')}(?:\\s|$)`));
  assert.match(lock, /^tzdata==2026\.2 \\$/m);
  assert.doesNotMatch(lock, /^tzdata==2026\.3 \\$/m);
});
