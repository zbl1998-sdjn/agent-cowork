import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadLayeredMemory } from '../src/memory/memory-layers.js';
import { AtRestKeyError } from '../src/security/at-rest.js';

type SymlinkSync = (target: string, linkPath: string, type?: 'file' | 'dir' | 'junction') => void;
const symlinkSync = (fs as unknown as { symlinkSync: SymlinkSync }).symlinkSync;

function tempDirectory(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function emptyHome(): string {
  return tempDirectory('kcw-layer-home-');
}

function linkDirectory(target: string, linkPath: string): void {
  try {
    symlinkSync(target, linkPath, 'junction');
  } catch {
    symlinkSync(target, linkPath, 'dir');
  }
}

test('managed user memory rejects an intermediate .AgentCowork junction', (t) => {
  const home = emptyHome();
  const target = path.join(home, 'actual-user-memory');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'MEMORY.md'), 'must-not-follow', 'utf8');
  try {
    linkDirectory(target, path.join(home, '.AgentCowork'));
  } catch (error) {
    t.skip(`junction unavailable: ${String(error)}`);
    return;
  }

  assert.throws(
    () => loadLayeredMemory({ userHome: home }),
    /symbolic link|junction|reparse|boundary/i,
  );
});

test('managed project memory rejects an intermediate .AgentCowork junction', (t) => {
  const root = tempDirectory('kcw-layer-root-');
  const target = path.join(root, 'actual-project-memory');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'MEMORY.md'), 'must-not-follow', 'utf8');
  try {
    linkDirectory(target, path.join(root, '.AgentCowork'));
  } catch (error) {
    t.skip(`junction unavailable: ${String(error)}`);
    return;
  }

  assert.throws(
    () => loadLayeredMemory({ trustedRoot: root, userHome: emptyHome() }),
    /symbolic link|junction|reparse|boundary/i,
  );
});

test('managed project memory never follows a MEMORY.md file link', (t) => {
  const root = tempDirectory('kcw-layer-file-link-');
  const appDirectory = path.join(root, '.AgentCowork');
  const target = path.join(root, 'outside.md');
  fs.mkdirSync(appDirectory);
  fs.writeFileSync(target, 'must-not-follow', 'utf8');
  try {
    symlinkSync(target, path.join(appDirectory, 'MEMORY.md'), 'file');
  } catch (error) {
    t.skip(`file link unavailable: ${String(error)}`);
    return;
  }

  assert.throws(
    () => loadLayeredMemory({ trustedRoot: root, userHome: emptyHome() }),
    /symbolic link|reparse|boundary/i,
  );
});

test('managed layer descriptor read rejects a regular file replacement after open', () => {
  const root = tempDirectory('kcw-layer-file-swap-');
  const appDirectory = path.join(root, '.AgentCowork');
  const file = path.join(appDirectory, 'MEMORY.md');
  const displaced = `${file}.original`;
  fs.mkdirSync(appDirectory);
  fs.writeFileSync(file, 'project-original', 'utf8');
  const originalOpen = fs.openSync;
  let injected = false;
  fs.openSync = ((target: unknown, ...args: unknown[]) => {
    const descriptor = Reflect.apply(originalOpen, fs, [target, ...args]) as number;
    if (!injected && path.resolve(String(target)) === path.resolve(file)) {
      injected = true;
      fs.renameSync(file, displaced);
      fs.writeFileSync(file, 'project-replacement', 'utf8');
    }
    return descriptor;
  }) as typeof fs.openSync;
  try {
    assert.throws(
      () => loadLayeredMemory({ trustedRoot: root, userHome: emptyHome() }),
      /managed file changed|changed during operation|boundary/i,
    );
  } finally {
    fs.openSync = originalOpen;
  }
  assert.equal(injected, true);
  assert.equal(fs.readFileSync(displaced, 'utf8'), 'project-original');
});

test('project and local layers retain one directory guard across both reads', () => {
  const root = tempDirectory('kcw-layer-directory-swap-');
  const appDirectory = path.join(root, '.AgentCowork');
  const displaced = `${appDirectory}.original`;
  fs.mkdirSync(appDirectory);
  fs.writeFileSync(path.join(appDirectory, 'MEMORY.md'), 'project-original', 'utf8');
  fs.writeFileSync(path.join(appDirectory, 'MEMORY.local.md'), 'local-original', 'utf8');
  const originalClose = fs.closeSync;
  let injected = false;
  fs.closeSync = ((descriptor: number) => {
    originalClose(descriptor);
    if (!injected) {
      injected = true;
      fs.renameSync(appDirectory, displaced);
      fs.mkdirSync(appDirectory);
      fs.writeFileSync(path.join(appDirectory, 'MEMORY.local.md'), 'local-replacement', 'utf8');
    }
  }) as typeof fs.closeSync;
  try {
    assert.throws(
      () => loadLayeredMemory({ trustedRoot: root, userHome: emptyHome() }),
      /changed during operation|boundary/i,
    );
  } finally {
    fs.closeSync = originalClose;
  }
  assert.equal(injected, true);
  assert.equal(fs.readFileSync(path.join(displaced, 'MEMORY.local.md'), 'utf8'), 'local-original');
});

test('managed layer reads preserve the exact AtRestKeyError', () => {
  const root = tempDirectory('kcw-layer-at-rest-');
  const appDirectory = path.join(root, '.AgentCowork');
  fs.mkdirSync(appDirectory);
  fs.writeFileSync(path.join(appDirectory, 'MEMORY.md'), 'project', 'utf8');
  const keyError = new AtRestKeyError('injected layered-memory key failure');
  const originalRead = fs.readFileSync;
  fs.readFileSync = (() => {
    throw keyError;
  }) as typeof fs.readFileSync;
  try {
    assert.throws(
      () => loadLayeredMemory({ trustedRoot: root, userHome: emptyHome() }),
      (error) => error === keyError,
    );
  } finally {
    fs.readFileSync = originalRead;
  }
});

test('managed layer permission failures are visible instead of becoming an absent layer', () => {
  const root = tempDirectory('kcw-layer-permission-');
  const appDirectory = path.join(root, '.AgentCowork');
  fs.mkdirSync(appDirectory);
  fs.writeFileSync(path.join(appDirectory, 'MEMORY.md'), 'project', 'utf8');
  const denied = Object.assign(new Error('injected permission denial'), { code: 'EACCES' });
  const originalRead = fs.readFileSync;
  fs.readFileSync = (() => {
    throw denied;
  }) as typeof fs.readFileSync;
  try {
    assert.throws(
      () => loadLayeredMemory({ trustedRoot: root, userHome: emptyHome() }),
      /permission denial|EACCES|boundary/i,
    );
  } finally {
    fs.readFileSync = originalRead;
  }
});

test('explicit enterprisePath remains an external optional read-only source', () => {
  const externalDirectory = tempDirectory('kcw-layer-enterprise-');
  const enterprisePath = path.join(externalDirectory, 'enterprise.md');
  fs.writeFileSync(enterprisePath, 'enterprise-external', 'utf8');

  const out = loadLayeredMemory({
    enterprisePath,
    trustedRoot: tempDirectory('kcw-layer-unrelated-root-'),
    userHome: emptyHome(),
  });

  assert.match(out.text, /enterprise-external/);
  assert.equal(out.layers.find((layer) => layer.layer === 'enterprise')?.present, true);
});

test('explicit enterprisePath retains its legacy optional-source error handling', () => {
  const enterprisePath = path.join(tempDirectory('kcw-layer-enterprise-error-'), 'enterprise.md');
  fs.writeFileSync(enterprisePath, 'enterprise-external', 'utf8');
  const originalRead = fs.readFileSync;
  fs.readFileSync = ((target: unknown, ...args: unknown[]) => {
    if (path.resolve(String(target)) === path.resolve(enterprisePath)) {
      throw Object.assign(new Error('external enterprise source unavailable'), { code: 'EACCES' });
    }
    return Reflect.apply(originalRead, fs, [target, ...args]) as unknown;
  }) as typeof fs.readFileSync;
  try {
    const out = loadLayeredMemory({ enterprisePath, userHome: emptyHome() });
    assert.equal(out.layers.find((layer) => layer.layer === 'enterprise')?.present, false);
  } finally {
    fs.readFileSync = originalRead;
  }
});
