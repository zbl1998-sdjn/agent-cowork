import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

test('desktop host build locks runtime postgres and postject dependencies', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  assert.equal(manifest.dependencies?.pg, '8.22.0');
  assert.equal(manifest.devDependencies?.postject, '1.0.0-alpha.6');
});

test('desktop host bundle includes pg and invokes the locked local postject CLI', () => {
  const source = fs.readFileSync(path.join(repoRoot, 'scripts', 'build-host.ts'), 'utf8');
  assert.doesNotMatch(source, /--external:pg/);
  assert.doesNotMatch(source, /npx['"],\s*['"]-y['"],\s*['"]postject/);
  assert.match(source, /node_modules.*postject.*dist.*cli\.js/s);
});
