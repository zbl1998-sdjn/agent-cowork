import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { listArtifacts } from '../src/artifacts/artifact-catalog.js';
import {
  buildLiveArtifact,
  createArtifactId,
  readArtifactManifest,
  readLiveArtifactHtml,
  refreshLiveArtifactData,
  renderLivePage,
} from '../src/artifacts/live-artifact.js';
import { recordValue, tempRoot } from './helpers/host-http.js';

type SymlinkSync = (target: string, linkPath: string, type?: string) => void;

const symlinkSync = (fs as unknown as { symlinkSync: SymlinkSync }).symlinkSync;

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
  assert.match(html, /DATA_URL/);
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
  assert.match(html, /DATA_URL = "\/api\/artifacts\/data\/viz_escape"/);
  assert.match(html, /agent-cowork:live-artifact-data/);
});

test('readArtifactManifest / readLiveArtifactHtml reject bad ids and missing artifacts', () => {
  const root = tempRoot('kcw-art-');
  assert.throws(() => readArtifactManifest({ trustedRoot: root, id: '../etc' }), (error: unknown) => {
    assert.equal((error as { statusCode?: unknown }).statusCode, 400);
    return true;
  });
  assert.throws(() => readLiveArtifactHtml({ trustedRoot: root, id: createArtifactId() }), (error: unknown) => {
    assert.equal((error as { statusCode?: unknown }).statusCode, 404);
    return true;
  });
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
