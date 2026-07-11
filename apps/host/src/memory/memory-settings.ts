// 个人记忆开关持久化(host · L1 领域层 · memory)
// ---------------------------------------------------------------------------
// 职责:按精确 tenant+user 读取/写入 enabled/paused/incognito/defaultScope；物理路径
//       仅含稳定 owner hash。旧全局文件只允许显式 tenant_local/user_local 读取。
import path from 'node:path';
import { AtRestKeyError } from '../security/at-rest.js';
import {
  beginMemoryFilesystemOperation,
  MemoryFilesystemBoundaryError,
  readManagedMemoryFile,
  writeManagedMemoryFile,
  type MemoryFilesystemOperation,
} from './memory-filesystem-boundary.js';
import {
  isLegacyLocalMemoryOwner,
  memoryOwnerDir,
  requireMemoryOwner,
  type MemoryOwnerContext,
} from './memory-owner.js';
import { memoryDir } from './memory-utils.js';

export type MemorySettings = {
  enabled: boolean;
  paused: boolean;
  incognito: boolean;
  defaultScope: 'project' | 'user' | 'session';
  updatedAt: string;
};

const SETTINGS_FILE = 'memory-settings.json';

function nowIso(now: Date = new Date()): string {
  return now.toISOString();
}

function settingsPath(root: string, context: MemoryOwnerContext): string {
  requireMemoryOwner(context);
  return path.join(memoryOwnerDir(root, context), SETTINGS_FILE);
}

function legacySettingsPath(root: string): string {
  return path.join(memoryDir(root), SETTINGS_FILE);
}

function defaultSettings(): MemorySettings {
  return {
    enabled: true,
    paused: false,
    incognito: false,
    defaultScope: 'project',
    updatedAt: nowIso(),
  };
}

function normalizeScope(
  value: unknown,
  fallback: MemorySettings['defaultScope'] = 'project',
): MemorySettings['defaultScope'] {
  const text = String(value || '').trim().toLowerCase();
  return text === 'user' || text === 'session' || text === 'project' ? text : fallback;
}

export function readMemorySettings(
  trustedRoot: unknown,
  context: MemoryOwnerContext = {},
): MemorySettings {
  requireMemoryOwner(context);
  return readMemorySettingsWithinOperation(
    beginMemoryFilesystemOperation(trustedRoot),
    context,
  );
}

function readMemorySettingsWithinOperation(
  operation: MemoryFilesystemOperation,
  context: MemoryOwnerContext,
): MemorySettings {
  let body: string;
  try {
    const scoped = readManagedMemoryFile(
      operation,
      settingsPath(operation.root, context),
    );
    if (scoped.exists) body = scoped.body;
    else if (isLegacyLocalMemoryOwner(context)) {
      const legacy = readManagedMemoryFile(
        operation,
        legacySettingsPath(operation.root),
      );
      if (!legacy.exists) return defaultSettings();
      body = legacy.body;
    } else return defaultSettings();
  } catch (error) {
    if (error instanceof AtRestKeyError || error instanceof MemoryFilesystemBoundaryError) throw error;
    return { ...defaultSettings(), paused: true, updatedAt: nowIso() };
  }
  try {
    const parsed = JSON.parse(body) as Partial<MemorySettings>;
    const base = defaultSettings();
    return {
      enabled: parsed.enabled !== false,
      paused: parsed.paused === true,
      incognito: parsed.incognito === true,
      defaultScope: normalizeScope(parsed.defaultScope, base.defaultScope),
      updatedAt: typeof parsed.updatedAt === 'string' && parsed.updatedAt ? parsed.updatedAt : base.updatedAt,
    };
  } catch (error) {
    void error;
    return { ...defaultSettings(), paused: true, updatedAt: nowIso() };
  }
}

export function writeMemorySettings(
  trustedRoot: unknown,
  patch: Partial<MemorySettings>,
  context: MemoryOwnerContext = {},
  now = new Date(),
): MemorySettings {
  requireMemoryOwner(context);
  const operation = beginMemoryFilesystemOperation(trustedRoot);
  const current = readMemorySettingsWithinOperation(operation, context);
  const next: MemorySettings = {
    enabled: patch.enabled != null ? patch.enabled !== false : current.enabled,
    paused: patch.paused != null ? patch.paused === true : current.paused,
    incognito: patch.incognito != null ? patch.incognito === true : current.incognito,
    defaultScope: normalizeScope(patch.defaultScope, current.defaultScope),
    updatedAt: nowIso(now),
  };
  writeManagedMemoryFile(
    operation,
    settingsPath(operation.root, context),
    JSON.stringify(next, null, 2),
  );
  return next;
}

export function isMemoryActive(
  settings: Pick<MemorySettings, 'enabled' | 'paused' | 'incognito'>,
): boolean {
  return settings.enabled && !settings.paused && !settings.incognito;
}

export function isMemoryActiveForRoot(
  trustedRoot: unknown,
  context: MemoryOwnerContext = {},
): boolean {
  return isMemoryActive(readMemorySettings(trustedRoot, context));
}
