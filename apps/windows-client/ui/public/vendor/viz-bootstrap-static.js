// Agent Cowork viz 静态引导脚本(本地打包,零 CDN 依赖)
// ---------------------------------------------------------------------------
// 职责:配合 apps/host/src/artifacts/viz.ts 的 renderChart/renderMermaid 输出——
// 从 <script type="application/json" id="viz-config"> 读取 viz spec(非可执行数据块,
// 不受桌面应用 CSP 的 script-src 限制),用共享的 viz-client-runtime.js 渲染一次。
// 无刷新能力(一次性快照),供 InlineViz 内联可视化使用。
(function () {
  'use strict';
  var configEl = document.getElementById('viz-config');
  var rootEl = document.getElementById('viz-root');
  if (!configEl || !rootEl || !window.AgentCoworkViz) return;
  var spec;
  try {
    spec = JSON.parse(configEl.textContent || 'null');
  } catch (e) {
    return;
  }
  window.AgentCoworkViz.createRenderer(rootEl).render(spec);
})();
