import fs from 'node:fs';
import path from 'node:path';

// @ts-check

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/;

/** @param {unknown} value @param {number} max @returns {string} */
function cleanText(value, max = 4000) {
  const text = String(value ?? '').trim();
  return text.length > max ? text.slice(0, max) : text;
}

/** @param {string} value @returns {[number, number, number] | null} */
function versionTuple(value) {
  const match = VERSION_RE.exec(String(value || '').trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** @param {string} candidate @param {string} current @returns {boolean} */
function isNewerVersion(candidate, current) {
  const next = versionTuple(candidate);
  const prev = versionTuple(current);
  if (!next || !prev) return false;
  for (let i = 0; i < next.length; i += 1) {
    if (next[i] > prev[i]) return true;
    if (next[i] < prev[i]) return false;
  }
  return false;
}

/** @param {unknown} rawUrl @returns {string} */
function safeUpdateUrl(rawUrl) {
  const text = cleanText(rawUrl, 2048);
  const url = new URL(text);
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.hostname.endsWith('.localhost');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('desktop update URL must be https or loopback http');
  }
  return url.toString();
}

/** @param {any} manifest @param {string} target @param {string} arch @returns {{ url?: unknown, signature?: unknown }} */
function platformEntry(manifest, target, arch) {
  const platforms = manifest.platforms && typeof manifest.platforms === 'object' ? manifest.platforms : {};
  const keys = [`${target}-${arch}`, `${target}_${arch}`, target].map((key) => key.toLowerCase());
  for (const [key, value] of Object.entries(platforms)) {
    if (keys.includes(String(key).toLowerCase()) && value && typeof value === 'object') {
      return /** @type {{ url?: unknown, signature?: unknown }} */ (value);
    }
  }
  return manifest;
}

/**
 * @param {{ env?: Record<string, string | undefined>, target?: string, arch?: string, currentVersion?: string }} options
 * @returns {{ version: string, pub_date?: string, url: string, signature: string, notes?: string } | null}
 */
export function readDesktopUpdateManifest(options = {}) {
  const env = options.env || process.env;
  const manifestPath = cleanText(env.KCW_DESKTOP_UPDATE_MANIFEST, 1000);
  if (!manifestPath) return null;

  const manifest = JSON.parse(fs.readFileSync(path.resolve(manifestPath), 'utf8'));
  const version = cleanText(manifest.version, 80);
  if (!versionTuple(version)) throw new Error('desktop update manifest has invalid version');
  if (!isNewerVersion(version, cleanText(options.currentVersion, 80))) return null;

  const target = cleanText(options.target || 'windows', 80);
  const arch = cleanText(options.arch || 'x86_64', 80);
  const platform = platformEntry(manifest, target, arch);
  const signature = cleanText(platform.signature || manifest.signature, 4096);
  if (!signature) throw new Error('desktop update manifest missing signature');

  return {
    version,
    pub_date: cleanText(manifest.pub_date || manifest.date, 80) || undefined,
    url: safeUpdateUrl(platform.url || manifest.url),
    signature,
    notes: cleanText(manifest.notes || manifest.body, 4000) || undefined,
  };
}
