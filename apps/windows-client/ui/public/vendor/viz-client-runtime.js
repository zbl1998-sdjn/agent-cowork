// Agent Cowork viz 客户端渲染运行时(本地打包,零 CDN 依赖)
// ---------------------------------------------------------------------------
// 职责:chart/mermaid/table 三类可视化的浏览器端渲染分发,供活页(live-artifact)与
// 内联可视化(InlineViz)共用同一份逻辑。本文件不内嵌任何用户数据——数据一律由调用方
// 经 <script type="application/json"> 或函数参数传入,因此可以安全地作为外部
// <script src> 加载(满足桌面应用 CSP 的 script-src 'self',不依赖内联脚本执行权限)。
// 依赖:全局 window.Chart(chart.umd.min.js)/window.mermaid(mermaid.min.js),按需存在。
(function (global) {
  'use strict';

  function renderChart(root, spec, state) {
    var data = spec.data || {};
    var labels = data.labels || [];
    var datasets = Array.isArray(data.datasets) ? data.datasets : [{ label: data.label || '值', data: data.values || [] }];
    if (!global.Chart) {
      // 图表库未加载(air_gap 下按设计不注入本地图表脚本):不留空白画布,退化成数据表格。
      var notice = document.createElement('p');
      notice.className = 'notice';
      notice.textContent = '图表脚本未加载,展示原始数据:';
      root.appendChild(notice);
      renderTable(root, { data: { columns: [''].concat(labels), rows: datasets.map(function (ds) { return [ds.label || ''].concat(ds.data || []); }) } });
      return;
    }
    var canvas = document.createElement('canvas');
    canvas.height = 320;
    root.appendChild(canvas);
    var config = { type: spec.kind, data: { labels: labels, datasets: datasets }, options: spec.options || { responsive: true } };
    state.chart = new global.Chart(canvas.getContext('2d'), config);
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
    pre.textContent = String((spec.data && (spec.data.definition || spec.data.code)) || spec.code || spec.definition || '');
    root.appendChild(pre);
    if (global.mermaid) { global.mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' }); global.mermaid.run({ nodes: [pre] }); }
  }

  function clearRoot(root, state) {
    while (root.firstChild) { root.removeChild(root.firstChild); }
    if (state.chart) { state.chart.destroy(); state.chart = null; }
  }

  /** 创建一个绑定到指定容器的渲染器;每次 render() 会先清空容器并销毁上一个 Chart 实例(供活页刷新复用)。 */
  function createRenderer(root) {
    var state = { chart: null };
    return {
      render: function (spec) {
        clearRoot(root, state);
        if (!spec || !spec.kind) return;
        if (spec.kind === 'table') renderTable(root, spec);
        else if (spec.kind === 'mermaid') renderMermaid(root, spec);
        else renderChart(root, spec, state);
      },
    };
  }

  global.AgentCoworkViz = { createRenderer: createRenderer };
})(window);
