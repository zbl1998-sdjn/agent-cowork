import assert from 'node:assert/strict';
import test from 'node:test';
import { getRuntimeDependencyStatus } from '../src/runtime/dependencies.js';
import { createServer } from '../src/server.js';
import { makeTestWorkspace } from './test-fixtures.js';
import {
  arrayField,
  bind,
  close,
  recordValue,
  stringField,
} from './helpers/host-http.js';
import { dependencyById, recordById } from './helpers/runtime-dependency.js';
import type { RuntimeSpawnSync } from './helpers/runtime-dependency.js';

test('GET /api/runtime/dependencies reports runtime catalog without leaking proxy credentials', async () => {
  const trustedRoot = makeTestWorkspace('kcw-runtime-deps');
  const server = createServer({
    requireAuth: false,
    enableScheduler: false,
    trustedRoot,
    runtimeDependencyEnv: {
      HTTPS_PROXY: 'http://proxy-user:proxy-password@127.0.0.1:7890',
      KCW_EMBEDDED_PYTHON: 'C:\\AgentCowork\\runtime\\python\\python.exe',
      KCW_WEBVIEW2_MODE: 'evergreen',
    },
  });
  const base = await bind(server);
  try {
    const response = await fetch(`${base}/api/runtime/dependencies`);
    assert.equal(response.status, 200);

    const raw = await response.text();
    assert.ok(!raw.includes('proxy-password'), 'runtime dependency status leaked proxy password');
    const body = recordValue(JSON.parse(raw) as unknown, 'runtime dependency response');
    assert.equal(body.ok, true);
    assert.equal(body.service, 'agent-cowork-host');
    assert.equal(body.platform, process.platform);
    const dependencies = arrayField(body, 'dependencies', 'runtime dependencies');
    assert.ok(dependencies.length >= 6);
    assert.ok(Number(recordValue(body.summary, 'runtime dependency summary').total) >= dependencies.length);

    const node = recordById(dependencies, 'node', 'dependency');
    assert.equal(node.status, 'available');
    assert.equal(node.label, 'Node.js 运行时');
    assert.match(String(node.description), /本地 Node/);
    assert.match(String(node.detail), /host 进程/);
    assert.match(stringField(node, 'version', 'node version'), /^v\d+\./);
    assert.equal(node.required, true);

    const webview2 = recordById(dependencies, 'webview2', 'dependency');
    assert.equal(webview2.installMode, 'system');
    assert.equal(webview2.label, 'Microsoft Edge WebView2');
    assert.match(String(webview2.description), /桌面外壳/);

    const dataScience = recordById(dependencies, 'data-science', 'dependency');
    assert.match(String(dataScience.label), /数据分析/);
    assert.match(String(dataScience.description), /按需安装/);
    assert.equal(dataScience.sourceKind, 'official');
    assert.equal(dataScience.sha256, null);
    assert.equal(dataScience.signaturePolicy, 'sha256-required');

    const ffmpeg = recordById(dependencies, 'ffmpeg', 'dependency');
    assert.equal(ffmpeg.section, 'B5');
    assert.equal(ffmpeg.installMode, 'on-demand');
    assert.match(String(ffmpeg.description), /音视频处理/);

    const mingit = recordById(dependencies, 'mingit', 'dependency');
    assert.equal(mingit.section, 'B6');
    assert.equal(mingit.installMode, 'on-demand');

    const python = recordById(dependencies, 'python-embedded', 'dependency');
    assert.equal(python.status, 'configured');
    assert.equal(python.detail, '内置 Python 路径已配置');

    const cjkFonts = recordById(dependencies, 'cjk-fonts', 'dependency');
    assert.equal(cjkFonts.section, 'A3');
    assert.equal(cjkFonts.required, true);

    const proxy = recordById(dependencies, 'proxy', 'dependency');
    assert.equal(proxy.status, 'configured');
    assert.equal(proxy.detail, 'http://proxy-user:[REDACTED]@127.0.0.1:7890');
  } finally {
    await close(server);
  }
});

test('runtime dependency status detects configured MinGit before probing system git', () => {
  let called = false;
  const status = getRuntimeDependencyStatus({
    env: {
      KCW_MINGIT_HOME: 'C:\\Users\\Alice\\AppData\\Roaming\\AgentCowork\\components\\mingit',
      KCW_VC_RUNTIME_INSTALLED: '1',
    },
    spawnSync: () => {
      called = true;
      return { status: 1 };
    },
  });

  const mingit = dependencyById(status, 'mingit');
  assert.equal(called, false);
  assert.equal(mingit.status, 'configured');
  assert.equal(mingit.source, 'KCW_MINGIT_HOME');
  assert.equal(mingit.detail, 'Git 运行时路径已配置');
});

test('runtime dependency status reports system git availability', () => {
  const spawnSync: RuntimeSpawnSync = (command: string, args: readonly string[] = [], options: Record<string, unknown> = {}) => {
    assert.equal(command, 'git');
    assert.deepEqual(args, ['--version']);
    assert.equal(options.windowsHide, true);
    return { status: 0, stdout: 'git version 2.46.0.windows.1\n', stderr: '' };
  };
  const status = getRuntimeDependencyStatus({ env: {}, spawnSync });

  const mingit = dependencyById(status, 'mingit');
  assert.equal(mingit.status, 'available');
  assert.equal(mingit.version, '2.46.0.windows.1');
  assert.match(String(mingit.detail), /系统 Git 可用/);
});

test('runtime dependency status marks MinGit missing when git is unavailable', () => {
  const status = getRuntimeDependencyStatus({
    env: {},
    spawnSync: () => ({ status: 1, stdout: '', stderr: 'git not found' }),
  });

  const mingit = dependencyById(status, 'mingit');
  assert.equal(mingit.status, 'missing');
  assert.match(String(mingit.detail), /按需安装 MinGit/);
});

test('runtime dependency status detects configured VC runtime before registry probing', () => {
  let called = false;
  const status = getRuntimeDependencyStatus({
    env: { KCW_VC_RUNTIME_INSTALLED: '1', KCW_MINGIT_HOME: 'C:\\AgentCowork\\components\\mingit' },
    platform: 'win32',
    spawnSync: () => {
      called = true;
      return { status: 1 };
    },
  });

  const vcRuntime = dependencyById(status, 'vc-runtime');
  assert.equal(called, false);
  assert.equal(vcRuntime.status, 'configured');
  assert.equal(vcRuntime.source, 'KCW_VC_RUNTIME_INSTALLED');
});

test('runtime dependency status reports VC runtime registry availability on Windows', () => {
  const spawnSync: RuntimeSpawnSync = (command: string, args: readonly string[] = [], options: Record<string, unknown> = {}) => {
    if (command === 'git') return { status: 1, stdout: '', stderr: '' };
    assert.equal(command, 'reg');
    assert.equal(args[0], 'query');
    assert.match(String(args[1]), /\\Runtimes\\x64$/);
    assert.equal(args.at(-1), 'Installed');
    assert.equal(options.windowsHide, true);
    return {
      status: 0,
      stdout: 'Installed    REG_DWORD    0x1\nVersion    REG_SZ    v14.40.33810.0\n',
      stderr: '',
    };
  };
  const status = getRuntimeDependencyStatus({ env: {}, platform: 'win32', spawnSync });

  const vcRuntime = dependencyById(status, 'vc-runtime');
  assert.equal(vcRuntime.status, 'available');
  assert.equal(vcRuntime.version, 'v14.40.33810.0');
  assert.match(String(vcRuntime.detail), /VC\+\+ 运行库可用/);
});

test('runtime dependency status accepts x86 VC runtime when x64 is absent', () => {
  const queried: string[] = [];
  const spawnSync: RuntimeSpawnSync = (_command: string, args: readonly string[] = []) => {
    const registryKey = stringField({ value: args[1] }, 'value', 'registry key');
    queried.push(registryKey);
    if (/\\Runtimes\\x86$/.test(registryKey)) {
      return { status: 0, stdout: 'Installed    REG_DWORD    0x1\n', stderr: '' };
    }
    return { status: 1, stdout: '', stderr: 'not found' };
  };
  const status = getRuntimeDependencyStatus({
    env: { KCW_MINGIT_HOME: 'C:\\AgentCowork\\components\\mingit' },
    platform: 'win32',
    spawnSync,
  });

  const vcRuntime = dependencyById(status, 'vc-runtime');
  assert.deepEqual(queried, [
    'HKLM\\SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x64',
    'HKLM\\SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x86',
  ]);
  assert.equal(vcRuntime.status, 'available');
  assert.match(String(vcRuntime.detail), /x86/);
});

test('runtime dependency status marks VC runtime missing on Windows when registry flag is absent', () => {
  const spawnSync: RuntimeSpawnSync = (command: string) => (
    command === 'git' ? { status: 1, stdout: '', stderr: '' } : { status: 1, stdout: '', stderr: 'not found' }
  );
  const status = getRuntimeDependencyStatus({ env: {}, platform: 'win32', spawnSync });

  const vcRuntime = dependencyById(status, 'vc-runtime');
  assert.equal(vcRuntime.status, 'missing');
  assert.match(String(vcRuntime.detail), /安装器需要补齐/);
});

test('runtime dependency status skips VC runtime probing off Windows', () => {
  let called = false;
  const status = getRuntimeDependencyStatus({
    env: { KCW_MINGIT_HOME: 'C:\\AgentCowork\\components\\mingit' },
    platform: 'linux',
    spawnSync: () => {
      called = true;
      return { status: 0 };
    },
  });

  const vcRuntime = dependencyById(status, 'vc-runtime');
  assert.equal(called, false);
  assert.equal(vcRuntime.status, 'not_applicable');
});
