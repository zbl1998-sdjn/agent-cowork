// 实时制品·渲染阶段:把 viz 规格渲染成带「刷新」按钮的单页活页 HTML(host · L1 领域层 · artifacts)
// ---------------------------------------------------------------------------
// 职责:实时制品流水线「规格→渲染→刷新」的中间环——产出快照页面,内置共享的
//       客户端渲染器(Chart.js / Mermaid / 表格),并接入 fetch(dataUrl) 与
//       postMessage 两条刷新通道。数据一律以文本节点/JSON 注入,绝不当 HTML 拼接。
// 依赖:live-spec(CHART_KINDS);图表库走 cdnjs。
// 导出:renderLivePage(生成活页 HTML 字符串)
import { CHART_KINDS } from './live-spec.js';
import type { VizSpec } from './viz.js';

const CHART_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js';
const MERMAID_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/mermaid/10.9.0/mermaid.min.js';
const U2028 = new RegExp(String.fromCharCode(0x2028), 'g');
const U2029 = new RegExp(String.fromCharCode(0x2029), 'g');

type RenderLivePageOptions = {
  title?: unknown;
  viz: VizSpec;
  dataUrl?: string;
};

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

/** 按 viz.kind 决定要插入哪个 cdnjs 脚本标签(图表用 Chart.js,流程图用 Mermaid)。 */
function libTag(kind: unknown): string {
  const value = String(kind || '');
  if (CHART_KINDS.has(value)) {
    return `    <script src="${CHART_CDN}"></script>`;
  }
  if (value === 'mermaid') {
    return `    <script src="${MERMAID_CDN}"></script>`;
  }
  return '';
}

// 客户端渲染器由快照与每次刷新共用;只用文本节点/Chart.js 构建 DOM,制品数据绝不当 HTML 注入。
const CLIENT_RENDERER = `
        var chart = null;
        function clearRoot(root) { while (root.firstChild) { root.removeChild(root.firstChild); } if (chart) { chart.destroy(); chart = null; } }
        function renderChart(root, spec) {
          var canvas = document.createElement('canvas');
          canvas.height = 320;
          root.appendChild(canvas);
          var data = spec.data || {};
          var config = Array.isArray(data.datasets)
            ? { type: spec.kind, data: { labels: data.labels || [], datasets: data.datasets }, options: spec.options || { responsive: true } }
            : { type: spec.kind, data: { labels: data.labels || [], datasets: [{ label: data.label || '值', data: data.values || [] }] }, options: spec.options || { responsive: true } };
          if (window.Chart) { chart = new window.Chart(canvas.getContext('2d'), config); }
        }
        function renderTable(root, spec) {
          var data = spec.data || {};
          var table = document.createElement('table');
          if ((data.columns || []).length) {
            var thead = document.createElement('thead');
            var htr = document.createElement('tr');
            (data.columns || []).forEach(function (c) { var th = document.createElement('th'); th.textContent = String(c); htr.appendChild(th); });
            thead.appendChild(htr); table.appendChild(thead);
          }
          var tbody = document.createElement('tbody');
          (data.rows || []).forEach(function (row) {
            var tr = document.createElement('tr');
            (Array.isArray(row) ? row : [row]).forEach(function (cell) { var td = document.createElement('td'); td.textContent = String(cell); tr.appendChild(td); });
            tbody.appendChild(tr);
          });
          table.appendChild(tbody); root.appendChild(table);
        }
        function renderMermaid(root, spec) {
          var pre = document.createElement('pre');
          pre.className = 'mermaid';
          pre.textContent = String((spec.data && (spec.data.definition || spec.data.code)) || spec.code || '');
          root.appendChild(pre);
          if (window.mermaid) { window.mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' }); window.mermaid.run({ nodes: [pre] }); }
        }
        function render(spec) {
          var root = document.getElementById('viz-root');
          clearRoot(root);
          if (!spec || !spec.kind) { return; }
          if (spec.kind === 'table') { renderTable(root, spec); }
          else if (spec.kind === 'mermaid') { renderMermaid(root, spec); }
          else { renderChart(root, spec); }
        }`;

/** 生成实时制品活页:首屏渲染 viz 快照,并支持按钮 fetch(dataUrl) 与 postMessage 两种刷新。 */
export function renderLivePage({ title, viz, dataUrl }: RenderLivePageOptions): string {
  const safeTitle = escapeHtml(title || '活页 Artifact');
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
    </style>
${libTag(viz.kind)}
  </head>
  <body>
    <main>
      <header>
        <h1>${safeTitle}</h1>
        <button id="refresh" type="button">刷新</button>
      </header>
      <div class="card"><div id="viz-root"></div></div>
      <div class="stamp" id="stamp"></div>
      <script>
        var INITIAL = ${safeJson(viz)};
        var DATA_URL = ${safeJson(dataUrl || '')};
${CLIENT_RENDERER}
        function stamp(text) { document.getElementById('stamp').textContent = text; }
        render(INITIAL);
        stamp('快照渲染于 ' + new Date().toLocaleString());
        var btn = document.getElementById('refresh');
        if (btn) {
          btn.addEventListener('click', function () {
            if (!DATA_URL) { return; }
            stamp('刷新中…');
            fetch(DATA_URL, { headers: { 'accept': 'application/json' } })
              .then(function (r) { return r.json(); })
              .then(function (j) { if (j && j.viz) { render(j.viz); stamp('已刷新于 ' + new Date().toLocaleString()); } })
              .catch(function (e) { stamp('刷新失败: ' + e.message); });
          });
        }
        window.addEventListener('message', function (event) {
          var data = event && event.data ? event.data : {};
          if (data.type === 'agent-cowork:live-artifact-data' && data.viz) {
            render(data.viz);
            stamp('已刷新于 ' + new Date().toLocaleString());
          }
        });
      </script>
    </main>
  </body>
</html>`;
}
