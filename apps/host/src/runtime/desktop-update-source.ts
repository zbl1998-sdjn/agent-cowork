// 桌面更新源(host · L2 运行时 · runtime)
// ---------------------------------------------------------------------------
// 职责:解析/校验桌面端自动更新的版本与更新清单来源(版本号比较、读取本地更新产物),为 Tauri updater 提供数据。
// 依赖:node:fs/path。导出:桌面更新源解析函数。
import fs from 'node:fs';
import path from 'node:path';
import { omitUndefined } from '../util/object.js';
import { readCompatEnv } from '../util/env-compat.js';

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/;

type DesktopUpdatePlatformEntry = { url?: unknown; signature?: unknown };
type DesktopUpdateManifest = DesktopUpdatePlatformEntry & {
  version?: unknown;
  pub_date?: unknown;
  date?: unknown;
  notes?: unknown;
  body?: unknown;
  platforms?: unknown;
};
export type DesktopUpdateManifestOptions = {
  env?: Record<string, string | undefined>;
  target?: string;
  arch?: string;
  currentVersion?: string;
};
export type DesktopUpdateManifestResult = {
  version: string;
  pub_date?: string;
  url: string;
  signature: string;
  notes?: string;
};

function cleanText(value: unknown, max = 4000): string {
  const text = String(value ?? '').trim();
  return text.length > max ? text.slice(0, max) : text;
}

function versionTuple(value: string): [number, number, number] | null {
  const match = VERSION_RE.exec(String(value || '').trim());
  if (!match) return null;
  const [, major = '0', minor = '0', patch = '0'] = match;
  return [Number(major), Number(minor), Number(patch)];
}

function isNewerVersion(candidate: string, current: string): boolean {
  const next = versionTuple(candidate);
  const prev = versionTuple(current);
  if (!next || !prev) return false;
  for (let i = 0; i < next.length; i += 1) {
    const nextPart = next[i] ?? 0;
    const prevPart = prev[i] ?? 0;
    if (nextPart > prevPart) return true;
    if (nextPart < prevPart) return false;
  }
  return false;
}

function safeUpdateUrl(rawUrl: unknown): string {
  const text = cleanText(rawUrl, 2048);
  const url = new URL(text);
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.hostname.endsWith('.localhost');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('desktop update URL must be https or loopback http');
  }
  return url.toString();
}

function platformEntry(manifest: DesktopUpdateManifest, target: string, arch: string): DesktopUpdatePlatformEntry {
  const platforms = manifest.platforms && typeof manifest.platforms === 'object'
    ? manifest.platforms as Record<string, unknown>
    : {};
  const keys = [`${target}-${arch}`, `${target}_${arch}`, target].map((key) => key.toLowerCase());
  for (const [key, value] of Object.entries(platforms)) {
    if (keys.includes(String(key).toLowerCase()) && value && typeof value === 'object') {
      return value as DesktopUpdatePlatformEntry;
    }
  }
  return manifest;
}

export function readDesktopUpdateManifest(options: DesktopUpdateManifestOptions = {}): DesktopUpdateManifestResult | null {
  const env = options.env || process.env;
  const manifestPath = cleanText(readCompatEnv(env, 'ACW_DESKTOP_UPDATE_MANIFEST', 'KCW_DESKTOP_UPDATE_MANIFEST'), 1000);
  if (!manifestPath) return null;

  const manifest = JSON.parse(fs.readFileSync(path.resolve(manifestPath), 'utf8')) as DesktopUpdateManifest;
  const version = cleanText(manifest.version, 80);
  if (!versionTuple(version)) throw new Error('desktop update manifest has invalid version');
  if (!isNewerVersion(version, cleanText(options.currentVersion, 80))) return null;

  const target = cleanText(options.target || 'windows', 80);
  const arch = cleanText(options.arch || 'x86_64', 80);
  const platform = platformEntry(manifest, target, arch);
  const signature = cleanText(platform.signature || manifest.signature, 4096);
  if (!signature) throw new Error('desktop update manifest missing signature');

  return omitUndefined({
    version,
    pub_date: cleanText(manifest.pub_date || manifest.date, 80) || undefined,
    url: safeUpdateUrl(platform.url || manifest.url),
    signature,
    notes: cleanText(manifest.notes || manifest.body, 4000) || undefined,
  });
}
