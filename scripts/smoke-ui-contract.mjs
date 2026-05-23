import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../apps/host/src/server.js';
import { JsonlWriter } from '../apps/host/src/storage/jsonl-writer.js';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const buildDir = path.join(repoRoot, 'build');

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function requestJson(baseUrl, route, body, expectedStatus = 200) {
  const headers = { 'content-type': 'application/json' };
  if (body?.idempotencyKey) {
    headers['idempotency-key'] = body.idempotencyKey;
  }
  const response = await fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers,
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

function scriptRoutesFromHtml(html) {
  return [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*>/gi)]
    .map((match) => `/${match[1].replace(/^\.\//, '')}`);
}

async function main() {
  fs.mkdirSync(buildDir, { recursive: true });
  const workspace = fs.mkdtempSync(path.join(buildDir, 'kcw-ui-smoke-'));
  fs.mkdirSync(path.join(workspace, 'contracts'), { recursive: true });
  const contractPath = path.join(workspace, 'contracts', 'sample-contract.txt');
  fs.writeFileSync(contractPath, 'Contract draft. Party A, Party B, renewal date, payment terms.', 'utf8');
  fs.writeFileSync(path.join(workspace, 'meeting-notes.md'), '# Weekly\n- Prepare summary', 'utf8');

  const auditPath = path.join(workspace, '.AgentCowork', 'audit', 'ui-smoke.jsonl');
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
    assert(index.body.includes('class="mode-switch"'), 'index missing 对话/协作/代码 mode switch');
    assert(index.body.includes('class="composer"'), 'index missing composer UI');
    assert(index.body.includes('class="conversation-timeline"'), 'index missing conversation timeline');
    assert(index.body.includes('class="approve-button"'), 'index missing approval control');
    assert(index.body.includes('data-artifact-list'), 'index missing artifact catalog container');
    assert(index.body.includes('data-action="refresh-artifacts"'), 'index missing artifact refresh control');
    assert(index.body.includes('Agent Cowork'), 'index missing Agent Cowork copy');
    for (const copy of ['对话', '协作', '代码', '新建会话', '项目', '产物', '自定义', '最近']) {
      assert(index.body.includes(copy), `index missing Image #1 functional copy: ${copy}`);
    }
    assert(!index.body.includes('Claude'), 'index must remain Kimi-only and not include Claude branding');

    const styles = await getText(baseUrl, '/app.css');
    assert(styles.contentType.includes('css'), 'app.css did not return CSS');
    assert(styles.body.includes('.app-shell > *'), 'app.css missing fixed-window shrink guard');
    assert(styles.body.includes('overflow: hidden'), 'app.css missing fixed-window overflow guard');
    assert(styles.body.includes('.mode-switch'), 'app.css missing mode switch styling');
    assert(styles.body.includes('[hidden]'), 'app.css missing hidden panel guard');

    const script = await getText(baseUrl, '/app.js');
    assert(script.contentType.includes('javascript'), 'app.js did not return JavaScript');
    const scriptRoutes = scriptRoutesFromHtml(index.body);
    assert(scriptRoutes.includes('/app-utils.js'), 'index missing app-utils.js script');
    assert(scriptRoutes.includes('/app-api-client.js'), 'index missing app-api-client.js script');
    assert(scriptRoutes.includes('/app-run-events.js'), 'index missing app-run-events.js script');
    assert(scriptRoutes.includes('/app-composer-popover.js'), 'index missing app-composer-popover.js script');
    assert(scriptRoutes.includes('/app.js'), 'index missing app.js script');
    assert(scriptRoutes.indexOf('/app-utils.js') < scriptRoutes.indexOf('/app.js'), 'app-utils.js must load before app.js');
    assert(scriptRoutes.indexOf('/app-api-client.js') < scriptRoutes.indexOf('/app.js'), 'app-api-client.js must load before app.js');
    assert(scriptRoutes.indexOf('/app-run-events.js') < scriptRoutes.indexOf('/app.js'), 'app-run-events.js must load before app.js');
    assert(scriptRoutes.indexOf('/app-composer-popover.js') < scriptRoutes.indexOf('/app.js'), 'app-composer-popover.js must load before app.js');
    const scriptBodies = [];
    for (const route of scriptRoutes) {
      const asset = await getText(baseUrl, route);
      assert(asset.contentType.includes('javascript'), `${route} did not return JavaScript`);
      scriptBodies.push(asset.body);
    }
    const allScripts = scriptBodies.join('\n');
    assert(allScripts.includes('window.AgentCoworkUtils'), 'utility module global missing');
    assert(allScripts.includes('window.AgentCoworkApi'), 'API client module global missing');
    assert(allScripts.includes('window.AgentCoworkRunEvents'), 'run-events module global missing');
    assert(allScripts.includes('window.AgentCoworkComposerPopover'), 'composer popover module global missing');
    assert(allScripts.includes('createComposerPopover'), 'composer popover factory missing');
    assert(allScripts.includes('function setView'), 'app scripts missing view switching controller');
    assert(allScripts.includes('function appendAssistantMessage'), 'app scripts missing message bubble controller');
    assert(allScripts.includes('function handleComposerSend'), 'app scripts missing composer send router');
    assert(allScripts.includes('[data-quick]'), 'app scripts missing quick action handlers');
    assert(allScripts.includes('function subscribeRunEvents'), 'app scripts missing SSE run-event subscriber');
    assert(allScripts.includes('new EventSource('), 'app scripts missing EventSource client');
    assert(allScripts.includes('/events`'), 'app scripts missing SSE /events route usage');
    assert(allScripts.includes('function handleComposerInput'), 'app scripts missing composer popover input handler');
    assert(allScripts.includes('detectComposerTrigger'), 'app scripts missing slash/at trigger detection');
    assert(allScripts.includes('historyRunItems'), 'app scripts missing # history run picker');
    assert(allScripts.includes('/api/runs/index'), 'app scripts missing runs-index picker route');
    assert(allScripts.includes('mode: "history"'), 'app scripts missing # history trigger detection');
    assert(allScripts.includes('replayRunEvents'), 'app scripts missing history run event replay');
    assert(allScripts.includes('/api/artifacts'), 'app scripts missing artifact catalog route');
    assert(allScripts.includes('/api/artifacts/view'), 'app scripts missing artifact live page route');
    assert(index.body.includes('class="composer-popover"'), 'index missing composer popover container');
    for (const route of [
      '/api/workspace',
      '/api/files/tree',
      '/api/files/read',
      '/api/files/extract',
      '/api/files/search',
      '/api/recipes',
      '/api/file-ops/preview',
      '/api/file-ops/apply',
    ]) {
      assert(allScripts.includes(route), `app scripts missing UI contract route ${route}`);
    }
    assert(index.body.includes('任务模板'), 'index missing recipe panel');
    assert(index.body.includes('澄清问题'), 'index missing clarification primitive');

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

    const extracted = await requestJson(baseUrl, '/api/files/extract', {
      trustedRoot: workspace,
      path: contractPath,
      maxSize: 1600,
    });
    assert(extracted.content.includes('renewal date'), 'UI extract flow cannot extract trusted file content');

    const recipes = await (await fetch(`${baseUrl}/api/recipes`)).json();
    assert(recipes.recipes.length >= 8, 'UI recipe flow did not expose MVP templates');

    const artifactPath = path.join(workspace, '.AgentCowork', 'artifacts', 'ui-smoke-plan.md');
    const operations = [
      {
        type: 'write',
        path: artifactPath,
        content: `# UI Smoke 计划\n\n来源摘要: ${read.content}\n`,
      },
    ];
    const preview = await requestJson(baseUrl, '/api/file-ops/preview', { trustedRoot: workspace, operations });
    assert(preview.operations.length === 1 && preview.operations[0].type === 'write', 'UI preview flow did not produce write preview');

    const applied = await requestJson(baseUrl, '/api/file-ops/apply', {
      trustedRoot: workspace,
      operations,
      idempotencyKey: 'ui-smoke-apply',
    });
    assert(applied.applied.length === 1 && applied.applied[0].status === 'applied', 'UI apply flow did not apply write operation');
    assert(fs.readFileSync(artifactPath, 'utf8').includes('UI Smoke 计划'), 'UI apply flow did not write artifact');
    assert(fs.readFileSync(auditPath, 'utf8').includes('"action":"write"'), 'UI apply flow did not write audit event');

    const artifactCatalog = await (await fetch(`${baseUrl}/api/artifacts?limit=5`)).json();
    assert(artifactCatalog.artifacts.some((item) => item.path === artifactPath), 'artifact catalog did not expose applied artifact');
    const artifactView = await getText(baseUrl, `/api/artifacts/view?path=${encodeURIComponent(artifactPath)}`);
    assert(artifactView.contentType.includes('text/html'), 'artifact live page did not return HTML');
    assert(artifactView.body.includes('Artifact Live Page'), 'artifact live page missing title');
    assert(artifactView.body.includes('UI Smoke 计划'), 'artifact live page missing applied artifact content');

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
