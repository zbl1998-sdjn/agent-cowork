// 静态资源服务(host · L0 基础层,仅依赖同层 request-utils)
// ---------------------------------------------------------------------------
// 职责:把前端构建产物(ui-dist)与少量内置静态文件经 HTTP 直出给浏览器/Tauri
//       webview。/api/、/health、/metrics 不在此处理(交给路由层)。
// 优先级:先试 ui-dist(支持 SPA 回退到 index.html),再退回内置 STATIC_FILES。
// 导出:defaultStaticRoot / defaultUiDistRoot / isUiDistEnabled / createStaticResponder。

import fs from 'node:fs';
import path from 'node:path';
import { sendFile } from './request-utils.js';

export type StaticRequest = { method?: string; headers?: Record<string, string | string[] | undefined> };
export type StaticResponse = {
  writeHead(statusCode: number, headers?: Record<string, string | number>): unknown;
  end(chunk?: string | Buffer): unknown;
};
export type StaticAsset = { file: string; type: string };
export type StaticResponderOptions = {
  staticRoot?: string | null;
  uiDistRoot: string;
  uiDistEnabled?: boolean;
};
export type StaticResponder = (request: StaticRequest, response: StaticResponse, pathname: string) => boolean;

// 内置静态文件白名单:仅这些 URL → 文件名映射会被直出(防止任意文件读取)。
const STATIC_FILES = new Map<string, StaticAsset>([
  ['/', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/index.html', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/app.css', { file: 'app.css', type: 'text/css; charset=utf-8' }],
  ['/app-utils.js', { file: 'app-utils.js', type: 'text/javascript; charset=utf-8' }],
  ['/app-api-client.js', { file: 'app-api-client.js', type: 'text/javascript; charset=utf-8' }],
  ['/app-run-events.js', { file: 'app-run-events.js', type: 'text/javascript; charset=utf-8' }],
  ['/app-composer-sources.js', { file: 'app-composer-sources.js', type: 'text/javascript; charset=utf-8' }],
  ['/app-composer-popover.js', { file: 'app-composer-popover.js', type: 'text/javascript; charset=utf-8' }],
  ['/app-artifacts.js', { file: 'app-artifacts.js', type: 'text/javascript; charset=utf-8' }],
  ['/app-run-history.js', { file: 'app-run-history.js', type: 'text/javascript; charset=utf-8' }],
  ['/app-workbench-renderer.js', { file: 'app-workbench-renderer.js', type: 'text/javascript; charset=utf-8' }],
  ['/app-task-context.js', { file: 'app-task-context.js', type: 'text/javascript; charset=utf-8' }],
  ['/app-kimi-runner.js', { file: 'app-kimi-runner.js', type: 'text/javascript; charset=utf-8' }],
  ['/app-message-renderer.js', { file: 'app-message-renderer.js', type: 'text/javascript; charset=utf-8' }],
  ['/app-chat-runner.js', { file: 'app-chat-runner.js', type: 'text/javascript; charset=utf-8' }],
  ['/app-approval-runner.js', { file: 'app-approval-runner.js', type: 'text/javascript; charset=utf-8' }],
  ['/app-message-actions.js', { file: 'app-message-actions.js', type: 'text/javascript; charset=utf-8' }],
  ['/app-file-upload.js', { file: 'app-file-upload.js', type: 'text/javascript; charset=utf-8' }],
  ['/app.js', { file: 'app.js', type: 'text/javascript; charset=utf-8' }],
]);

// ui-dist 下按扩展名映射 Content-Type 的表(未命中则 octet-stream)。
const UI_DIST_TYPES: Readonly<Record<string, string>> = {
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

/** 内置静态资源目录(windows-client/resources)的默认位置。 */
export function defaultStaticRoot(hostSrcDir: string): string {
  return path.resolve(hostSrcDir, '../../windows-client/resources');
}

/** 前端构建产物目录(windows-client/ui-dist)的默认位置。 */
export function defaultUiDistRoot(hostSrcDir: string): string {
  return path.resolve(path.join(hostSrcDir, '../../windows-client/ui-dist'));
}

/** ui-dist 是否可用:未被配置关闭且存在 index.html。 */
export function isUiDistEnabled(config: { uiDist?: boolean }, uiDistRoot: string): boolean {
  return config.uiDist !== false && fs.existsSync(path.join(uiDistRoot, 'index.html'));
}

/** 造一个静态响应器:返回的 serveStatic 命中静态请求时直出并返回 true,否则 false 交给后续路由。 */
export function createStaticResponder({ staticRoot, uiDistRoot, uiDistEnabled }: StaticResponderOptions): StaticResponder {
  // 从 ui-dist 提供文件:命中真实文件直出;无扩展名的路径回退到 index.html(SPA 路由)。
  function serveFromUiDist(response: StaticResponse, pathname: string): boolean {
    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const candidate = path.resolve(uiDistRoot, rel);
    // 防目录穿越:解析后的候选路径必须仍落在 uiDistRoot 之内。
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

  return function serveStatic(request, response, pathname) {
    if (request.method === 'GET' && uiDistEnabled && pathname !== '/health' && pathname !== '/metrics' && !pathname.startsWith('/api/')) {
      if (serveFromUiDist(response, pathname)) return true;
    }
    if (request.method === 'GET' && staticRoot && STATIC_FILES.has(pathname)) {
      const asset = STATIC_FILES.get(pathname);
      if (!asset) return false;
      sendFile(response, path.join(staticRoot, asset.file), asset.type);
      return true;
    }
    return false;
  };
}
