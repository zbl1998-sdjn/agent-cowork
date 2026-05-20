import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../apps/host/src/server.js';
import { JsonlWriter } from '../apps/host/src/storage/jsonl-writer.js';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertInside(child, parent, label) {
  const relative = path.relative(parent, child);
  assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative), `${label} escaped expected parent: ${child}`);
}

async function requestJson(baseUrl, route, body, expectedStatus = 200) {
  const response = await fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  assert(response.status === expectedStatus, `${route} returned ${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}

async function main() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.dirname(scriptDir);
  const buildRoot = path.join(repoRoot, 'build');
  const workspace = path.join(buildRoot, 'local-ops-smoke-workspace');

  fs.mkdirSync(buildRoot, { recursive: true });
  assertInside(workspace, buildRoot, 'smoke workspace');
  fs.rmSync(workspace, { recursive: true, force: true });

  fs.mkdirSync(path.join(workspace, 'contracts'), { recursive: true });
  fs.mkdirSync(path.join(workspace, 'notes'), { recursive: true });
  const contractPath = path.join(workspace, 'contracts', 'sample-contract.txt');
  const notePath = path.join(workspace, 'notes', 'weekly.md');
  fs.writeFileSync(contractPath, 'Contract draft. Party A, Party B, renewal date, payment terms.', 'utf8');
  fs.writeFileSync(notePath, '# Weekly meeting\n- Follow up with procurement\n- Prepare summary', 'utf8');

  const auditPath = path.join(workspace, '.KimiCowork', 'audit', 'ops.jsonl');
  const server = createServer({
    trustedRoot: workspace,
    journalWriter: new JsonlWriter(auditPath),
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const health = await (await fetch(`${baseUrl}/health`)).json();
    assert(health.ok === true && health.service === 'kimi-cowork-host', 'health check failed');

    const tree = await requestJson(baseUrl, '/api/files/tree', { root: workspace });
    assert(tree.files.some((entry) => entry.path === 'contracts/sample-contract.txt'), 'tree missing contract file');

    const read = await requestJson(baseUrl, '/api/files/read', { path: contractPath, trustedRoot: workspace });
    assert(read.content.includes('renewal date'), 'read endpoint did not return contract content');
    assert(typeof read.sha256 === 'string' && read.sha256.length === 64, 'read endpoint missing sha256');

    const bundle = await requestJson(baseUrl, '/api/context/bundle', {
      trustedRoot: workspace,
      paths: [contractPath, notePath],
      maxTextSize: 2048,
    });
    assert(bundle.files.length === 2, `context bundle expected 2 files, got ${bundle.files.length}`);

    const artifactPath = path.join(workspace, '.KimiCowork', 'artifacts', 'summary.md');
    const renamedNotePath = path.join(workspace, 'notes', 'weekly-renamed.md');
    const movedContractPath = path.join(workspace, 'Kimi_Cowork整理', '合同审核', 'sample-contract.txt');
    const operations = [
      { type: 'write', path: artifactPath, content: '# Kimi Cowork Summary\n\n- Local operation smoke passed.\n' },
      { type: 'rename', path: notePath, newName: 'weekly-renamed.md' },
      { type: 'move', from: contractPath, to: movedContractPath },
    ];

    const preview = await requestJson(baseUrl, '/api/file-ops/preview', { trustedRoot: workspace, operations });
    assert(preview.operations.length === 3, `preview expected 3 operations, got ${preview.operations.length}`);
    assert(preview.operations.map((op) => op.type).join(',') === 'write,rename,move', 'preview operation order changed');

    const applied = await requestJson(baseUrl, '/api/file-ops/apply', { trustedRoot: workspace, operations });
    assert(applied.applied.length === 3, `apply expected 3 operations, got ${applied.applied.length}`);
    assert(applied.applied.every((op) => op.status === 'applied'), 'not all operations were applied');

    assert(fs.existsSync(artifactPath), 'artifact was not written');
    assert(fs.existsSync(renamedNotePath), 'note was not renamed');
    assert(!fs.existsSync(notePath), 'old note path still exists after rename');
    assert(fs.existsSync(movedContractPath), 'contract was not moved');
    assert(!fs.existsSync(contractPath), 'old contract path still exists after move');

    const blockedTarget = path.join(workspace, '.KimiCowork', 'artifacts', 'blocked.md');
    fs.writeFileSync(blockedTarget, 'existing target', 'utf8');
    const blocked = await requestJson(
      baseUrl,
      '/api/file-ops/preview',
      {
        trustedRoot: workspace,
        operations: [{ type: 'move', from: renamedNotePath, to: blockedTarget }],
      },
      400,
    );
    assert(/target already exists/i.test(blocked.error), `expected target-exists failure, got ${blocked.error}`);
    assert(fs.existsSync(renamedNotePath), 'blocked move changed the source file');

    const audit = fs.readFileSync(auditPath, 'utf8');
    assert(audit.includes('"action":"write"'), 'audit missing write action');
    assert(audit.includes('"action":"rename"'), 'audit missing rename action');
    assert(audit.includes('"action":"move"'), 'audit missing move action');
    assert(audit.includes('"stage":"after"'), 'audit missing after-stage records');

    console.log(
      JSON.stringify(
        {
          ok: true,
          workspace,
          artifactPath,
          renamedNotePath,
          movedContractPath,
          auditPath,
          applied: applied.applied.length,
        },
        null,
        2,
      ),
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
