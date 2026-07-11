import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { authorizeCatalogArtifactFile } from '../src/artifacts/artifact-catalog-security.js';
import { renameArtifact } from '../src/artifacts/artifact-catalog.js';
import {
  artifactOwnerClaimPath,
  ensureArtifactOwnerClaim,
} from '../src/artifacts/artifact-owner.js';
import { buildLiveArtifact } from '../src/artifacts/live-artifact.js';
import { createServer } from '../src/server.js';
import { bind, close, jsonRequest, tempRoot } from './helpers/host-http.js';

const ALICE = Object.freeze({ tenantId: 'tenant_shared', userId: 'alice' });

function aggregateIncludes(error: unknown, patterns: RegExp[]): boolean {
  if (!(error instanceof AggregateError)) return false;
  const messages = error.errors.map((item) => String(item));
  return patterns.every((pattern) => messages.some((message) => pattern.test(message)));
}

test('catalog rename reports a still-present corrupt source claim after cleanup failure', () => {
  const root = tempRoot('kcw-art-catalog-corrupt-claim-');
  const artifactRoot = path.join(root, '.AgentCowork', 'artifacts');
  const source = path.join(artifactRoot, 'source.md');
  const target = path.join(artifactRoot, 'target.md');
  ensureArtifactOwnerClaim({ trustedRoot: root, artifactPath: source, owner: ALICE });
  fs.writeFileSync(source, 'SOURCE', 'utf8');
  const sourceClaim = artifactOwnerClaimPath({ trustedRoot: root, artifactPath: source });
  const originalUnlink = fs.unlinkSync;

  fs.unlinkSync = ((candidate: fs.PathLike) => {
    if (String(candidate) === sourceClaim) {
      fs.writeFileSync(sourceClaim, '{"broken":true}\n', 'utf8');
      throw new Error('injected source claim cleanup failure');
    }
    return originalUnlink(candidate);
  }) as typeof fs.unlinkSync;
  try {
    assert.throws(
      () => renameArtifact({
        trustedRoot: root,
        artifactPath: source,
        newName: path.basename(target),
        context: ALICE,
      }),
      (error: unknown) => aggregateIncludes(error, [
        /injected source claim cleanup failure/,
        /artifact not found/,
      ]),
    );
  } finally {
    fs.unlinkSync = originalUnlink;
  }

  assert.equal(fs.existsSync(source), false);
  assert.equal(fs.existsSync(sourceClaim), true);
  assert.doesNotThrow(() => authorizeCatalogArtifactFile(root, target, ALICE));
});

test('artifact rename route rejects either half of a live HTML and manifest pair', async () => {
  const root = tempRoot('kcw-art-catalog-live-pair-');
  const built = buildLiveArtifact({
    trustedRoot: root,
    id: 'viz_live_pair_rename',
    title: 'Live pair',
    viz: { kind: 'table', data: { columns: ['value'], rows: [['safe']] } },
  });
  const html = fs.readFileSync(built.htmlPath, 'utf8');
  const manifest = fs.readFileSync(built.manifestPath, 'utf8');
  const server = createServer({ trustedRoot: root, enableScheduler: false });
  const base = await bind(server);
  try {
    for (const [artifactPath, newName, key] of [
      [built.htmlPath, 'renamed.html', 'rename-live-html'],
      [built.manifestPath, 'renamed.json', 'rename-live-manifest'],
    ] as const) {
      const response = await jsonRequest(base, '/api/artifacts/rename', {
        method: 'POST',
        headers: { 'idempotency-key': key },
        body: { trustedRoot: root, path: artifactPath, newName },
      });
      assert.equal(response.status, 409, JSON.stringify(response.body));
      assert.match(String(response.body.error), /live artifact pair/i);
    }
  } finally {
    await close(server);
  }

  assert.equal(fs.readFileSync(built.htmlPath, 'utf8'), html);
  assert.equal(fs.readFileSync(built.manifestPath, 'utf8'), manifest);
  assert.equal(fs.existsSync(path.join(path.dirname(built.htmlPath), 'renamed.html')), false);
  assert.equal(fs.existsSync(path.join(path.dirname(built.manifestPath), 'renamed.json')), false);
});
