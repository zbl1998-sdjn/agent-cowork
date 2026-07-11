import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { authorizeCatalogArtifactFile } from '../src/artifacts/artifact-catalog-security.js';
import {
  artifactOwnerMetadata,
  ensureArtifactOwnerClaim,
} from '../src/artifacts/artifact-owner.js';
import {
  buildLiveArtifact,
  readArtifactManifest,
  readLiveArtifactHtml,
} from '../src/artifacts/live-artifact.js';
import { artifactPaths } from '../src/artifacts/live-spec.js';
import { tempRoot } from './helpers/host-http.js';

const ALICE = Object.freeze({ tenantId: 'tenant_shared', userId: 'alice' });
const BOB = Object.freeze({ tenantId: 'tenant_shared', userId: 'bob' });
const LIVE_SENTINEL = '<!-- agent-cowork-live-artifact:v1 -->';

function isNotFound(error: unknown): boolean {
  return (error as { statusCode?: unknown }).statusCode === 404;
}

function writeOwnedFile(root: string, name: string, owner: unknown, content: string): string {
  const artifactPath = path.join(root, '.AgentCowork', 'artifacts', name);
  ensureArtifactOwnerClaim({ trustedRoot: root, artifactPath, owner });
  fs.writeFileSync(artifactPath, content, 'utf8');
  return artifactPath;
}

function liveManifest(root: string, id: string, owner?: unknown): Record<string, unknown> {
  const { manifestPath } = artifactPaths({ trustedRoot: root, id });
  return {
    artifactType: 'live-artifact',
    schemaVersion: 1,
    id,
    title: id,
    dataUrl: `/api/artifacts/data/${id}`,
    createdAt: '2026-07-11T00:00:00.000Z',
    viz: { kind: 'table', data: { columns: ['value'], rows: [[id]] } },
    ...(owner === undefined ? {} : {
      owner: artifactOwnerMetadata({ trustedRoot: root, artifactPath: manifestPath, owner }),
    }),
  };
}

test('build emits the explicit live manifest contract and HTML sentinel', () => {
  const root = tempRoot('kcw-art-live-contract-');
  const built = buildLiveArtifact({
    trustedRoot: root,
    id: 'viz_contract',
    title: 'Contract',
    owner: ALICE,
    viz: { kind: 'table', data: { columns: ['value'], rows: [[1]] } },
  });
  const manifest = JSON.parse(fs.readFileSync(built.manifestPath, 'utf8')) as Record<string, unknown>;
  const html = fs.readFileSync(built.htmlPath, 'utf8');

  assert.equal(manifest.artifactType, 'live-artifact');
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(html.startsWith(`<!doctype html>\n${LIVE_SENTINEL}\n`), true);
  assert.equal(readArtifactManifest({ trustedRoot: root, id: built.id, context: ALICE }).id, built.id);
});

test('manifest-shaped business JSON without the discriminator remains ordinary JSON', () => {
  const root = tempRoot('kcw-art-live-business-');
  const artifactPath = writeOwnedFile(root, 'business.json', ALICE, JSON.stringify({
    id: 'business',
    title: 'Business data',
    dataUrl: '/business/data',
    createdAt: '2026-07-11T00:00:00.000Z',
    viz: { kind: 'table', data: { columns: ['value'], rows: [[42]] } },
    owner: { department: 'finance' },
  }));

  assert.doesNotThrow(() => authorizeCatalogArtifactFile(root, artifactPath, ALICE));
});

test('malformed explicit live manifests fail closed', () => {
  const root = tempRoot('kcw-art-live-schema-');
  const { manifestPath } = artifactPaths({ trustedRoot: root, id: 'viz_bad_schema' });
  ensureArtifactOwnerClaim({ trustedRoot: root, artifactPath: manifestPath, owner: ALICE });
  fs.writeFileSync(manifestPath, JSON.stringify({
    ...liveManifest(root, 'viz_bad_schema', ALICE),
    schemaVersion: 999,
  }), 'utf8');

  assert.throws(() => authorizeCatalogArtifactFile(root, manifestPath, ALICE), isNotFound);
});

test('ordinary HTML never reads a same-basename sibling manifest', () => {
  const root = tempRoot('kcw-art-live-ordinary-html-');
  const htmlPath = writeOwnedFile(root, 'report.html', ALICE, '<h1>ALICE_REPORT</h1>');
  const manifestPath = writeOwnedFile(
    root,
    'report.json',
    BOB,
    JSON.stringify(liveManifest(root, 'report', BOB)),
  );
  const originalRead = fs.readFileSync;
  let siblingReads = 0;
  fs.readFileSync = ((candidate: fs.PathOrFileDescriptor, ...args: unknown[]) => {
    if (String(candidate) === manifestPath) {
      siblingReads += 1;
      throw new Error('unauthorized sibling bytes were read');
    }
    return Reflect.apply(originalRead, fs, [candidate, ...args] as Parameters<typeof fs.readFileSync>);
  }) as typeof fs.readFileSync;
  try {
    assert.doesNotThrow(() => authorizeCatalogArtifactFile(root, htmlPath, ALICE));
  } finally {
    fs.readFileSync = originalRead;
  }
  assert.equal(siblingReads, 0);
});

test('sentinel HTML authorizes its sibling before reading sibling bytes', () => {
  const root = tempRoot('kcw-art-live-sentinel-html-');
  const htmlPath = writeOwnedFile(
    root,
    'report.html',
    ALICE,
    `<!doctype html>\n${LIVE_SENTINEL}\n<html></html>`,
  );
  const manifestPath = writeOwnedFile(
    root,
    'report.json',
    BOB,
    JSON.stringify(liveManifest(root, 'report', BOB)),
  );
  const originalRead = fs.readFileSync;
  let siblingReads = 0;
  fs.readFileSync = ((candidate: fs.PathOrFileDescriptor, ...args: unknown[]) => {
    if (String(candidate) === manifestPath) {
      siblingReads += 1;
      throw new Error('unauthorized sibling bytes were read');
    }
    return Reflect.apply(originalRead, fs, [candidate, ...args] as Parameters<typeof fs.readFileSync>);
  }) as typeof fs.readFileSync;
  try {
    assert.throws(() => authorizeCatalogArtifactFile(root, htmlPath, ALICE), isNotFound);
  } finally {
    fs.readFileSync = originalRead;
  }
  assert.equal(siblingReads, 0);
});

test('live readers reject HTML-only, manifest-only, and missing-sentinel pairs', () => {
  const htmlOnlyRoot = tempRoot('kcw-art-live-html-only-');
  const htmlOnly = artifactPaths({ trustedRoot: htmlOnlyRoot, id: 'viz_html_only' });
  fs.mkdirSync(htmlOnly.dir, { recursive: true });
  fs.writeFileSync(htmlOnly.htmlPath, `<!doctype html>\n${LIVE_SENTINEL}\n<html></html>`, 'utf8');
  assert.throws(
    () => readLiveArtifactHtml({ trustedRoot: htmlOnlyRoot, id: 'viz_html_only' }),
    isNotFound,
  );

  const manifestOnlyRoot = tempRoot('kcw-art-live-manifest-only-');
  const manifestOnly = artifactPaths({ trustedRoot: manifestOnlyRoot, id: 'viz_manifest_only' });
  fs.mkdirSync(manifestOnly.dir, { recursive: true });
  fs.writeFileSync(
    manifestOnly.manifestPath,
    JSON.stringify(liveManifest(manifestOnlyRoot, 'viz_manifest_only')),
    'utf8',
  );
  assert.throws(
    () => readArtifactManifest({ trustedRoot: manifestOnlyRoot, id: 'viz_manifest_only' }),
    isNotFound,
  );

  const noSentinelRoot = tempRoot('kcw-art-live-no-sentinel-');
  const noSentinel = artifactPaths({ trustedRoot: noSentinelRoot, id: 'viz_no_sentinel' });
  fs.mkdirSync(noSentinel.dir, { recursive: true });
  fs.writeFileSync(noSentinel.htmlPath, '<!doctype html>\n<html></html>', 'utf8');
  fs.writeFileSync(
    noSentinel.manifestPath,
    JSON.stringify(liveManifest(noSentinelRoot, 'viz_no_sentinel')),
    'utf8',
  );
  assert.throws(
    () => readArtifactManifest({ trustedRoot: noSentinelRoot, id: 'viz_no_sentinel' }),
    isNotFound,
  );
  assert.throws(
    () => readLiveArtifactHtml({ trustedRoot: noSentinelRoot, id: 'viz_no_sentinel' }),
    isNotFound,
  );
});
