import assert from 'node:assert/strict';
import test from 'node:test';
import { renderViz, VIZ_KINDS } from '../src/artifacts/viz.js';

// CSP 说明(dogfood 全面审查修复,2026-07-08):产物 HTML 会被塞进桌面应用 sandbox="allow-scripts"
// 的 <iframe srcDoc> 内,浏览器把壳的 CSP(script-src 'self',无 unsafe-inline)继承给 srcdoc
// 子文档且无法被子文档自身 <meta CSP> 放宽(已用 Playwright 实测确认)。因此不再用 CDN <script src>
// 或内联 <script> 画图——改成本地打包的 /vendor/*.js 外部脚本 + <script type="application/json">
// 承载数据(非可执行数据块,不受 script-src 限制)。见 apps/host/src/artifacts/viz.ts 顶部注释。
test('renderViz bar chart references the local Chart.js vendor script, config data, and the title', () => {
  const html = renderViz({
    title: '季度收入',
    kind: 'bar',
    data: { labels: ['Q1', 'Q2'], values: [10, 20] },
  });
  assert.match(html, /<!doctype html>/);
  assert.match(html, /<script src="\/vendor\/chart\.umd\.min\.js"><\/script>/);
  assert.match(html, /<script src="\/vendor\/viz-client-runtime\.js"><\/script>/);
  assert.match(html, /<script src="\/vendor\/viz-bootstrap-static\.js"><\/script>/);
  assert.match(html, /<script type="application\/json" id="viz-config">/);
  assert.match(html, /"labels":\["Q1","Q2"\]/);
  assert.match(html, /季度收入/);
  assert.equal(html.includes('cdnjs.cloudflare.com'), false, '不得引用 CDN');
  assert.equal(/<script>[\s\S]*<\/script>/.test(html), false, '不得内联可执行 <script>(CSP script-src \'self\' 会拦截)');
});

test('renderViz supports line / pie / doughnut kinds', () => {
  for (const kind of ['line', 'pie', 'doughnut']) {
    const html = renderViz({ kind, data: { labels: ['a'], values: [1] } });
    assert.match(html, new RegExp(`"kind":"${kind}"`));
  }
});

test('renderViz mermaid references the definition and the local Mermaid vendor script', () => {
  const html = renderViz({ title: '流程', kind: 'mermaid', data: { definition: 'graph TD; A-->B' } });
  assert.match(html, /"kind":"mermaid"/);
  assert.match(html, /graph TD; A--\\u003eB/);
  assert.match(html, /<script src="\/vendor\/mermaid\.min\.js"><\/script>/);
  assert.equal(html.includes('cdnjs.cloudflare.com'), false, '不得引用 CDN');
});

test('renderViz air_gap: chart degrades to a data table, no external CDN script (dogfood security fix)', () => {
  const html = renderViz(
    { title: '季度收入', kind: 'bar', data: { labels: ['Q1', 'Q2'], values: [10, 20] } },
    { securityMode: 'air_gap' },
  );
  assert.equal(html.includes('cdnjs.cloudflare.com'), false, 'air_gap must not reference any CDN');
  assert.equal(html.includes('<script'), false, 'air_gap chart fallback must not embed any script tag');
  assert.match(html, /<table>/);
  assert.match(html, /Q1/);
  assert.match(html, />10</); // 原始数值仍以表格形式保留,不是静默丢数据
});

test('renderViz air_gap: mermaid degrades to raw definition text, no external CDN script', () => {
  const html = renderViz(
    { title: '流程', kind: 'mermaid', data: { definition: 'graph TD; A-->B' } },
    { securityMode: 'air_gap' },
  );
  assert.equal(html.includes('cdnjs.cloudflare.com'), false, 'air_gap must not reference any CDN');
  assert.equal(html.includes('<script'), false, 'air_gap mermaid fallback must not embed any script tag');
  assert.match(html, /graph TD; A--&gt;B/); // 原始定义文本仍可读,不是空白页面
});

test('renderViz non-air_gap modes are unaffected (no regression for the default/common path)', () => {
  const html = renderViz(
    { kind: 'bar', data: { labels: ['a'], values: [1] } },
    { securityMode: 'controlled_hybrid' },
  );
  assert.match(html, /<script src="\/vendor\/chart\.umd\.min\.js"><\/script>/);
});

test('renderViz table escapes cell content', () => {
  const html = renderViz({
    kind: 'table',
    data: { columns: ['名称', '值'], rows: [['<script>', '1']] },
  });
  assert.match(html, /<table>/);
  assert.match(html, /&lt;script&gt;/);
  assert.ok(!html.includes('<td><script></td>'), 'raw script tag must not appear in a cell');
});

test('renderViz throws 400 on an unknown kind and on empty mermaid/table', () => {
  assert.throws(() => renderViz({ kind: 'pyramid' }), (error: unknown) => {
    assert.equal((error as { statusCode?: unknown }).statusCode, 400);
    return true;
  });
  assert.throws(() => renderViz({ kind: 'mermaid', data: {} }), /definition/);
  assert.throws(() => renderViz({ kind: 'table', data: {} }), /columns or rows/);
});

test('renderViz neutralizes script-breakout attempts in chart data', () => {
  const evil = '</script><script>alert(1)</script>';
  const html = renderViz({ kind: 'bar', data: { labels: [evil], values: [1] } });
  assert.ok(!html.includes('<script>alert(1)'), 'injected script must be neutralized');
  assert.match(html, /\\u003c\/script\\u003e/, 'angle brackets are unicode-escaped in the data block');
});

test('renderViz escapes U+2028 inside embedded JSON', () => {
  const sep = String.fromCharCode(0x2028);
  const html = renderViz({ kind: 'bar', data: { labels: [`a${sep}b`], values: [1] } });
  assert.ok(!html.includes(sep), 'raw line separator must not survive in the script');
  assert.match(html, /\\u2028/);
});

test('VIZ_KINDS lists the supported kinds', () => {
  assert.deepEqual(VIZ_KINDS, ['bar', 'line', 'pie', 'doughnut', 'mermaid', 'table']);
});
