import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../apps/host/src/server.js';
import { JsonlWriter } from '../apps/host/src/storage/jsonl-writer.js';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
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

async function getText(baseUrl, route) {
  const response = await fetch(`${baseUrl}${route}`);
  const body = await response.text();
  assert(response.status === 200, `${route} returned ${response.status}: ${body}`);
  return { body, contentType: response.headers.get('content-type') || '' };
}

async function main() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-ui-smoke-'));
  fs.mkdirSync(path.join(workspace, 'contracts'), { recursive: true });
  const contractPath = path.join(workspace, 'contracts', 'sample-contract.txt');
  fs.writeFileSync(contractPath, 'Contract draft. Party A, Party B, renewal date, payment terms.', 'utf8');
  fs.writeFileSync(path.join(workspace, 'meeting-notes.md'), '# Weekly\n- Prepare summary', 'utf8');

  const auditPath = path.join(workspace, '.KimiCowork', 'audit', 'ui-smoke.jsonl');
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
    const index = await getText(baseUrl, '/');
    assert(index.contentType.includes('text/html'), 'index did not return HTML');
    assert(index.body.includes('class="composer"'), 'index missing composer UI');
    assert(index.body.includes('class="approve-button"'), 'index missing approval control');
    assert(index.body.includes('Kimi Cowork'), 'index missing Kimi Cowork copy');

    const script = await getText(baseUrl, '/app.js');
    assert(script.contentType.includes('javascript'), 'app.js did not return JavaScript');
    for (const route of ['/api/workspace', '/api/files/tree', '/api/files/read', '/api/file-ops/preview', '/api/file-ops/apply']) {
      assert(script.body.includes(route), `app.js missing UI contract route ${route}`);
    }

    const workspaceInfo = await (await fetch(`${baseUrl}/api/workspace`)).json();
    assert(workspaceInfo.trustedRoot === workspace, 'workspace endpoint returned unexpected root');

    const tree = await requestJson(baseUrl, '/api/files/tree', { root: workspace });
    assert(tree.files.some((entry) => entry.path === 'contracts/sample-contract.txt'), 'UI tree flow cannot see contract file');

    const read = await requestJson(baseUrl, '/api/files/read', {
      trustedRoot: workspace,
      path: contractPath,
      maxSize: 1600,
    });
    assert(read.content.includes('renewal date'), 'UI read flow cannot read trusted file content');

    const artifactPath = path.join(workspace, '.KimiCowork', 'artifacts', 'ui-smoke-plan.md');
    const operations = [
      {
        type: 'write',
        path: artifactPath,
        content: `# UI Smoke Plan\n\nSource summary: ${read.content}\n`,
      },
    ];
    const preview = await requestJson(baseUrl, '/api/file-ops/preview', { trustedRoot: workspace, operations });
    assert(preview.operations.length === 1 && preview.operations[0].type === 'write', 'UI preview flow did not produce write preview');

    const applied = await requestJson(baseUrl, '/api/file-ops/apply', { trustedRoot: workspace, operations });
    assert(applied.applied.length === 1 && applied.applied[0].status === 'applied', 'UI apply flow did not apply write operation');
    assert(fs.readFileSync(artifactPath, 'utf8').includes('UI Smoke Plan'), 'UI apply flow did not write artifact');
    assert(fs.readFileSync(auditPath, 'utf8').includes('"action":"write"'), 'UI apply flow did not write audit event');

    console.log(
      JSON.stringify(
        {
          ok: true,
          baseUrl,
          workspace,
          artifactPath,
          auditPath,
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
