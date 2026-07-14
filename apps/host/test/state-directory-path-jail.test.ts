import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createHostState } from '../src/runtime/host-state.js';
import { createHostStatePathResolvers } from '../src/runtime/host-state-paths.js';
import { resolveStoreBackendConfig } from '../src/runtime/store-backend-config.js';
import type { HostConfig } from '../src/runtime/host-state-types.js';
import { ensureRunOwnerClaim } from '../src/util/run-owner.js';

type SymlinkSync = (
  target: string,
  linkPath: string,
  type?: 'file' | 'dir' | 'junction',
) => void;

const symlinkSync = (fs as unknown as { symlinkSync: SymlinkSync }).symlinkSync;
const HOST_SRC_DIR = fileURLToPath(new URL('../src', import.meta.url));
const OWNER = { tenantId: 'tenant_path_jail', userId: 'user_path_jail' };

const TEST_SANDBOX_STARTUP: NonNullable<HostConfig['sandboxStartup']> = {
  options: { backend: 'local' },
  info: {
    requestedBackend: 'local',
    selectedBackend: 'local',
    networkIsolated: false,
    fallback: false,
    fallbackReason: null,
    userMessage: 'test sandbox',
    backends: {
      docker: {
        available: false,
        usable: false,
        networkIsolated: true,
        detail: '',
        reason: 'not used',
      },
      wsl: {
        available: false,
        usable: false,
        networkIsolated: false,
        detail: '',
        reason: 'not used',
      },
      local: { available: true, usable: true, networkIsolated: false },
    },
  },
};

function tempRoot(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function linkDirectory(target: string, linkPath: string): void {
  try {
    symlinkSync(target, linkPath, 'junction');
  } catch {
    symlinkSync(target, linkPath, 'dir');
  }
}

function testHostConfig(trustedRoot: string): HostConfig {
  return {
    trustedRoot,
    staticRoot: false,
    modelConfigFile: path.join(trustedRoot, 'test-kimi-config.json'),
    enableModelApi: false,
    storeBackend: 'file',
    memoryStore: {},
    conversationStore: {},
    runEventBus: {},
    sandboxStartup: TEST_SANDBOX_STARTUP,
    sandbox: {},
    enableSandbox: false,
    approvalRegistry: {},
    persistAuth: false,
    credentialStore: {},
    enableScheduler: false,
  };
}

test('owner claim creation rejects an escaped .owners symlink or junction', () => {
  const root = tempRoot('kcw-owner-jail-root-');
  const outside = tempRoot('kcw-owner-jail-outside-');
  linkDirectory(outside, path.join(root, '.owners'));
  const claimPath = path.join(root, '.owners', 'escaped.json');

  assert.throws(
    () => ensureRunOwnerClaim({ claimPath, owner: OWNER }),
    /escaped trusted root/i,
  );
  assert.equal(fs.existsSync(path.join(outside, 'escaped.json')), false);
});

test('existing owner claims must be regular files, never claim-file symlinks', (t) => {
  const root = tempRoot('kcw-owner-file-root-');
  const outside = tempRoot('kcw-owner-file-outside-');
  const outsideClaim = path.join(outside, '.owners', 'actual.json');
  ensureRunOwnerClaim({ claimPath: outsideClaim, owner: OWNER });
  const claimRoot = path.join(root, '.owners');
  fs.mkdirSync(claimRoot, { recursive: true });
  const linkedClaim = path.join(claimRoot, 'linked.json');
  try {
    symlinkSync(outsideClaim, linkedClaim, 'file');
  } catch (error) {
    t.skip(`file symlink unavailable: ${String(error)}`);
    return;
  }

  assert.throws(
    () => ensureRunOwnerClaim({ claimPath: linkedClaim, owner: OWNER }),
    /escaped trusted root|regular file|symbolic link|reparse/i,
  );
});

test('owner claim revalidates after mkdir before publishing into a swapped parent', (t) => {
  const root = tempRoot('kcw-owner-swap-root-');
  const outside = tempRoot('kcw-owner-swap-outside-');
  const claimRoot = path.join(root, '.owners');
  const displacedClaimRoot = path.join(root, '.owners-original');
  const claimPath = path.join(claimRoot, 'swapped.json');
  fs.mkdirSync(claimRoot, { recursive: true });
  const originalMkdirSync = fs.mkdirSync;
  const realClaimRoot = fs.realpathSync.native ? fs.realpathSync.native(claimRoot) : fs.realpathSync(claimRoot);
  let swapped = false;
  fs.mkdirSync = ((...args: unknown[]) => {
    const result = Reflect.apply(originalMkdirSync, fs, args);
    // args[0] 可能是 Windows 8.3 短名或长名(视调用链上是否先过 canonicalizePath 而定)——
    // 与 claimRoot 字面串比较会漏判,统一走 realpath 再比对同一目录的两种别名。
    let sameAsClaimRoot = false;
    try {
      const candidateReal = fs.realpathSync.native
        ? fs.realpathSync.native(String(args[0]))
        : fs.realpathSync(String(args[0]));
      sameAsClaimRoot = candidateReal === realClaimRoot;
    } catch {
      sameAsClaimRoot = path.resolve(String(args[0])) === path.resolve(claimRoot);
    }
    if (!swapped && sameAsClaimRoot) {
      fs.renameSync(claimRoot, displacedClaimRoot);
      try {
        linkDirectory(outside, claimRoot);
      } catch (error) {
        fs.renameSync(displacedClaimRoot, claimRoot);
        t.skip(`symlink/junction unavailable: ${String(error)}`);
      }
      swapped = true;
    }
    return result;
  }) as typeof fs.mkdirSync;

  try {
    assert.throws(
      () => ensureRunOwnerClaim({ claimPath, owner: OWNER }),
      /escaped (trusted root|managed directory)|symbolic link|junction|reparse|could not be verified/i,
    );
  } finally {
    fs.mkdirSync = originalMkdirSync;
  }
  assert.equal(swapped, true, 'test must exercise the post-mkdir directory swap');
  assert.deepEqual(fs.readdirSync(outside), [], 'swapped outside directory must receive no temp or claim file');
});

test('default .AgentCowork runs and index roots reject existing directory escapes', () => {
  for (const escapedLeaf of ['runs', 'index']) {
    const trustedRoot = tempRoot(`kcw-state-${escapedLeaf}-root-`);
    const outside = tempRoot(`kcw-state-${escapedLeaf}-outside-`);
    const appRoot = path.join(trustedRoot, '.AgentCowork');
    fs.mkdirSync(appRoot, { recursive: true });
    if (escapedLeaf === 'index') fs.mkdirSync(path.join(appRoot, 'runs'));
    linkDirectory(outside, path.join(appRoot, escapedLeaf));

    assert.throws(
      () => createHostState(testHostConfig(trustedRoot), { hostSrcDir: HOST_SRC_DIR }),
      /escaped trusted root/i,
      `default ${escapedLeaf} root must stay inside trustedRoot`,
    );
  }
});

test('default Kimi config path rejects an escaped .AgentCowork directory', () => {
  const trustedRoot = tempRoot('kcw-state-kimi-root-');
  const outside = tempRoot('kcw-state-kimi-outside-');
  fs.writeFileSync(path.join(outside, 'config.json'), '{}\n', 'utf8');
  linkDirectory(outside, path.join(trustedRoot, '.AgentCowork'));
  const config = {
    ...testHostConfig(trustedRoot),
    runStoreRoot: path.join(trustedRoot, 'managed-runs'),
    runsIndexRoot: path.join(trustedRoot, 'managed-index'),
    sqliteDbPath: path.join(trustedRoot, 'managed-state.sqlite'),
  };
  delete config.modelConfigFile;

  assert.throws(
    () => createHostState(config, { hostSrcDir: HOST_SRC_DIR }),
    /escaped trusted root/i,
  );
});

test('default SQLite state path rejects an escaped .AgentCowork directory without opening a database', () => {
  const trustedRoot = tempRoot('kcw-state-sqlite-root-');
  const outside = tempRoot('kcw-state-sqlite-outside-');
  linkDirectory(outside, path.join(trustedRoot, '.AgentCowork'));

  assert.throws(
    () => resolveStoreBackendConfig({ storeBackend: 'file' }, trustedRoot),
    /escaped trusted root/i,
  );
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('default auth database path rejects an escaped .AgentCowork directory without opening a database', () => {
  const trustedRoot = tempRoot('kcw-state-auth-root-');
  const outside = tempRoot('kcw-state-auth-outside-');
  linkDirectory(outside, path.join(trustedRoot, '.AgentCowork'));

  const paths = createHostStatePathResolvers({}, trustedRoot, {});
  assert.throws(() => paths.authDbPath(), /escaped trusted root/i);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('default scheduler store rejects a junction outside trustedRoot', () => {
  const trustedRoot = tempRoot('kcw-state-scheduler-root-');
  const outside = tempRoot('kcw-state-scheduler-outside-');
  const appRoot = path.join(trustedRoot, '.AgentCowork');
  fs.mkdirSync(appRoot, { recursive: true });
  linkDirectory(outside, path.join(appRoot, 'schedules'));

  assert.throws(
    () => createHostState({
      ...testHostConfig(trustedRoot),
      runStoreRoot: path.join(trustedRoot, 'managed-runs'),
      runsIndexRoot: path.join(trustedRoot, 'managed-index'),
      sqliteDbPath: path.join(trustedRoot, 'managed-state.sqlite'),
      enableScheduler: true,
      startScheduler: false,
    }, { hostSrcDir: HOST_SRC_DIR }),
    /escaped trusted root/i,
  );
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('explicit external run and index roots retain their managed trust boundary', () => {
  const trustedRoot = tempRoot('kcw-state-explicit-root-');
  const externalRoot = tempRoot('kcw-state-explicit-managed-');
  const runStoreRoot = path.join(externalRoot, 'runs');
  const runsIndexRoot = path.join(externalRoot, 'index');
  const modelConfigFile = path.join(externalRoot, 'config.json');
  const sqliteDbPath = path.join(externalRoot, 'state.sqlite');
  const scheduleStoreDir = path.join(externalRoot, 'schedules');

  const state = createHostState({
    ...testHostConfig(trustedRoot),
    modelConfigFile,
    runStoreRoot,
    runsIndexRoot,
    sqliteDbPath,
    scheduleStoreDir,
    enableScheduler: true,
    startScheduler: false,
  }, { hostSrcDir: HOST_SRC_DIR });

  assert.equal(state.modelConfigFile, path.resolve(modelConfigFile));
  assert.equal(state.runStoreRoot, path.resolve(runStoreRoot));
  assert.equal(state.sqliteDbPath, path.resolve(sqliteDbPath));
  assert.equal(state.activeScheduler?.storeDir, path.resolve(scheduleStoreDir));
  assert.equal(
    (state.runsIndex as unknown as { indexRoot: string }).indexRoot,
    path.resolve(runsIndexRoot),
  );
  assert.doesNotThrow(() => ensureRunOwnerClaim({
    claimPath: path.join(runStoreRoot, '.owners', 'managed.json'),
    owner: OWNER,
  }));
});
