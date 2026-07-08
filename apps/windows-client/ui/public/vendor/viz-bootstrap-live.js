// Agent Cowork 活页(live-artifact)引导脚本(本地打包,零 CDN 依赖)
// ---------------------------------------------------------------------------
// 职责:配合 apps/host/src/artifacts/live-render.ts 的 renderLivePage 输出——
// 从 <script type="application/json" id="live-artifact-init"> 读取 {viz, dataUrl}
// (非可执行数据块,不受桌面应用 CSP 的 script-src 限制),首屏渲染一次快照;
// 支持点击「刷新」按钮 fetch(dataUrl) 拉新数据,以及监听宿主 postMessage 推送新数据
// (供 LiveArtifactView.tsx 的手动/自动刷新调用 iframe.contentWindow.postMessage 使用)。
(function () {
  'use strict';
  var initEl = document.getElementById('live-artifact-init');
  var rootEl = document.getElementById('viz-root');
  var stampEl = document.getElementById('stamp');
  if (!initEl || !rootEl || !window.AgentCoworkViz) return;
  var init;
  try {
    init = JSON.parse(initEl.textContent || 'null');
  } catch (e) {
    return;
  }
  var renderer = window.AgentCoworkViz.createRenderer(rootEl);
  var dataUrl = (init && init.dataUrl) || '';

  function stamp(text) { if (stampEl) stampEl.textContent = text; }

  renderer.render(init && init.viz);
  stamp('快照渲染于 ' + new Date().toLocaleString());

  var btn = document.getElementById('refresh');
  if (btn) {
    btn.addEventListener('click', function () {
      if (!dataUrl) return;
      stamp('刷新中…');
      fetch(dataUrl, { headers: { accept: 'application/json' } })
        .then(function (r) { return r.json(); })
        .then(function (j) { if (j && j.viz) { renderer.render(j.viz); stamp('已刷新于 ' + new Date().toLocaleString()); } })
        .catch(function (e) { stamp('刷新失败: ' + e.message); });
    });
  }

  window.addEventListener('message', function (event) {
    var data = (event && event.data) || {};
    if (data.type === 'agent-cowork:live-artifact-data' && data.viz) {
      renderer.render(data.viz);
      stamp('已刷新于 ' + new Date().toLocaleString());
    }
  });
})();
