// 数据可视化渲染器:把 viz 规格渲染成自包含的单页 HTML(host · L1 领域层 · artifacts)
// ---------------------------------------------------------------------------
// 职责:支持 chart(Chart.js)/ mermaid(流程图)/ table(纯内联 HTML)三类;
//       全部用户文本经 HTML 转义、注入 <script type="application/json"> 的数据经编码,
//       杜绝脚本逃逸。
// 依赖:仅标准库;chart/mermaid 客户端库经本地打包的 /vendor/*.js 加载(见下方
//       CHART_VENDOR_SRC/MERMAID_VENDOR_SRC 注释)——不依赖本仓其他模块。
// 导出:renderViz(渲染单页)、常量 VIZ_KINDS(支持的可视化种类清单)
//
// CSP 说明(dogfood 2026-07-08 发现,全面审查修复):这段 HTML 会被塞进桌面应用里
// sandbox="allow-scripts" 的 <iframe srcDoc>(InlineViz/LiveArtifactView)。浏览器会把
// 桌面壳的 CSP(script-src 'self',无 unsafe-inline)继承给 srcdoc 子文档,子文档自己声明
// 的 <meta CSP> 无法放宽这一限制(已用 Playwright 实测确认)。因此:
// 1. 不再用 CDN <script src>(cdnjs 既不在 script-src 'self' 白名单内,机密模式下也不该
//    出网)——改成本地打包的 /vendor/chart.umd.min.js、/vendor/mermaid.min.js(经
//    apps/windows-client/ui/public/vendor 随 UI 构建产物一起分发,host 的 ui-dist 静态
//    响应器与 Tauri frontendDist 都会把它们暴露在应用自身 'self' 源下)。
// 2. 不再用内联 <script> 传数据+画图——数据放进 <script type="application/json">(非
//    可执行数据块,不受 script-src 限制),画图逻辑挪进同样本地打包的外部脚本
//    /vendor/viz-client-runtime.js + /vendor/viz-bootstrap-static.js。
type HttpError = Error & { statusCode?: number };
export type VizSpec = {
  kind?: string;
  title?: string;
  data?: unknown;
  options?: unknown;
  code?: string;
  definition?: string;
  [key: string]: unknown;
};

const CHART_KINDS = new Set(['bar', 'line', 'pie', 'doughnut']);
const CHART_VENDOR_SRC = '/vendor/chart.umd.min.js';
const MERMAID_VENDOR_SRC = '/vendor/mermaid.min.js';
const VIZ_RUNTIME_SRC = '/vendor/viz-client-runtime.js';
const VIZ_BOOTSTRAP_STATIC_SRC = '/vendor/viz-bootstrap-static.js';
const LINE_SEP = new RegExp(String.fromCharCode(0x2028), 'g');
const PARA_SEP = new RegExp(String.fromCharCode(0x2029), 'g');

/** 构造带 statusCode 的可视化错误(消息统一加 "viz: " 前缀)。 */
function fail(message: string, statusCode = 400): HttpError {
  const error = new Error(`viz: ${message}`) as HttpError;
  error.statusCode = statusCode;
  return error;
}

/** HTML 转义,防止用户文本在页面里被当作标签注入。 */
function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 序列化成可安全嵌入 <script> 的 JSON(转义 < > & 与行/段分隔符)。 */
function safeJson(value: unknown): string {
  return JSON.stringify(value ?? null)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(LINE_SEP, '\\u2028')
    .replace(PARA_SEP, '\\u2029');
}

/** 统一的页面外壳:套上 doctype/样式/标题,把 headExtra(脚本标签)与 body 填进去。 */
function htmlShell({ title, headExtra = '', body }: { title: string; headExtra?: string; body: string }): string {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)}</title>
    <style>
      :root { color-scheme: light; font-family: "Segoe UI", "Microsoft YaHei", Arial, sans-serif; }
      body { margin: 0; background: #f5f6f2; color: #20211f; }
      main { max-width: 960px; margin: 0 auto; padding: 28px 24px 44px; }
      h1 { margin: 0 0 18px; font-size: 24px; }
      .card { background: #fff; border: 1px solid #d9ded5; border-radius: 12px; padding: 20px; }
      .notice { margin: 0 0 14px; padding: 10px 12px; border-radius: 8px; background: #fff3e0; color: #8a5a00; font-size: 13px; }
      table { border-collapse: collapse; width: 100%; font-size: 14px; }
      th, td { border: 1px solid #e3e7dd; padding: 8px 10px; text-align: left; }
      th { background: #f0f2ec; font-weight: 600; }
      tbody tr:nth-child(even) { background: #fafbf8; }
    </style>
${headExtra}
  </head>
  <body>
    <main>
      <h1>${escapeHtml(title)}</h1>
      <div class="card">
${body}
      </div>
    </main>
  </body>
</html>`;
}

/** 规范化图表数据:兼容 datasets 多系列写法与 labels/values 简写,统一成 Chart.js 结构。 */
function normalizeChartData(data: unknown): { labels: unknown[]; datasets: unknown[] } {
  const record = data && typeof data === 'object' ? data as Record<string, unknown> : {};
  if (Array.isArray(record.datasets)) {
    return { labels: Array.isArray(record.labels) ? record.labels : [], datasets: record.datasets };
  }
  const labels = Array.isArray(record.labels) ? record.labels : [];
  const values = Array.isArray(record.values) ? record.values : [];
  return { labels, datasets: [{ label: record.label || '值', data: values }] };
}

// air_gap 下的说明横幅:解释为什么图表退化成了表格/原始文本,而不是静默产出一个「看起来
// 正常但其实缺功能」的页面——用户应该知道发生了什么,而不是猜。
const AIR_GAP_NOTICE = '机密模式(零出网)下已禁用外部图表脚本(Chart.js/Mermaid CDN),改为退化展示,避免打开此文件时触发联网请求。';

/** 把 {labels, datasets} 摊平成纯表格(第一列=系列名,其余列=各 label 下的值)。 */
function chartDataToTable(chartData: { labels: unknown[]; datasets: unknown[] }): { columns: unknown[]; rows: unknown[][] } {
  const columns = ['', ...chartData.labels];
  const rows = chartData.datasets.map((ds) => {
    const set = ds && typeof ds === 'object' ? ds as Record<string, unknown> : {};
    const values = Array.isArray(set.data) ? set.data : [];
    return [set.label ?? '', ...values];
  });
  return { columns, rows };
}

/** 图表的退化渲染:不加载任何外部脚本,把数据展示成纯 HTML 表格。 */
function renderChartFallback(title: string, chartData: { labels: unknown[]; datasets: unknown[] }): string {
  const { columns, rows } = chartDataToTable(chartData);
  const head = `          <thead><tr>${columns.map((c) => `<th>${escapeHtml(c)}</th>`).join('')}</tr></thead>\n`;
  const bodyRows = rows.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`).join('\n          ');
  const body = `        <p class="notice">${escapeHtml(AIR_GAP_NOTICE)}</p>
        <table>
${head}          <tbody>
          ${bodyRows}
          </tbody>
        </table>`;
  return htmlShell({ title, body });
}

/** 客户端渲染引导:vendor 库 + 共享运行时 + 静态引导脚本,均为外部 <script src>(CSP script-src 'self' 安全),
 * 配置数据放进不可执行的 <script type="application/json">。 */
function clientRenderBootstrap(vendorSrc: string, spec: Record<string, unknown>): { headExtra: string; body: string } {
  const headExtra = `    <script src="${vendorSrc}"></script>
    <script src="${VIZ_RUNTIME_SRC}"></script>`;
  const body = `        <div id="viz-root"></div>
        <script type="application/json" id="viz-config">${safeJson(spec)}</script>
        <script src="${VIZ_BOOTSTRAP_STATIC_SRC}"></script>`;
  return { headExtra, body };
}

/** 渲染图表页:数据经 <script type="application/json"> 注入,交给本地打包的 Chart.js 客户端渲染。air_gap 下退化成表格。 */
function renderChart(kind: string, title: string, spec: VizSpec, securityMode?: unknown): string {
  const chartData = normalizeChartData(spec.data);
  if (securityMode === 'air_gap') return renderChartFallback(title, chartData);
  const options = spec.options && typeof spec.options === 'object' ? spec.options : { responsive: true };
  const { headExtra, body } = clientRenderBootstrap(CHART_VENDOR_SRC, { kind, data: spec.data, options });
  return htmlShell({ title, headExtra, body });
}

/** 渲染 Mermaid 图:定义文本交给本地打包的 mermaid 客户端渲染(strict 模式)。air_gap 下只展示原始定义文本,不加载渲染脚本。 */
function renderMermaid(title: string, spec: VizSpec, securityMode?: unknown): string {
  const data = spec.data && typeof spec.data === 'object' ? spec.data as Record<string, unknown> : {};
  const definition = String((data.definition || data.code) || spec.code || spec.definition || '').trim();
  if (!definition) {
    throw fail('mermaid viz requires a diagram definition');
  }
  if (securityMode === 'air_gap') {
    const body = `        <p class="notice">${escapeHtml(AIR_GAP_NOTICE)}</p>
        <pre>${escapeHtml(definition)}</pre>`;
    return htmlShell({ title, body });
  }
  const { headExtra, body } = clientRenderBootstrap(MERMAID_VENDOR_SRC, { kind: 'mermaid', data: { definition } });
  return htmlShell({ title, headExtra, body });
}

/** 渲染表格页:纯内联 HTML(无 JS),每个单元格都经 HTML 转义。 */
function renderTable(title: string, spec: VizSpec): string {
  const data = spec.data && typeof spec.data === 'object' ? spec.data as Record<string, unknown> : {};
  const columns = Array.isArray(data.columns) ? data.columns : [];
  const rows = Array.isArray(data.rows) ? data.rows : [];
  if (columns.length === 0 && rows.length === 0) {
    throw fail('table viz requires columns or rows');
  }
  const head = columns.length
    ? `          <thead><tr>${columns.map((column) => `<th>${escapeHtml(column)}</th>`).join('')}</tr></thead>\n`
    : '';
  const bodyRows = rows
    .map((row) => `<tr>${(Array.isArray(row) ? row : [row]).map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`)
    .join('\n          ');
  const body = `        <table>
${head}          <tbody>
          ${bodyRows}
          </tbody>
        </table>`;
  return htmlShell({ title, body });
}

/** 可视化渲染入口:按 spec.kind 分发到 chart/mermaid/table,未知种类抛 400。
 * securityMode='air_gap' 时 chart/mermaid 退化为不含外部脚本的表格/原始文本——机密档
 * 的「零出网」承诺不该止步于 host 进程本身,生成的产物文件被打开时也不该触发联网请求
 * (dogfood 发现:此前 Chart.js/Mermaid CDN 引用会让机密模式下的图表文件打开即出网)。 */
export function renderViz(spec: VizSpec = {}, { securityMode }: { securityMode?: unknown } = {}): string {
  const title = spec.title ? String(spec.title) : '可视化';
  const kind = String(spec.kind || '').toLowerCase();
  if (CHART_KINDS.has(kind)) {
    return renderChart(kind, title, spec, securityMode);
  }
  if (kind === 'mermaid') {
    return renderMermaid(title, spec, securityMode);
  }
  if (kind === 'table') {
    return renderTable(title, spec);
  }
  throw fail(`unknown viz kind "${kind || '(empty)'}"`);
}

export const VIZ_KINDS = Object.freeze(['bar', 'line', 'pie', 'doughnut', 'mermaid', 'table']);
