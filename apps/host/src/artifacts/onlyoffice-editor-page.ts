// ONLYOFFICE 编辑承载页(host · L1 artifacts)
// ---------------------------------------------------------------------------
// 职责:生成最小、nonce-CSP 约束的 DocEditor 页面；config 整体用共享 secret 签名。
import crypto from 'node:crypto';
import path from 'node:path';

import type { OnlyOfficeConfig } from './onlyoffice-config.js';
import { signOnlyOfficeJwt } from './onlyoffice-jwt.js';
import type { OnlyOfficeSessionClaims } from './onlyoffice-session.js';

function documentType(copyName: string): 'word' | 'cell' | 'slide' {
  const extension = path.extname(copyName).toLowerCase();
  if (extension === '.docx') return 'word';
  if (extension === '.xlsx') return 'cell';
  if (extension === '.pptx') return 'slide';
  throw new Error('ONLYOFFICE supports DOCX, XLSX and PPTX artifacts');
}

function endpoint(base: string, route: string, sessionToken: string): string {
  const url = new URL(route, `${base}/`);
  url.searchParams.set('session', sessionToken);
  return url.toString();
}

function safeScriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</gu, '\\u003c').replace(/\u2028|\u2029/gu, (char) => (
    char === '\u2028' ? '\\u2028' : '\\u2029'
  ));
}

export function createOnlyOfficeEditorPage(input: {
  config: OnlyOfficeConfig;
  sessionToken: string;
  claims: OnlyOfficeSessionClaims;
}): { html: string; contentSecurityPolicy: string } {
  const { config, sessionToken, claims } = input;
  const extension = path.extname(claims.copyName).slice(1).toLowerCase();
  const contentUrl = endpoint(config.publicBaseUrl, '/api/artifacts/onlyoffice/content', sessionToken);
  const callbackUrl = endpoint(config.publicBaseUrl, '/api/artifacts/onlyoffice/callback', sessionToken);
  const editorConfig = {
    type: 'desktop',
    width: '100%',
    height: '100%',
    documentType: documentType(claims.copyName),
    document: {
      fileType: extension,
      key: claims.documentKey,
      title: path.basename(claims.sourcePath),
      url: contentUrl,
      permissions: { edit: true, download: true, print: true, review: true },
    },
    editorConfig: {
      callbackUrl,
      lang: 'zh-CN',
      region: 'zh-CN',
      mode: 'edit',
      user: { id: claims.userId, name: claims.userId },
      customization: { autosave: true, forcesave: false },
    },
  };
  const signedConfig = { ...editorConfig, token: signOnlyOfficeJwt(editorConfig, config.jwtSecret) };
  const nonce = crypto.randomBytes(18).toString('base64');
  const server = new URL(config.documentServerUrl);
  const apiUrl = new URL('web-apps/apps/api/documents/api.js', `${config.documentServerUrl}/`).toString();
  const webSocketOrigin = `${server.protocol === 'https:' ? 'wss:' : 'ws:'}//${server.host}`;
  const contentSecurityPolicy = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}' ${server.origin}`,
    `style-src 'nonce-${nonce}'`,
    `frame-src ${server.origin}`,
    `connect-src ${server.origin} ${webSocketOrigin}`,
    `img-src ${server.origin} data: blob:`,
    "font-src data:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'self' http://tauri.localhost https://tauri.localhost http://127.0.0.1:5173",
  ].join('; ');
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ONLYOFFICE</title><style nonce="${nonce}">html,body,#editor{width:100%;height:100%;margin:0;overflow:hidden;background:#f5f6f8}#error{display:none;padding:24px;color:#a53b29;font:14px/1.6 sans-serif}</style></head><body><div id="editor"></div><div id="error">ONLYOFFICE 编辑器加载失败，请检查 Document Server 状态。</div><script src="${apiUrl}"></script><script nonce="${nonce}">try{new DocsAPI.DocEditor("editor",${safeScriptJson(signedConfig)})}catch(error){document.getElementById("editor").hidden=true;document.getElementById("error").style.display="block"}</script></body></html>`;
  return { html, contentSecurityPolicy };
}
