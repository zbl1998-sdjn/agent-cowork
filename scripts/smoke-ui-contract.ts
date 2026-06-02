// 内置 UI 契约冒烟(scripts · smoke·E2E)
// ---------------------------------------------------------------------------
// 职责:拉起 Host 服务(uiDist:false 走内置静态壳),校验首页 HTML 的关键结构与中文
//       功能文案、app.css 的固定窗口/隐藏面板守卫,并逐个抓取页面声明的全部 app-*.js
//       脚本,断言其加载顺序、模块全局(window.AgentCowork*)、工厂函数及所引用的 UI 契约
//       API 路由都存在;随后跑通文件树/读取/抽取/recipes 与 file-ops 的 preview→apply
//       和 artifact 目录/实时页,确保前端契约与后端能力一致且保持 Kimi-only(无 Claude)。
// 用法:npm run smoke:ui(即 node scripts/run-host-node.mjs scripts/smoke-ui-contract.ts);
//       任一断言失败即 exit 1 阻断。
// 依赖:apps/host 的 createServer 与 JsonlWriter 审计写入。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../apps/host/src/server.js';
import type { HostServer } from '../apps/host/src/server.js';
import { JsonlWriter } from '../apps/host/src/storage/jsonl-writer.js';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const buildDir = path.join(repoRoot, 'build');

type JsonRecord = Record<string, unknown>;
type TextResponse = { body: string; contentType: string };

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function recordValue(value: unknown, label: string): JsonRecord {
  assert(isRecord(value), `${label} must be a JSON object`);
  return value;
}

function recordArray(value: unknown, label: string): JsonRecord[] {
  assert(Array.isArray(value), `${label} must be an array`);
  return value.map((item, index) => recordValue(item, `${label}[${index}]`));
}

function stringField(source: JsonRecord, key: string, label = key): string {
  const value = source[key];
  assert(typeof value === 'string', `${label} must be a string`);
  return value;
}

async function fetchJson(baseUrl: string, route: string): Promise<JsonRecord> {
  const response = await fetch(`${baseUrl}${route}`);
  const payload = await response.json() as unknown;
  assert(response.status === 200, `${route} returned ${response.status}: ${JSON.stringify(payload)}`);
  return recordValue(payload, `${route} response`);
}

async function requestJson(baseUrl: string, route: string, body: JsonRecord, expectedStatus = 200): Promise<JsonRecord> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const idempotencyKey = body.idempotencyKey;
  if (typeof idempotencyKey === 'string' && idempotencyKey) {
    headers['idempotency-key'] = idempotencyKey;
  }
  const response = await fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const payload = await response.json() as unknown;
  assert(response.status === expectedStatus, `${route} returned ${response.status}: ${JSON.stringify(payload)}`);
  return recordValue(payload, `${route} response`);
}

async function getText(baseUrl: string, route: string): Promise<TextResponse> {
  const response = await fetch(`${baseUrl}${route}`);
  const body = await response.text();
  assert(response.status === 200, `${route} returned ${response.status}: ${body}`);
  return { body, contentType: response.headers.get('content-type') || '' };
}

function scriptRoutesFromHtml(html: string): string[] {
  return [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*>/gi)]
    .map((match) => {
      const source = match[1];
      assert(source, 'script tag src capture should be present');
      return `/${source.replace(/^\.\//, '')}`;
    });
}

function baseUrlFor(server: HostServer): string {
  const address = server.address();
  assert(address && typeof address === 'object', 'server did not expose a listening address');
  return `http://127.0.0.1:${address.port}`;
}

function closeServer(server: HostServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error?: Error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function main(): Promise<void> {
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
    requireAuth: false,
    uiDist: false,
  });

  await new Promise<void>((resolve, reject) => {
    server.on('error', (error: Error) => reject(error));
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const baseUrl = baseUrlFor(server);
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
    assert(scriptRoutes.includes('/app-composer-sources.js'), 'index missing app-composer-sources.js script');
    assert(scriptRoutes.includes('/app-composer-popover.js'), 'index missing app-composer-popover.js script');
    assert(scriptRoutes.includes('/app-artifacts.js'), 'index missing app-artifacts.js script');
    assert(scriptRoutes.includes('/app-run-history.js'), 'index missing app-run-history.js script');
    assert(scriptRoutes.includes('/app-workbench-renderer.js'), 'index missing app-workbench-renderer.js script');
    assert(scriptRoutes.includes('/app-task-context.js'), 'index missing app-task-context.js script');
    assert(scriptRoutes.includes('/app-kimi-runner.js'), 'index missing app-kimi-runner.js script');
    assert(scriptRoutes.includes('/app-message-renderer.js'), 'index missing app-message-renderer.js script');
    assert(scriptRoutes.includes('/app-chat-runner.js'), 'index missing app-chat-runner.js script');
    assert(scriptRoutes.includes('/app-approval-runner.js'), 'index missing app-approval-runner.js script');
    assert(scriptRoutes.includes('/app-message-actions.js'), 'index missing app-message-actions.js script');
    assert(scriptRoutes.includes('/app-recipe-runner.js'), 'index missing app-recipe-runner.js script');
    assert(scriptRoutes.includes('/app-file-upload.js'), 'index missing app-file-upload.js script');
    assert(scriptRoutes.includes('/app-state.js'), 'index missing app-state.js script');
    assert(scriptRoutes.includes('/app-dom.js'), 'index missing app-dom.js script');
    assert(scriptRoutes.includes('/app-shell-services.js'), 'index missing app-shell-services.js script');
    assert(scriptRoutes.includes('/app-workspace-loader.js'), 'index missing app-workspace-loader.js script');
    assert(scriptRoutes.includes('/app-clarification.js'), 'index missing app-clarification.js script');
    assert(scriptRoutes.includes('/app-plan-preview.js'), 'index missing app-plan-preview.js script');
    assert(scriptRoutes.includes('/app-plan-runner.js'), 'index missing app-plan-runner.js script');
    assert(scriptRoutes.includes('/app-events.js'), 'index missing app-events.js script');
    assert(scriptRoutes.includes('/app-controller-assembly.js'), 'index missing app-controller-assembly.js script');
    assert(scriptRoutes.includes('/app.js'), 'index missing app.js script');
    assert(scriptRoutes.indexOf('/app-utils.js') < scriptRoutes.indexOf('/app.js'), 'app-utils.js must load before app.js');
    assert(scriptRoutes.indexOf('/app-api-client.js') < scriptRoutes.indexOf('/app.js'), 'app-api-client.js must load before app.js');
    assert(scriptRoutes.indexOf('/app-run-events.js') < scriptRoutes.indexOf('/app.js'), 'app-run-events.js must load before app.js');
    assert(scriptRoutes.indexOf('/app-composer-sources.js') < scriptRoutes.indexOf('/app-composer-popover.js'), 'app-composer-sources.js must load before app-composer-popover.js');
    assert(scriptRoutes.indexOf('/app-composer-sources.js') < scriptRoutes.indexOf('/app.js'), 'app-composer-sources.js must load before app.js');
    assert(scriptRoutes.indexOf('/app-composer-popover.js') < scriptRoutes.indexOf('/app.js'), 'app-composer-popover.js must load before app.js');
    assert(scriptRoutes.indexOf('/app-artifacts.js') < scriptRoutes.indexOf('/app.js'), 'app-artifacts.js must load before app.js');
    assert(scriptRoutes.indexOf('/app-run-history.js') < scriptRoutes.indexOf('/app.js'), 'app-run-history.js must load before app.js');
    assert(scriptRoutes.indexOf('/app-workbench-renderer.js') < scriptRoutes.indexOf('/app.js'), 'app-workbench-renderer.js must load before app.js');
    assert(scriptRoutes.indexOf('/app-task-context.js') < scriptRoutes.indexOf('/app.js'), 'app-task-context.js must load before app.js');
    assert(scriptRoutes.indexOf('/app-kimi-runner.js') < scriptRoutes.indexOf('/app.js'), 'app-kimi-runner.js must load before app.js');
    assert(scriptRoutes.indexOf('/app-message-renderer.js') < scriptRoutes.indexOf('/app.js'), 'app-message-renderer.js must load before app.js');
    assert(scriptRoutes.indexOf('/app-chat-runner.js') < scriptRoutes.indexOf('/app.js'), 'app-chat-runner.js must load before app.js');
    assert(scriptRoutes.indexOf('/app-approval-runner.js') < scriptRoutes.indexOf('/app.js'), 'app-approval-runner.js must load before app.js');
    assert(scriptRoutes.indexOf('/app-message-actions.js') < scriptRoutes.indexOf('/app.js'), 'app-message-actions.js must load before app.js');
    assert(scriptRoutes.indexOf('/app-recipe-runner.js') < scriptRoutes.indexOf('/app.js'), 'app-recipe-runner.js must load before app.js');
    assert(scriptRoutes.indexOf('/app-file-upload.js') < scriptRoutes.indexOf('/app.js'), 'app-file-upload.js must load before app.js');
    assert(scriptRoutes.indexOf('/app-state.js') < scriptRoutes.indexOf('/app.js'), 'app-state.js must load before app.js');
    assert(scriptRoutes.indexOf('/app-dom.js') < scriptRoutes.indexOf('/app.js'), 'app-dom.js must load before app.js');
    assert(scriptRoutes.indexOf('/app-shell-services.js') < scriptRoutes.indexOf('/app-controller-assembly.js'), 'app-shell-services.js must load before app-controller-assembly.js');
    assert(scriptRoutes.indexOf('/app-plan-preview.js') < scriptRoutes.indexOf('/app-plan-runner.js'), 'app-plan-preview.js must load before app-plan-runner.js');
    assert(scriptRoutes.indexOf('/app-plan-runner.js') < scriptRoutes.indexOf('/app-controller-assembly.js'), 'app-plan-runner.js must load before app-controller-assembly.js');
    assert(scriptRoutes.indexOf('/app-events.js') < scriptRoutes.indexOf('/app-controller-assembly.js'), 'app-events.js must load before app-controller-assembly.js');
    assert(scriptRoutes.indexOf('/app-controller-assembly.js') < scriptRoutes.indexOf('/app.js'), 'app-controller-assembly.js must load before app.js');
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
    assert(allScripts.includes('window.AgentCoworkArtifacts'), 'artifact module global missing');
    assert(allScripts.includes('window.AgentCoworkRunHistory'), 'run history module global missing');
    assert(allScripts.includes('window.AgentCoworkWorkbenchRenderer'), 'workbench renderer module global missing');
    assert(allScripts.includes('window.AgentCoworkTaskContext'), 'task context module global missing');
    assert(allScripts.includes('window.AgentCoworkKimiRunner'), 'kimi runner module global missing');
    assert(allScripts.includes('window.AgentCoworkMessageRenderer'), 'message renderer module global missing');
    assert(allScripts.includes('window.AgentCoworkMessageActions'), 'message actions module global missing');
    assert(allScripts.includes('window.AgentCoworkFileUpload'), 'file upload module global missing');
    assert(allScripts.includes('window.AgentCoworkAppState'), 'app state module global missing');
    assert(allScripts.includes('window.AgentCoworkAppDom'), 'app dom module global missing');
    assert(allScripts.includes('window.AgentCoworkShellServices'), 'shell services module global missing');
    assert(allScripts.includes('window.AgentCoworkWorkspaceLoader'), 'workspace loader module global missing');
    assert(allScripts.includes('window.AgentCoworkClarification'), 'clarification module global missing');
    assert(allScripts.includes('window.AgentCoworkPlanPreview'), 'plan preview module global missing');
    assert(allScripts.includes('window.AgentCoworkPlanRunner'), 'plan runner module global missing');
    assert(allScripts.includes('window.AgentCoworkAppEvents'), 'app events module global missing');
    assert(allScripts.includes('window.AgentCoworkControllerAssembly'), 'controller assembly module global missing');
    assert(allScripts.includes('createComposerPopover'), 'composer popover factory missing');
    assert(allScripts.includes('createArtifactCatalog'), 'artifact catalog factory missing');
    assert(allScripts.includes('createRunHistoryController'), 'run history factory missing');
    assert(allScripts.includes('createWorkbenchRenderer'), 'workbench renderer factory missing');
    assert(allScripts.includes('createTaskContext'), 'task context factory missing');
    assert(allScripts.includes('createKimiRunner'), 'kimi runner factory missing');
    assert(allScripts.includes('createMessageRenderer'), 'message renderer factory missing');
    assert(allScripts.includes('createMessageActions'), 'message actions factory missing');
    assert(allScripts.includes('createFileUploadController'), 'file upload factory missing');
    assert(allScripts.includes('createShellServices'), 'shell service factory missing');
    assert(allScripts.includes('createWorkspaceLoader'), 'workspace loader factory missing');
    assert(allScripts.includes('renderStaticPlanPreview'), 'static plan preview function missing');
    assert(allScripts.includes('createPlanRunner'), 'plan runner factory missing');
    assert(allScripts.includes('bindAppEvents'), 'app event binder missing');
    assert(allScripts.includes('function startApp'), 'controller assembly start function missing');
    assert(allScripts.includes('function setView'), 'app scripts missing view switching controller');
    assert(allScripts.includes('function appendAssistantMessage'), 'app scripts missing message bubble controller');
    assert(allScripts.includes('function handleComposerSend'), 'app scripts missing composer send router');
    assert(allScripts.includes('[data-quick]'), 'app scripts missing quick action handlers');
    assert(allScripts.includes('function subscribeRunEvents'), 'app scripts missing SSE run-event subscriber');
    assert(allScripts.includes('fetch(eventsUrl') && allScripts.includes('text/event-stream'), 'app scripts missing SSE fetch client');
    assert(allScripts.includes('/events`'), 'app scripts missing SSE /events route usage');
    assert(allScripts.includes('function handleComposerInput'), 'app scripts missing composer popover input handler');
    assert(allScripts.includes('detectComposerTrigger'), 'app scripts missing slash/at trigger detection');
    assert(allScripts.includes('historyRunItems'), 'app scripts missing # history run picker');
    assert(allScripts.includes('/api/runs/index'), 'app scripts missing runs-index picker route');
    assert(allScripts.includes('mode: "history"'), 'app scripts missing # history trigger detection');
    assert(allScripts.includes('replayRunEvents'), 'app scripts missing history run event replay');
    assert(allScripts.includes('/api/artifacts'), 'app scripts missing artifact catalog route');
    assert(allScripts.includes('/api/artifacts/view'), 'app scripts missing artifact live page route');
    assert(allScripts.includes('fileOperationApprovalId'), 'app scripts missing file operation approval token flow');
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

    const workspaceInfo = await fetchJson(baseUrl, '/api/workspace');
    assert(workspaceInfo.trustedRoot === workspace, 'workspace endpoint returned unexpected root');

    const tree = await requestJson(baseUrl, '/api/files/tree', { root: workspace });
    const treeFiles = recordArray(tree.files, 'tree.files');
    assert(treeFiles.some((entry) => entry.path === 'contracts/sample-contract.txt'), 'UI tree flow cannot see contract file');

    const read = await requestJson(baseUrl, '/api/files/read', {
      trustedRoot: workspace,
      path: contractPath,
      maxSize: 1600,
    });
    const readContent = stringField(read, 'content', 'read.content');
    assert(readContent.includes('renewal date'), 'UI read flow cannot read trusted file content');

    const extracted = await requestJson(baseUrl, '/api/files/extract', {
      trustedRoot: workspace,
      path: contractPath,
      maxSize: 1600,
    });
    assert(stringField(extracted, 'content', 'extracted.content').includes('renewal date'), 'UI extract flow cannot extract trusted file content');

    const recipes = await fetchJson(baseUrl, '/api/recipes');
    assert(recordArray(recipes.recipes, 'recipes.recipes').length >= 8, 'UI recipe flow did not expose MVP templates');

    const artifactPath = path.join(workspace, '.AgentCowork', 'artifacts', 'ui-smoke-plan.md');
    const operations = [
      {
        type: 'write',
        path: artifactPath,
        content: `# UI Smoke 计划\n\n来源摘要: ${readContent}\n`,
      },
    ];
    const preview = await requestJson(baseUrl, '/api/file-ops/preview', { trustedRoot: workspace, operations });
    const previewOperations = recordArray(preview.operations, 'preview.operations');
    assert(previewOperations.length === 1 && previewOperations[0]?.type === 'write', 'UI preview flow did not produce write preview');
    const fileOperationApprovalId = stringField(preview, 'fileOperationApprovalId', 'preview.fileOperationApprovalId');
    assert(/^fop_/.test(fileOperationApprovalId), 'UI preview flow did not issue an approval id');

    const applied = await requestJson(baseUrl, '/api/file-ops/apply', {
      trustedRoot: workspace,
      operations,
      fileOperationApprovalId,
      idempotencyKey: 'ui-smoke-apply',
    });
    const appliedOperations = recordArray(applied.applied, 'applied.applied');
    assert(appliedOperations.length === 1 && appliedOperations[0]?.status === 'applied', 'UI apply flow did not apply write operation');
    assert(fs.readFileSync(artifactPath, 'utf8').includes('UI Smoke 计划'), 'UI apply flow did not write artifact');
    assert(fs.readFileSync(auditPath, 'utf8').includes('"action":"write"'), 'UI apply flow did not write audit event');

    const artifactCatalog = await fetchJson(baseUrl, '/api/artifacts?limit=5');
    const artifacts = recordArray(artifactCatalog.artifacts, 'artifactCatalog.artifacts');
    assert(artifacts.some((item) => item.path === artifactPath), 'artifact catalog did not expose applied artifact');
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
    await closeServer(server);
  }
}

main().catch((error: unknown) => {
  const err = error as { stack?: unknown; message?: unknown };
  console.error(err.stack || err.message || error);
  process.exit(1);
});
