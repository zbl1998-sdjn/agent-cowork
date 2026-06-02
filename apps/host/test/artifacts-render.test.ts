import assert from 'node:assert/strict';
import test from 'node:test';
import { renderViz, VIZ_KINDS } from '../src/artifacts/viz.js';

test('renderViz bar chart embeds Chart.js, the config, and the title', () => {
  const html = renderViz({
    title: '季度收入',
    kind: 'bar',
    data: { labels: ['Q1', 'Q2'], values: [10, 20] },
  });
  assert.match(html, /<!doctype html>/);
  assert.match(html, /cdnjs\.cloudflare\.com\/ajax\/libs\/Chart\.js/);
  assert.match(html, /new window\.Chart/);
  assert.match(html, /"labels":\["Q1","Q2"\]/);
  assert.match(html, /季度收入/);
});

test('renderViz supports line / pie / doughnut kinds', () => {
  for (const kind of ['line', 'pie', 'doughnut']) {
    const html = renderViz({ kind, data: { labels: ['a'], values: [1] } });
    assert.match(html, new RegExp(`"type":"${kind}"`));
  }
});

test('renderViz mermaid embeds the definition and Mermaid lib', () => {
  const html = renderViz({ title: '流程', kind: 'mermaid', data: { definition: 'graph TD; A-->B' } });
  assert.match(html, /class="mermaid"/);
  assert.match(html, /graph TD; A--&gt;B/);
  assert.match(html, /cdnjs\.cloudflare\.com\/ajax\/libs\/mermaid/);
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
