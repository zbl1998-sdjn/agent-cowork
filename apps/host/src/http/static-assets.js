import fs from 'node:fs';
import path from 'node:path';
import { sendFile } from './request-utils.js';

/**
 * @typedef {import('./request-utils.js').HttpRequestLike & { method?: string }} StaticRequest
 * @typedef {import('./request-utils.js').HttpResponseLike} StaticResponse
 * @typedef {{ file: string, type: string }} StaticAsset
 */

const STATIC_FILES = new Map([
  ['/', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/index.html', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/app.css', { file: 'app.css', type: 'text/css; charset=utf-8' }],
  ['/app-utils.js', { file: 'app-utils.js', type: 'text/javascript; charset=utf-8' }],
  ['/app-api-client.js', { file: 'app-api-client.js', type: 'text/javascript; charset=utf-8' }],
  ['/app-run-events.js', { file: 'app-run-events.js', type: 'text/javascript; charset=utf-8' }],
  ['/app-composer-popover.js', { file: 'app-composer-popover.js', type: 'text/javascript; charset=utf-8' }],
  ['/app.js', { file: 'app.js', type: 'text/javascript; charset=utf-8' }],
]);

/** @type {Readonly<Record<string, string>>} */
const UI_DIST_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/** @param {string} hostSrcDir @returns {string} */
export function defaultStaticRoot(hostSrcDir) {
  return path.resolve(hostSrcDir, '../../windows-client/resources');
}

/** @param {string} hostSrcDir @returns {string} */
export function defaultUiDistRoot(hostSrcDir) {
  return path.resolve(path.join(hostSrcDir, '../../windows-client/ui-dist'));
}

/** @param {{ uiDist?: boolean }} config @param {string} uiDistRoot @returns {boolean} */
export function isUiDistEnabled(config, uiDistRoot) {
  return config.uiDist !== false && fs.existsSync(path.join(uiDistRoot, 'index.html'));
}

/** @param {{ staticRoot?: string | null, uiDistRoot: string, uiDistEnabled?: boolean }} options */
export function createStaticResponder({ staticRoot, uiDistRoot, uiDistEnabled }) {
  /** @param {StaticResponse} response @param {string} pathname @returns {boolean} */
  function serveFromUiDist(response, pathname) {
    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const candidate = path.resolve(uiDistRoot, rel);
    const inside = candidate === uiDistRoot || candidate.startsWith(uiDistRoot + path.sep);
    if (!inside) return false;
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      sendFile(response, candidate, UI_DIST_TYPES[path.extname(candidate).toLowerCase()] || 'application/octet-stream');
      return true;
    }
    if (!path.extname(rel)) {
      sendFile(response, path.join(uiDistRoot, 'index.html'), 'text/html; charset=utf-8');
      return true;
    }
    return false;
  }

  /** @param {StaticRequest} request @param {StaticResponse} response @param {string} pathname @returns {boolean} */
  return function serveStatic(request, response, pathname) {
    if (request.method === 'GET' && uiDistEnabled && pathname !== '/health' && pathname !== '/metrics' && !pathname.startsWith('/api/')) {
      if (serveFromUiDist(response, pathname)) return true;
    }
    if (request.method === 'GET' && staticRoot && STATIC_FILES.has(pathname)) {
      const asset = /** @type {StaticAsset} */ (STATIC_FILES.get(pathname));
      sendFile(response, path.join(staticRoot, asset.file), asset.type);
      return true;
    }
    return false;
  };
}
