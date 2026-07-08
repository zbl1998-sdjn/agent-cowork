// 实时制品·渲染阶段:把 viz 规格渲染成带「刷新」按钮的单页活页 HTML(host · L1 领域层 · artifacts)
// ---------------------------------------------------------------------------
// 职责:实时制品流水线「规格→渲染→刷新」的中间环——产出快照页面,接入共享的
//       客户端渲染器(Chart.js / Mermaid / 表格,见 viz.ts 同款 vendor 说明),并接入
//       fetch(dataUrl) 与 postMessage 两条刷新通道。数据一律经 <script type="application/json">
//       注入,绝不当 HTML/可执行脚本拼接。
// 依赖:live-spec(CHART_KINDS);图表/运行时库经本地打包的 /vendor/*.js 加载(与 viz.ts
//       共用同一份 vendor 资产,见该文件顶部 CSP 说明——桌面应用 CSP 继承进 srcdoc 子文档,
//       禁止内联脚本执行,已用 Playwright 实测确认子文档自带 <meta CSP> 无法放宽这一限制)。
// 导出:renderLivePage(生成活页 HTML 字符串)
import { CHART_KINDS } from './live-spec.js';
import type { VizSpec } from './viz.js';

const CHART_VENDOR_SRC = '/vendor/chart.umd.min.js';
const MERMAID_VENDOR_SRC = '/vendor/mermaid.min.js';
const VIZ_RUNTIME_SRC = '/vendor/viz-client-runtime.js';
const VIZ_BOOTSTRAP_LIVE_SRC = '/vendor/viz-bootstrap-live.js';
const U2028 = new RegExp(String.fromCharCode(0x2028), 'g');
const U2029 = new RegExp(String.fromCharCode(0x2029), 'g');

type RenderLivePageOptions = {
  title?: unknown;
  viz: VizSpec;
  dataUrl?: string;
  securityMode?: unknown;
};

const AIR_GAP_NOTICE = '机密模式(零出网)下已禁用外部图表脚本(Chart.js/Mermaid CDN),图表退化为数据表格,流程图展示为原始定义文本,避免打开此活页时触发联网请求。';

/** 序列化成可安全嵌入 <script> 的 JSON,转义 < > & 与行/段分隔符以防脚本逃逸。 */
function safeJson(value: unknown): string {
  return JSON.stringify(value ?? null)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(U2028, '\\u2028')
    .replace(U2029, '\\u2029');
}

/** HTML 转义,用于标题等注入正文的文本。 */
function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 按 viz.kind 决定要插入哪个本地 vendor 脚本标签(图表用 Chart.js,流程图用 Mermaid)。
 * air_gap 下不插入任何外部脚本标签——客户端渲染器在库缺失时会自动退化(见 viz-client-runtime.js)。 */
function libTag(kind: unknown, securityMode?: unknown): string {
  if (securityMode === 'air_gap') return '';
  const value = String(kind || '');
  if (CHART_KINDS.has(value)) {
    return `    <script src="${CHART_VENDOR_SRC}"></script>`;
  }
  if (value === 'mermaid') {
    return `    <script src="${MERMAID_VENDOR_SRC}"></script>`;
  }
  return '';
}

/** 生成实时制品活页:首屏渲染 viz 快照,并支持按钮 fetch(dataUrl) 与 postMessage 两种刷新。
 * securityMode='air_gap' 时不注入 Chart.js/Mermaid CDN 脚本,客户端渲染器自动退化。 */
export function renderLivePage({ title, viz, dataUrl, securityMode }: RenderLivePageOptions): string {
  const safeTitle = escapeHtml(title || '活页 Artifact');
  const needsExternalLib = CHART_KINDS.has(String(viz.kind || '')) || viz.kind === 'mermaid';
  const notice = securityMode === 'air_gap' && needsExternalLib
    ? `<p class="notice">${escapeHtml(AIR_GAP_NOTICE)}</p>\n      `
    : '';
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${safeTitle}</title>
    <style>
      :root { color-scheme: light; font-family: "Segoe UI", "Microsoft YaHei", Arial, sans-serif; }
      body { margin: 0; background: #f5f6f2; color: #20211f; }
      main { max-width: 960px; margin: 0 auto; padding: 24px; }
      header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
      h1 { margin: 0; font-size: 22px; }
      button { border: 1px solid #d9ded5; background: #fff; border-radius: 8px; padding: 8px 14px; cursor: pointer; font-size: 14px; }
      button:hover { background: #f0f2ec; }
      .card { background: #fff; border: 1px solid #d9ded5; border-radius: 12px; padding: 20px; }
      table { border-collapse: collapse; width: 100%; font-size: 14px; }
      th, td { border: 1px solid #e3e7dd; padding: 8px 10px; text-align: left; }
      th { background: #f0f2ec; }
      .stamp { color: #6b6f66; font-size: 12px; margin-top: 10px; }
      .notice { margin: 0 0 14px; padding: 10px 12px; border-radius: 8px; background: #fff3e0; color: #8a5a00; font-size: 13px; }
    </style>
${libTag(viz.kind, securityMode)}
    <script src="${VIZ_RUNTIME_SRC}"></script>
  </head>
  <body>
    <main>
      <header>
        <h1>${safeTitle}</h1>
        <button id="refresh" type="button">刷新</button>
      </header>
      ${notice}<div class="card"><div id="viz-root"></div></div>
      <div class="stamp" id="stamp"></div>
      <script type="application/json" id="live-artifact-init">${safeJson({ viz, dataUrl: dataUrl || '' })}</script>
      <script src="${VIZ_BOOTSTRAP_LIVE_SRC}"></script>
    </main>
  </body>
</html>`;
}
