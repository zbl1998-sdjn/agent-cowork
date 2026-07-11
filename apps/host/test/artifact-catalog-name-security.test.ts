import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { renameArtifact } from '../src/artifacts/artifact-catalog.js';
import { ensureArtifactOwnerClaim } from '../src/artifacts/artifact-owner.js';
import { tempRoot } from './helpers/host-http.js';

const ALICE = Object.freeze({ tenantId: 'tenant_shared', userId: 'alice' });

function ownedFile(root: string, name: string, content: string): string {
  const artifactPath = path.join(root, '.AgentCowork', 'artifacts', name);
  ensureArtifactOwnerClaim({ trustedRoot: root, artifactPath, owner: ALICE });
  fs.writeFileSync(artifactPath, content, 'utf8');
  return artifactPath;
}

test('catalog rename rejects Windows-equivalent and control-character names on every platform', () => {
  const invalidNames = [
    'report.md:stream',
    'CON',
    'con.txt',
    'AUX.md',
    'NUL',
    'COM1.log',
    'LPT9.csv',
    'trailing.',
    'trailing ',
    'bad\u0000.md',
    'bad\u001f.md',
    'bad?.md',
    'bad|.md',
  ];

  for (const [index, newName] of invalidNames.entries()) {
    const root = tempRoot(`kcw-art-catalog-name-${index}-`);
    const source = ownedFile(root, 'source.md', 'SOURCE');
    assert.throws(
      () => renameArtifact({
        trustedRoot: root,
        artifactPath: source,
        newName,
        context: ALICE,
      }),
      /artifact newName is invalid/,
      newName,
    );
    assert.equal(fs.readFileSync(source, 'utf8'), 'SOURCE', newName);
  }
});
