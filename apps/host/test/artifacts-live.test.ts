import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { listArtifacts } from '../src/artifacts/artifact-catalog.js';
import {
  buildLiveArtifact,
  createArtifactId,
  readArtifactManifest,
  readLiveArtifactHtml,
  refreshLiveArtifactData,
  refreshLiveArtifactDataAsync,
  renderLivePage,
} from '../src/artifacts/live-artifact.js';
import type { ToolRegistryLike } from '../src/artifacts/live-refresh.js';
import { recordValue, tempRoot } from './helpers/host-http.js';

type SymlinkSync = (target: string, linkPath: string, type?: string) => void;

const symlinkSync = (fs as unknown as { symlinkSync: SymlinkSync }).symlinkSync;

function assertHttpError(error: unknown, statusCode: number, message: RegExp): true {
  assert.equal((error as { statusCode?: unknown }).statusCode, statusCode);
  assert.match(error instanceof Error ? error.message : String(error), message);
  return true;
}

// CSP 说明(dogfood 全面审查修复,2026-07-08):活页 HTML 会被塞进桌面应用 sandbox="allow-scripts"
// 的 <iframe srcDoc> 内,浏览器把壳的 CSP(script-src 'self',无 unsafe-inline)继承给 srcdoc
// 子文档且无法被子文档自身 <meta CSP> 放宽(已用 Playwright 实测确认)。因此改成本地打包的
// /vendor/*.js 外部脚本 + <script type="application/json"> 承载数据,不再有内联 <script>
// 或 CDN 引用。见 apps/host/src/artifacts/{viz.ts,live-render.ts} 顶部注释。
const appsRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const VENDOR_DIR = path.join(appsRoot, 'windows-client', 'ui', 'public', 'vendor');

test('buildLiveArtifact writes a live page + manifest with a Refresh hook', () => {
  const root = tempRoot('kcw-art-');
  const out = buildLiveArtifact({
    trustedRoot: root,
    title: '收入',
    viz: { kind: 'bar', data: { labels: ['Q1'], values: [9] } },
  });
  assert.match(out.id, /^viz_/);
  assert.equal(out.relativePath, `.AgentCowork/artifacts/${out.id}.html`);
  const html = fs.readFileSync(out.htmlPath, 'utf8');
  assert.match(html, /id="refresh"/);
  assert.match(html, /<script type="application\/json" id="live-artifact-init">/);
  assert.match(html, new RegExp(`"dataUrl":"/api/artifacts/data/${out.id}"`));
  assert.match(html, /"labels":\["Q1"\]/);
  const manifest = readArtifactManifest({ trustedRoot: root, id: out.id });
  assert.equal(manifest.viz.kind, 'bar');
  assert.equal(recordValue(manifest, 'artifact manifest').dataUrl, `/api/artifacts/data/${out.id}`);
});

test('renderLivePage escapes title and script-sensitive data while preserving refresh wiring', () => {
  const html = renderLivePage({
    title: '<script>alert(1)</script>',
    viz: { kind: 'table', data: { columns: ['name'], rows: [['</script><img src=x>']] } },
    dataUrl: '/api/artifacts/data/viz_escape',
  });
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<h1><script>/);
  assert.doesNotMatch(html, /<\/script><img/);
  assert.match(html, /"dataUrl":"\/api\/artifacts\/data\/viz_escape"/);
  assert.match(html, /<script src="\/vendor\/viz-bootstrap-live\.js"><\/script>/);
  assert.equal(/<script>[\s\S]*<\/script>/.test(html), false, '不得内联可执行 <script>(CSP script-src \'self\' 会拦截)');
});

test('renderLivePage air_gap: no vendor chart/mermaid script tag, always loads the shared runtime (dogfood security fix)', () => {
  const html = renderLivePage({
    title: '收入',
    viz: { kind: 'bar', data: { labels: ['Q1'], values: [10] } },
    dataUrl: '/api/artifacts/data/viz_airgap',
    securityMode: 'air_gap',
  });
  assert.equal(html.includes('cdnjs.cloudflare.com'), false, 'air_gap live page must not reference any CDN');
  assert.equal(html.includes('/vendor/chart.umd.min.js'), false, 'air_gap must not load the Chart.js vendor script');
  assert.match(html, /机密模式\(零出网\)/, 'must surface a visible notice, not a silently degraded page');
  // 客户端渲染器(viz-client-runtime.js)仍需加载:它的 no-Chart 分支在运行时把图表退化成表格。
  assert.match(html, /<script src="\/vendor\/viz-client-runtime\.js"><\/script>/);
});

test('renderLivePage non-air_gap keeps the local vendor script tag (no regression for the default path)', () => {
  const html = renderLivePage({
    title: '收入',
    viz: { kind: 'bar', data: { labels: ['Q1'], values: [10] } },
    dataUrl: '/api/artifacts/data/viz_default',
  });
  assert.match(html, /<script src="\/vendor\/chart\.umd\.min\.js"><\/script>/);
});

test('vendor viz runtime assets referenced by viz.ts/live-render.ts exist and carry the expected client-side wiring', () => {
  const files = [
    'chart.umd.min.js',
    'mermaid.min.js',
    'viz-client-runtime.js',
    'viz-bootstrap-static.js',
    'viz-bootstrap-live.js',
  ];
  for (const name of files) {
    const full = path.join(VENDOR_DIR, name);
    assert.ok(fs.existsSync(full), `missing vendor asset: ${name}`);
    assert.ok(fs.statSync(full).size > 0, `vendor asset is empty: ${name}`);
  }
  const runtime = fs.readFileSync(path.join(VENDOR_DIR, 'viz-client-runtime.js'), 'utf8');
  assert.match(runtime, /图表脚本未加载/, 'client runtime must keep the no-Chart degrade-to-table branch');
  const bootstrapLive = fs.readFileSync(path.join(VENDOR_DIR, 'viz-bootstrap-live.js'), 'utf8');
  assert.match(bootstrapLive, /agent-cowork:live-artifact-data/, 'live bootstrap must keep the postMessage refresh listener');
});

test('readArtifactManifest / readLiveArtifactHtml reject bad ids and missing artifacts', () => {
  const root = tempRoot('kcw-art-');
  assert.throws(() => readArtifactManifest({ trustedRoot: root, id: '../etc' }), (error: unknown) => {
    return assertHttpError(error, 400, /invalid artifact id/);
  });
  assert.throws(() => readLiveArtifactHtml({ trustedRoot: root, id: createArtifactId() }), (error: unknown) => {
    return assertHttpError(error, 404, /artifact not found/);
  });
});

test('readArtifactManifest and readLiveArtifactHtml distinguish missing manifest from existing live html', () => {
  const root = tempRoot('kcw-art-');
  assert.throws(() => readArtifactManifest({ trustedRoot: root, id: createArtifactId() }), (error: unknown) => {
    return assertHttpError(error, 404, /artifact not found/);
  });

  const out = buildLiveArtifact({
    trustedRoot: root,
    title: '已生成活页',
    viz: { kind: 'table', data: { columns: ['name'], rows: [['visible']] } },
  });

  assert.equal(readLiveArtifactHtml({ trustedRoot: root, id: out.id }), fs.readFileSync(out.htmlPath, 'utf8'));
});

test('refreshLiveArtifactData reads a workspace file-json data source on demand', () => {
  const root = tempRoot('kcw-art-');
  const sourceRel = 'data/live-viz.json';
  const sourcePath = path.join(root, sourceRel);
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.writeFileSync(sourcePath, JSON.stringify({ viz: { kind: 'table', data: { columns: ['name'], rows: [['before']] } } }), 'utf8');
  const out = buildLiveArtifact({
    trustedRoot: root,
    title: '动态表',
    viz: { kind: 'table', data: { columns: ['name'], rows: [['initial']] } },
    dataSource: { type: 'file-json', path: sourceRel },
  });

  fs.writeFileSync(sourcePath, JSON.stringify({ viz: { kind: 'table', data: { columns: ['name'], rows: [['after']] } } }), 'utf8');
  const data = refreshLiveArtifactData({ trustedRoot: root, id: out.id, now: new Date('2026-01-02T03:04:05.000Z') });
  assert.equal(data.refreshedAt, '2026-01-02T03:04:05.000Z');
  const dataSource = recordValue(data.dataSource, 'refreshed data source');
  assert.equal(dataSource.type, 'file-json');
  const vizData = recordValue(data.viz.data, 'refreshed viz data');
  assert.deepEqual(vizData.rows, [['after']]);
});

test('refreshLiveArtifactData returns manifest viz when no data source is configured', () => {
  const root = tempRoot('kcw-art-');
  const out = buildLiveArtifact({
    trustedRoot: root,
    title: '静态表',
    viz: { kind: 'table', data: { columns: ['name'], rows: [['initial']] } },
  });

  const data = refreshLiveArtifactData({ trustedRoot: root, id: out.id, now: new Date('2026-02-03T04:05:06.000Z') });

  assert.equal(data.id, out.id);
  assert.equal(data.refreshedAt, '2026-02-03T04:05:06.000Z');
  assert.equal(data.dataSource, undefined);
  const vizData = recordValue(data.viz.data, 'manifest viz data');
  assert.deepEqual(vizData.rows, [['initial']]);
});

test('refreshLiveArtifactData reports file-json source regressions with specific status codes', () => {
  const root = tempRoot('kcw-art-');
  const sourceRel = 'data/live-viz.json';
  const out = buildLiveArtifact({
    trustedRoot: root,
    title: '动态表',
    viz: { kind: 'table', data: { columns: ['name'], rows: [['initial']] } },
    dataSource: { type: 'file-json', path: sourceRel },
  });

  assert.throws(() => refreshLiveArtifactData({ trustedRoot: root, id: out.id }), (error: unknown) => {
    return assertHttpError(error, 404, /artifact data source not found/);
  });

  const sourcePath = path.join(root, sourceRel);
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.writeFileSync(sourcePath, '{not json', 'utf8');
  assert.throws(() => refreshLiveArtifactData({ trustedRoot: root, id: out.id }), (error: unknown) => {
    return assertHttpError(error, 400, /not valid JSON/);
  });

  fs.writeFileSync(sourcePath, JSON.stringify(['not', 'an', 'object']), 'utf8');
  assert.throws(() => refreshLiveArtifactData({ trustedRoot: root, id: out.id }), (error: unknown) => {
    return assertHttpError(error, 400, /must contain a viz object/);
  });

  fs.writeFileSync(sourcePath, JSON.stringify({ kind: 'table', data: { columns: ['name'], rows: [['direct']] } }), 'utf8');
  const data = refreshLiveArtifactData({ trustedRoot: root, id: out.id });
  const vizData = recordValue(data.viz.data, 'direct source viz data');
  assert.deepEqual(vizData.rows, [['direct']]);
});

test('refreshLiveArtifactData requires async refresh for connector-tool data sources', () => {
  const root = tempRoot('kcw-art-');
  const out = buildLiveArtifact({
    trustedRoot: root,
    title: '连接器表',
    viz: { kind: 'table', data: { columns: ['name'], rows: [['initial']] } },
    dataSource: { type: 'connector-tool', tool: 'mcp__demo__read_report', args: { report: 'daily' } },
  });

  assert.throws(() => refreshLiveArtifactData({ trustedRoot: root, id: out.id }), (error: unknown) => {
    return assertHttpError(error, 503, /requires async refresh/);
  });
});

test('refreshLiveArtifactDataAsync calls an allowed connector data source with trusted context', async () => {
  const root = tempRoot('kcw-art-');
  const out = buildLiveArtifact({
    trustedRoot: root,
    title: '连接器表',
    viz: { kind: 'table', data: { columns: ['name'], rows: [['initial']] } },
    dataSource: { type: 'connector-tool', tool: 'mcp__demo__read_report', args: { report: 'daily' } },
  });
  const calls: Array<{ name: string; args: Record<string, unknown>; ctx: unknown }> = [];
  const toolRegistry: ToolRegistryLike = {
    descriptor(name) {
      assert.equal(name, 'mcp__demo__read_report');
      return { source: 'mcp:demo', name, risk: 'low', mutating: false, requiresApproval: false };
    },
    call(name, args, ctx) {
      calls.push({ name, args, ctx });
      return {
        viz: { kind: 'table', data: { columns: ['name'], rows: [['from tool']] } },
      };
    },
  };

  const data = await refreshLiveArtifactDataAsync({
    trustedRoot: root,
    id: out.id,
    now: new Date('2026-03-04T05:06:07.000Z'),
    toolRegistry,
    context: { requestId: 'req-1' },
  });

  assert.equal(data.refreshedAt, '2026-03-04T05:06:07.000Z');
  assert.deepEqual(calls, [{
    name: 'mcp__demo__read_report',
    args: { report: 'daily' },
    ctx: { trustedRoot: root, context: { requestId: 'req-1' } },
  }]);
  const vizData = recordValue(data.viz.data, 'connector viz data');
  assert.deepEqual(vizData.rows, [['from tool']]);
});

test('refreshLiveArtifactDataAsync allows only read-only connector tools as live data sources', async () => {
  const root = tempRoot('kcw-art-');
  const out = buildLiveArtifact({
    trustedRoot: root,
    title: '连接器表',
    viz: { kind: 'table', data: { columns: ['name'], rows: [['initial']] } },
    dataSource: { type: 'connector-tool', tool: 'mcp__demo__read_report', args: {} },
  });
  const makeRegistry = (descriptor: ReturnType<ToolRegistryLike['descriptor']>): ToolRegistryLike => ({
    descriptor: () => descriptor,
    call: () => ({
      viz: { kind: 'table', data: { columns: ['name'], rows: [['from tool']] } },
    }),
  });

  await assert.rejects(
    () => refreshLiveArtifactDataAsync({ trustedRoot: root, id: out.id }),
    (error: unknown) => assertHttpError(error, 503, /connector data source is unavailable/),
  );
  await assert.rejects(
    () => refreshLiveArtifactDataAsync({ trustedRoot: root, id: out.id, toolRegistry: makeRegistry(null) }),
    (error: unknown) => assertHttpError(error, 409, /connector tool is not connected/),
  );
  for (const descriptor of [
    { source: 'mcp:demo', name: 'mcp__demo__read_report', risk: 'high' },
    { source: 'mcp:demo', name: 'mcp__demo__read_report', mutating: true },
    { source: 'mcp:demo', name: 'mcp__demo__read_report', requiresApproval: true },
  ]) {
    await assert.rejects(
      () => refreshLiveArtifactDataAsync({ trustedRoot: root, id: out.id, toolRegistry: makeRegistry(descriptor) }),
      (error: unknown) => assertHttpError(error, 403, /not allowed as a live data source/),
    );
  }

  const fsRegistry = makeRegistry({ source: 'mcp:fs', name: 'mcp__fs__read_text', risk: 'critical', mutating: true, requiresApproval: true });
  fsRegistry.call = () => ({
    content: [{ type: 'text', text: JSON.stringify({ viz: { kind: 'table', data: { columns: ['name'], rows: [['fs text']] } } }) }],
  });
  const data = await refreshLiveArtifactDataAsync({ trustedRoot: root, id: out.id, toolRegistry: fsRegistry });
  const vizData = recordValue(data.viz.data, 'fs connector viz data');
  assert.deepEqual(vizData.rows, [['fs text']]);
});

test('refreshLiveArtifactDataAsync rejects malformed connector payloads before rendering', async () => {
  const root = tempRoot('kcw-art-');
  const out = buildLiveArtifact({
    trustedRoot: root,
    title: '连接器表',
    viz: { kind: 'table', data: { columns: ['name'], rows: [['initial']] } },
    dataSource: { type: 'connector-tool', tool: 'mcp__demo__read_report', args: {} },
  });
  const makeRegistry = (result: unknown): ToolRegistryLike => ({
    descriptor: () => ({ source: 'mcp:demo', name: 'mcp__demo__read_report', risk: 'low' }),
    call: () => result,
  });

  await assert.rejects(
    () => refreshLiveArtifactDataAsync({ trustedRoot: root, id: out.id, toolRegistry: makeRegistry({ content: [{ type: 'image', text: '{}' }] }) }),
    (error: unknown) => assertHttpError(error, 400, /must return text JSON/),
  );
  await assert.rejects(
    () => refreshLiveArtifactDataAsync({ trustedRoot: root, id: out.id, toolRegistry: makeRegistry({ content: [{ type: 'text', text: '{bad' }] }) }),
    (error: unknown) => assertHttpError(error, 400, /text is not valid JSON/),
  );
  await assert.rejects(
    () => refreshLiveArtifactDataAsync({ trustedRoot: root, id: out.id, toolRegistry: makeRegistry('plain text') }),
    (error: unknown) => assertHttpError(error, 400, /must return a JSON object/),
  );
  await assert.rejects(
    () => refreshLiveArtifactDataAsync({ trustedRoot: root, id: out.id, toolRegistry: makeRegistry({ viz: [] }) }),
    (error: unknown) => assertHttpError(error, 400, /unknown viz kind|must contain a viz object/),
  );
});

test('buildLiveArtifact rejects file-json data sources outside trustedRoot', () => {
  const root = tempRoot('kcw-art-');
  assert.throws(
    () => buildLiveArtifact({
      trustedRoot: root,
      title: '越界',
      viz: { kind: 'table', data: { columns: ['a'], rows: [['1']] } },
      dataSource: { type: 'file-json', path: '../outside.json' },
    }),
    /Path escaped trusted root/,
  );
});

test('listArtifacts rejects a symlinked artifact root outside trustedRoot', () => {
  const root = tempRoot('kcw-art-');
  const outside = tempRoot('kcw-art-');
  fs.writeFileSync(path.join(outside, 'leak.md'), 'outside', 'utf8');
  fs.mkdirSync(path.join(root, '.AgentCowork'), { recursive: true });
  symlinkSync(outside, path.join(root, '.AgentCowork', 'artifacts'), process.platform === 'win32' ? 'junction' : 'dir');

  assert.throws(
    () => listArtifacts({ trustedRoot: root }),
    /Path escaped trusted root/,
  );
});

test('listArtifacts labels Office artifact kinds explicitly', () => {
  const root = tempRoot('kcw-art-');
  const dir = path.join(root, '.AgentCowork', 'artifacts');
  fs.mkdirSync(dir, { recursive: true });
  for (const name of ['report.docx', 'data.xlsx', 'slides.pptx', 'memo.pdf']) {
    fs.writeFileSync(path.join(dir, name), 'x');
  }

  const byName = Object.fromEntries(listArtifacts({ trustedRoot: root, limit: 10 }).map((item) => [item.name, item.kind]));

  assert.equal(byName['report.docx'], 'word');
  assert.equal(byName['data.xlsx'], 'spreadsheet');
  assert.equal(byName['slides.pptx'], 'presentation');
  assert.equal(byName['memo.pdf'], 'pdf');
});
