// 数据可视化渲染器:把 viz 规格渲染成自包含的单页 HTML(host · L1 领域层 · artifacts)
// ---------------------------------------------------------------------------
// 职责:支持 chart(Chart.js)/ mermaid(流程图)/ table(纯内联 HTML)三类;
//       全部用户文本经 HTML 转义、注入 <script> 的数据经编码,杜绝脚本逃逸。
// 依赖:仅标准库与 cdnjs 上的两个图表库;不依赖本仓其他模块。
// 导出:renderViz(渲染单页)、常量 VIZ_KINDS(支持的可视化种类清单)

// Inline visualization renderer (the show_widget analog).
//
// renderViz(spec) -> a self-contained HTML document string for one of:
//   - chart  : kind bar | line | pie | doughnut  (Chart.js from cdnjs)
//   - mermaid: a diagram definition               (Mermaid from cdnjs)
//   - table  : columns + rows                     (inline HTML, no JS)
//
// All user-supplied text is HTML-escaped, and all data injected into <script>
// is encoded so it cannot break out of the script context (no `</script>`,
// no `<!--`, no U+2028/2029). Only cdnjs is used for the two chart libs.

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
const CHART_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js';
const MERMAID_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/mermaid/10.9.0/mermaid.min.js';
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

/** 渲染图表页:数据经 safeJson 注入脚本,由 Chart.js 在 canvas 上绘制。 */
function renderChart(kind: string, title: string, spec: VizSpec): string {
  const chartData = normalizeChartData(spec.data);
  const options = spec.options && typeof spec.options === 'object' ? spec.options : { responsive: true };
  const config = { type: kind, data: chartData, options };
  const headExtra = `    <script src="${CHART_CDN}"></script>`;
  const body = `        <canvas id="viz-canvas" height="320"></canvas>
        <script>
          (function () {
            var config = ${safeJson(config)};
            var el = document.getElementById('viz-canvas');
            if (window.Chart && el) { new window.Chart(el.getContext('2d'), config); }
          })();
        </script>`;
  return htmlShell({ title, headExtra, body });
}

/** 渲染 Mermaid 图:定义文本经 HTML 转义后交给 strict 模式的 mermaid 渲染。 */
function renderMermaid(title: string, spec: VizSpec): string {
  const data = spec.data && typeof spec.data === 'object' ? spec.data as Record<string, unknown> : {};
  const definition = String((data.definition || data.code) || spec.code || spec.definition || '').trim();
  if (!definition) {
    throw fail('mermaid viz requires a diagram definition');
  }
  const headExtra = `    <script src="${MERMAID_CDN}"></script>`;
  const body = `        <pre class="mermaid">${escapeHtml(definition)}</pre>
        <script>
          if (window.mermaid) { window.mermaid.initialize({ startOnLoad: true, securityLevel: 'strict' }); }
        </script>`;
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

/** 可视化渲染入口:按 spec.kind 分发到 chart/mermaid/table,未知种类抛 400。 */
export function renderViz(spec: VizSpec = {}): string {
  const title = spec.title ? String(spec.title) : '可视化';
  const kind = String(spec.kind || '').toLowerCase();
  if (CHART_KINDS.has(kind)) {
    return renderChart(kind, title, spec);
  }
  if (kind === 'mermaid') {
    return renderMermaid(title, spec);
  }
  if (kind === 'table') {
    return renderTable(title, spec);
  }
  throw fail(`unknown viz kind "${kind || '(empty)'}"`);
}

export const VIZ_KINDS = Object.freeze(['bar', 'line', 'pie', 'doughnut', 'mermaid', 'table']);
