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

const CHART_KINDS = new Set(['bar', 'line', 'pie', 'doughnut']);
const CHART_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js';
const MERMAID_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/mermaid/10.9.0/mermaid.min.js';
const LINE_SEP = new RegExp(String.fromCharCode(0x2028), "g");
const PARA_SEP = new RegExp(String.fromCharCode(0x2029), "g");

function fail(message, statusCode = 400) {
  const error = new Error(`viz: ${message}`);
  error.statusCode = statusCode;
  return error;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// JSON safe to embed inside a <script> tag.
function safeJson(value) {
  return JSON.stringify(value ?? null)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(LINE_SEP, '\\u2028')
    .replace(PARA_SEP, '\\u2029');
}

function htmlShell({ title, headExtra = '', body }) {
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

function normalizeChartData(data) {
  if (data && Array.isArray(data.datasets)) {
    return { labels: Array.isArray(data.labels) ? data.labels : [], datasets: data.datasets };
  }
  const labels = data && Array.isArray(data.labels) ? data.labels : [];
  const values = data && Array.isArray(data.values) ? data.values : [];
  return { labels, datasets: [{ label: (data && data.label) || '值', data: values }] };
}

function renderChart(kind, title, spec) {
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

function renderMermaid(title, spec) {
  const definition = String(
    (spec.data && (spec.data.definition || spec.data.code)) || spec.code || spec.definition || '',
  ).trim();
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

function renderTable(title, spec) {
  const data = spec.data || {};
  const columns = Array.isArray(data.columns) ? data.columns : [];
  const rows = Array.isArray(data.rows) ? data.rows : [];
  if (columns.length === 0 && rows.length === 0) {
    throw fail('table viz requires columns or rows');
  }
  const head = columns.length
    ? `          <thead><tr>${columns.map((c) => `<th>${escapeHtml(c)}</th>`).join('')}</tr></thead>\n`
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

export function renderViz(spec = {}) {
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
