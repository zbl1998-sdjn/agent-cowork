import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { buildLiveArtifact } from '../src/artifacts/live-artifact.js';
import {
  createArtifactFileOperationGuards,
  createArtifactRollbackGuards,
} from '../src/artifacts/artifact-owner-write.js';
import { renameArtifact } from '../src/artifacts/artifact-catalog.js';
import { LIVE_ARTIFACT_HTML_SENTINEL } from '../src/artifacts/live-artifact-contract.js';
import { createAgentTools } from '../src/engine/agent-tools.js';
import { previewFileOperations } from '../src/workspace/file-operations.js';
import { rollbackFileOperations } from '../src/workspace/file-rollback.js';
import { tempRoot } from './helpers/host-http.js';

const ALICE = Object.freeze({ tenantId: 'tenant_shared', userId: 'alice' });
const VIZ = Object.freeze({ kind: 'table', data: { columns: ['value'], rows: [[1]] } });

function immutable(error: unknown): boolean {
  return (error as { statusCode?: unknown }).statusCode === 409
    && /immutable|new version|live artifact pair/i.test(String((error as Error).message));
}

test('generic file operations cannot overwrite or forge live-artifact version components', () => {
  const root = tempRoot('kcw-art-version-generic-write-');
  const parent = buildLiveArtifact({ trustedRoot: root, id: 'viz_immutable_v1', owner: ALICE, viz: VIZ });
  const guards = createArtifactFileOperationGuards(root, ALICE);

  assert.throws(() => previewFileOperations([{
    type: 'write',
    path: parent.htmlPath,
    content: '<p>replacement</p>',
    overwrite: true,
  }], { trustedRoot: root, ...guards }), immutable);

  const forgedManifest = path.join(root, '.AgentCowork', 'artifacts', 'viz_forged_v2.json');
  assert.throws(() => previewFileOperations([{
    type: 'write',
    path: forgedManifest,
    content: JSON.stringify({ artifactType: 'live-artifact', lineageId: parent.id }),
  }], { trustedRoot: root, ...guards }), immutable);

  const forgedHtml = path.join(root, '.AgentCowork', 'artifacts', 'viz_forged_v2.html');
  assert.throws(() => previewFileOperations([{
    type: 'write',
    path: forgedHtml,
    content: `${LIVE_ARTIFACT_HTML_SENTINEL}<p>forged</p>`,
  }], { trustedRoot: root, ...guards }), immutable);
});

test('catalog rename and rollback cannot mutate an immutable live-artifact pair', () => {
  const root = tempRoot('kcw-art-version-rename-rollback-');
  const parent = buildLiveArtifact({ trustedRoot: root, id: 'viz_rename_v1', owner: ALICE, viz: VIZ });
  const htmlBefore = fs.readFileSync(parent.htmlPath, 'utf8');

  assert.throws(() => renameArtifact({
    trustedRoot: root,
    artifactPath: parent.htmlPath,
    newName: 'viz_renamed.html',
    context: ALICE,
  }), immutable);
  assert.throws(() => rollbackFileOperations([{
    type: 'delete-created-file',
    path: parent.htmlPath,
  }], { trustedRoot: root, ...createArtifactRollbackGuards(root, ALICE) }), immutable);

  assert.equal(fs.readFileSync(parent.htmlPath, 'utf8'), htmlBefore);
});

test('native Write and Edit tools cannot modify immutable live-artifact versions', async () => {
  const root = tempRoot('kcw-art-version-native-tools-');
  const parent = buildLiveArtifact({ trustedRoot: root, id: 'viz_native_v1', owner: ALICE, viz: VIZ });
  const htmlBefore = fs.readFileSync(parent.htmlPath, 'utf8');
  const tools = createAgentTools({ trustedRoot: root, context: ALICE });
  const writeHandler = tools.find((tool) => tool.name === 'Write')?.handler;
  const editHandler = tools.find((tool) => tool.name === 'Edit')?.handler;
  if (!writeHandler || !editHandler) throw new Error('expected native Write and Edit tool handlers');

  await assert.rejects(() => writeHandler({ path: parent.htmlPath, content: 'replacement' }), immutable);
  await assert.rejects(() => editHandler({
    path: parent.htmlPath,
    old_string: LIVE_ARTIFACT_HTML_SENTINEL,
    new_string: '<!-- changed -->',
  }), immutable);
  assert.equal(fs.readFileSync(parent.htmlPath, 'utf8'), htmlBefore);
});
