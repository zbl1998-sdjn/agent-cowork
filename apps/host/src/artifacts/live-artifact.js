import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { assertTrustedPath } from '../security/path-policy.js';
import { renderViz } from './viz.js';

// Live HTML artifact (the create_artifact analog).
//
// Unlike a static viz, a live artifact is a self-contained page with a Refresh
// button: on load it renders an inline data snapshot, and on Refresh it fetches
// its own data endpoint and re-renders, so the same saved page stays current as
// the underlying data changes. We persist two files under .KimiCowork/artifacts:
//   <id>.html  -> the page itself
//   <id>.json  -> a manifest { id, title, viz, dataUrl } the data endpoint reads
//
// Only cdnjs is used; all injected data is unicode-escaped for <script> safety.

const ART_PARTS = ['.KimiCowork', 'artifacts'];
const ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const CHART_KINDS = new Set(['bar', 'line', 'pie', 'doughnut']);
const CHART_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js';
const MERMAID_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/mermaid/10.9.0/mermaid.min.js';
const U2028 = new RegExp(String.fromCharCode(0x2028), 'g');
const U2029 = new RegExp(String.fromCharCode(0x2029), 'g');

function fail(message, statusCode = 400) {
  const error = new Error(`artifact: ${message}`);
  error.statusCode = statusCode;
  return error;
}

function safeJson(value) {
  return JSON.stringify(value ?? null)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(U2028, '\\u2028')
    .replace(U2029, '\\u2029');
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function createArtifactId(now = new Date()) {
  const ts = now.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `viz_${ts}_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
}

function assertId(id) {
  if (!ID_RE.test(id || '')) {
    throw fail('invalid artifact id');
  }
  return id;
}

function artifactDir(trustedRoot) {
  const safeRoot = assertTrustedPath(path.resolve(trustedRoot), path.resolve(trustedRoot));
  return { safeRoot, dir: path.join(safeRoot, ...ART_PARTS) };
}

function libTag(kind) {
  if (CHART_KINDS.has(kind)) {
    return `    <script src="${CHART_CDN}"></script>`;
  }
  if (kind === 'mermaid') {
    return `    <script src="${MERMAID_CDN}"></script>`;
  }
  return '';
}

// The client-side renderer shared by the snapshot + every refresh. Builds the
// DOM with text nodes / Chart.js so artifact data is never injected as HTML.
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

export function renderLivePage({ id, title, viz, dataUrl }) {
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
      </script>
    </main>
  </body>
</html>`;
}

export function buildLiveArtifact({ trustedRoot, id, title, viz, dataUrl }) {
  if (!viz || typeof viz !== 'object') {
    throw fail('viz spec is required');
  }
  // Validate the viz spec by rendering it once (throws 400 on bad kind/data).
  renderViz(viz);
  const artifactId = id ? assertId(id) : createArtifactId();
  const { dir } = artifactDir(trustedRoot);
  fs.mkdirSync(dir, { recursive: true });
  const htmlPath = assertTrustedPath(path.join(dir, `${artifactId}.html`), path.resolve(trustedRoot));
  const manifestPath = assertTrustedPath(path.join(dir, `${artifactId}.json`), path.resolve(trustedRoot));
  const resolvedDataUrl = dataUrl || `/api/artifacts/data/${artifactId}`;
  const html = renderLivePage({ id: artifactId, title, viz, dataUrl: resolvedDataUrl });
  const manifest = {
    id: artifactId,
    title: title || '活页 Artifact',
    kind: viz.kind,
    viz,
    dataUrl: resolvedDataUrl,
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(htmlPath, html, 'utf8');
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return {
    id: artifactId,
    htmlPath,
    manifestPath,
    relativePath: [...ART_PARTS, `${artifactId}.html`].join('/'),
    dataUrl: resolvedDataUrl,
  };
}

export function readArtifactManifest({ trustedRoot, id }) {
  assertId(id);
  const { dir } = artifactDir(trustedRoot);
  const manifestPath = assertTrustedPath(path.join(dir, `${id}.json`), path.resolve(trustedRoot));
  if (!fs.existsSync(manifestPath)) {
    throw fail('artifact not found', 404);
  }
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
}

export function readLiveArtifactHtml({ trustedRoot, id }) {
  assertId(id);
  const { dir } = artifactDir(trustedRoot);
  const htmlPath = assertTrustedPath(path.join(dir, `${id}.html`), path.resolve(trustedRoot));
  if (!fs.existsSync(htmlPath)) {
    throw fail('artifact not found', 404);
  }
  return fs.readFileSync(htmlPath, 'utf8');
}
