// 可视化路由小工具(host · L3 路由层 · routes)
// ---------------------------------------------------------------------------
// 职责:放置 viz routes 的响应小工具,让主路由保留业务分支。
import type { HttpResponseLike } from '../http/request-utils.js';

export function sendHtml(response: HttpResponseLike, status: number, body: string): void {
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  response.end(body);
}
