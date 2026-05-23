import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from '../src/server.js';
import { makeTestWorkspace } from './test-fixtures.js';

async function withServer(config, fn) {
  const server = createServer({ requireAuth: false, ...config });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    await fn(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('health returns stable host metadata', async () => {
  const trustedRoot = makeTestWorkspace('kcw-trusted');
  await withServer({ trustedRoot }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      service: 'kimi-cowork-host',
    });
  });
});

test('workspace endpoint returns configured trusted root', async () => {
  const trustedRoot = makeTestWorkspace('kcw-trusted');
  await withServer({ trustedRoot }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/workspace`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.trustedRoot, trustedRoot);
    assert.equal(body.kimiApi.configured, false);
    assert.equal(body.kimiApi.chatEnabled, false);
    assert.equal(body.kimiApi.planEnabled, false);
    assert.equal(body.kimiCli.chatEnabled, false);
    assert.equal(body.kimiCli.planEnabled, false);
    assert.equal(body.context.tenantId, 'tenant_local');
    assert.ok(response.headers.get('x-trace-id'));
  });
});

test('kimi plan endpoint is disabled unless API key or runner is configured', async () => {
  const trustedRoot = makeTestWorkspace('kcw-trusted');
  await withServer({ trustedRoot }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/kimi/plan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ trustedRoot, prompt: '生成计划' }),
    });
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /Kimi API is not configured/i);
  });
});

test('kimi plan endpoint calls configured API runner inside trusted root', async () => {
  const trustedRoot = makeTestWorkspace('kcw-trusted');
  let captured;
  await withServer({
    trustedRoot,
    kimiPlanRunner: async (input) => {
      captured = input;
      return {
        ok: true,
        provider: 'kimi-api',
        model: input.model,
        mode: input.mode,
        text: 'Kimi API 计划输出',
        durationMs: 12,
      };
    },
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/kimi/plan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        trustedRoot,
        prompt: '生成计划',
        summary: '本地摘要',
        mode: 'cowork',
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.match(body.runId, /^run_/);
    assert.equal(fs.existsSync(body.runPath), true);
    assert.equal(body.text, 'Kimi API 计划输出');
    assert.equal(captured.baseUrl, 'https://api.moonshot.ai/v1');
    assert.equal(captured.model, 'kimi-k2.6');
    assert.equal(captured.trustedRoot, trustedRoot);
    assert.equal(captured.prompt, '生成计划');
    assert.equal(captured.summary, '本地摘要');

    const record = JSON.parse(fs.readFileSync(body.runPath, 'utf8'));
    assert.equal(record.id, body.runId);
    assert.equal(record.status, 'succeeded');
    assert.equal(record.type, 'kimi-plan');
    assert.equal(record.provider, 'kimi-api');
    assert.equal(record.input.prompt, '生成计划');
    assert.equal(record.result.text, 'Kimi API 计划输出');
  });
});

test('kimi chat endpoint calls configured Kimi API runner', async () => {
  const trustedRoot = makeTestWorkspace('kcw-trusted');
  let captured;
  await withServer({
    trustedRoot,
    kimiChatRunner: async (input) => {
      captured = input;
      return {
        ok: true,
        provider: 'kimi-api',
        model: input.model,
        mode: 'chat',
        text: 'Kimi 对话输出',
        durationMs: 15,
      };
    },
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/kimi/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        trustedRoot,
        prompt: '你好',
        summary: '上传文件摘要',
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.match(body.runId, /^run_/);
    assert.equal(body.text, 'Kimi 对话输出');
    assert.equal(captured.mode, 'chat');
    assert.equal(captured.baseUrl, 'https://api.moonshot.ai/v1');
    assert.equal(captured.trustedRoot, trustedRoot);
    assert.equal(captured.prompt, '你好');

    const record = JSON.parse(fs.readFileSync(body.runPath, 'utf8'));
    assert.equal(record.type, 'kimi-chat');
    assert.equal(record.status, 'succeeded');
    assert.equal(record.result.text, 'Kimi 对话输出');
  });
});

test('upload import persists selected local files under trusted workspace', async () => {
  const trustedRoot = makeTestWorkspace('kcw-trusted');
  await withServer({ trustedRoot }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/uploads/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        trustedRoot,
        files: [
          {
            name: 'invoice.txt',
            relativePath: 'invoices/invoice.txt',
            size: Buffer.byteLength('amount=100'),
            contentBase64: Buffer.from('amount=100').toString('base64'),
          },
        ],
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.imported.length, 1);
    assert.equal(body.totalBytes, Buffer.byteLength('amount=100'));
    assert.equal(fs.readFileSync(body.imported[0].path, 'utf8'), 'amount=100');
    assert.match(body.imported[0].path, /[\\\/]Kimi_Cowork上传[\\\/]/);
  });
});

test('upload import rejects path traversal', async () => {
  const trustedRoot = makeTestWorkspace('kcw-trusted');
  await withServer({ trustedRoot }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/uploads/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        trustedRoot,
        files: [
          {
            name: 'secret.txt',
            relativePath: '../secret.txt',
            size: 1,
            contentBase64: Buffer.from('x').toString('base64'),
          },
        ],
      }),
    });
    assert.notEqual(response.status, 200);
    assert.match((await response.json()).error, /invalid segment|relativePath/i);
  });
});

test('run endpoints expose persisted Kimi plan records', async () => {
  const trustedRoot = makeTestWorkspace('kcw-trusted');
  let runId;
  await withServer({
    trustedRoot,
    kimiPlanRunner: async () => ({
      ok: true,
      provider: 'kimi-api',
      model: 'kimi-k2.6',
      mode: 'cowork',
      text: '可复跑的计划记录',
      durationMs: 18,
    }),
  }, async (baseUrl) => {
    const planResponse = await fetch(`${baseUrl}/api/kimi/plan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        trustedRoot,
        prompt: '生成可追踪计划',
        summary: '运行记录摘要',
        mode: 'cowork',
      }),
    });
    assert.equal(planResponse.status, 200);
    runId = (await planResponse.json()).runId;

    const listResponse = await fetch(`${baseUrl}/api/runs`);
    assert.equal(listResponse.status, 200);
    const listBody = await listResponse.json();
    assert.equal(listBody.runs.length, 1);
    assert.equal(listBody.runs[0].id, runId);
    assert.equal(listBody.runs[0].status, 'succeeded');
    assert.equal(listBody.runs[0].prompt, '生成可追踪计划');

    const detailResponse = await fetch(`${baseUrl}/api/runs/${encodeURIComponent(runId)}`);
    assert.equal(detailResponse.status, 200);
    const detail = await detailResponse.json();
    assert.equal(detail.result.text, '可复跑的计划记录');
    assert.equal(detail.input.summary, '运行记录摘要');
  });
});

test('task endpoint maps persisted runs into task cards', async () => {
  const trustedRoot = makeTestWorkspace('kcw-trusted');
  await withServer({
    trustedRoot,
    kimiPlanRunner: async () => ({
      ok: true,
      provider: 'kimi-api',
      model: 'kimi-k2.6',
      mode: 'cowork',
      text: '任务卡片计划',
      durationMs: 11,
    }),
  }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/kimi/plan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ trustedRoot, prompt: '生成任务卡片', mode: 'cowork' }),
    });
    const response = await fetch(`${baseUrl}/api/tasks`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.tasks.length, 1);
    assert.equal(body.tasks[0].status, 'done');
    assert.equal(body.tasks[0].activeForm, '已完成');
    assert.equal(body.tasks[0].prompt, '生成任务卡片');
  });
});

test('document extraction, search, and recipe endpoints generate approval operations', async () => {
  const trustedRoot = makeTestWorkspace('kcw-trusted');
  const notes = path.join(trustedRoot, 'meeting-notes.md');
  fs.writeFileSync(notes, '# 周会\n- 行动项：Derrick 5月30日准备周报\n', 'utf8');

  await withServer({ trustedRoot }, async (baseUrl) => {
    const recipes = await fetch(`${baseUrl}/api/recipes`);
    assert.equal(recipes.status, 200);
    assert.equal((await recipes.json()).recipes.length, 8);

    const extract = await fetch(`${baseUrl}/api/files/extract`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ trustedRoot, path: notes }),
    });
    assert.equal(extract.status, 200);
    assert.match((await extract.json()).content, /准备周报/);

    const search = await fetch(`${baseUrl}/api/files/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ trustedRoot, query: '准备周报', includeContent: true }),
    });
    assert.equal(search.status, 200);
    assert.equal((await search.json()).results[0].match, 'content');

    const run = await fetch(`${baseUrl}/api/recipes/meeting-actions/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'recipe-approval-ops' },
      body: JSON.stringify({ trustedRoot, prompt: '提取会议行动项', files: [notes] }),
    });
    assert.equal(run.status, 200);
    const body = await run.json();
    assert.match(body.runId, /^run_/);
    assert.equal(body.operations.length, 2);
    assert.equal(body.operations.some((op) => op.path.endsWith('.xlsx') && op.contentBase64), true);
    assert.equal(fs.existsSync(body.runPath), true);
  });
});

test('apply endpoint replays duplicate idempotency key without applying twice', async () => {
  const trustedRoot = makeTestWorkspace('kcw-trusted');
  const target = path.join(trustedRoot, '.KimiCowork', 'artifacts', 'idem.txt');
  const operations = [{ type: 'write', path: target, content: 'once' }];

  await withServer({ trustedRoot }, async (baseUrl) => {
    const first = await fetch(`${baseUrl}/api/file-ops/apply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'same-key' },
      body: JSON.stringify({ trustedRoot, operations }),
    });
    assert.equal(first.status, 200);
    assert.equal((await first.json()).applied.length, 1);

    const second = await fetch(`${baseUrl}/api/file-ops/apply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'same-key' },
      body: JSON.stringify({ trustedRoot, operations }),
    });
    assert.equal(second.status, 200);
    const replay = await second.json();
    assert.equal(replay.idempotentReplay, true);
    assert.equal(fs.readFileSync(target, 'utf8'), 'once');
  });
});

test('artifact endpoints list local artifacts and render safe HTML views', async () => {
  const trustedRoot = makeTestWorkspace('kcw-trusted');
  const artifactDir = path.join(trustedRoot, '.KimiCowork', 'artifacts');
  const artifactPath = path.join(artifactDir, 'report.md');
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.writeFileSync(artifactPath, '# Report\n\n<script>alert("x")</script>\n', 'utf8');

  await withServer({ trustedRoot }, async (baseUrl) => {
    const list = await fetch(`${baseUrl}/api/artifacts?limit=10`);
    assert.equal(list.status, 200);
    const body = await list.json();
    assert.equal(body.artifacts.length, 1);
    assert.equal(body.artifacts[0].name, 'report.md');
    assert.equal(body.artifacts[0].relativePath, '.KimiCowork/artifacts/report.md');
    assert.equal(body.artifacts[0].viewable, true);

    const view = await fetch(`${baseUrl}/api/artifacts/view?path=${encodeURIComponent(artifactPath)}`);
    assert.equal(view.status, 200);
    assert.match(view.headers.get('content-type'), /text\/html/);
    const html = await view.text();
    assert.match(html, /Artifact Live Page/);
    assert.match(html, /Report/);
    assert.match(html, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/);
    assert.doesNotMatch(html, /<script>alert/);
  });
});

test('kimi plan failures persist run record and expose run id', async () => {
  const trustedRoot = makeTestWorkspace('kcw-trusted');
  await withServer({
    trustedRoot,
    kimiPlanRunner: async () => {
      throw new Error('simulated kimi failure');
    },
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/kimi/plan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        trustedRoot,
        prompt: '生成失败记录',
        summary: '失败摘要',
        mode: 'cowork',
      }),
    });
    assert.equal(response.status, 502);
    const body = await response.json();
    assert.match(body.error, /simulated kimi failure/);
    assert.match(body.runId, /^run_/);
    assert.equal(fs.existsSync(body.runPath), true);

    const record = JSON.parse(fs.readFileSync(body.runPath, 'utf8'));
    assert.equal(record.status, 'failed');
    assert.equal(record.error.message, 'simulated kimi failure');
    assert.equal(record.input.prompt, '生成失败记录');
  });
});

test('serves the local preview shell and assets', async () => {
  const trustedRoot = makeTestWorkspace('kcw-trusted');
  const staticRoot = makeTestWorkspace('kcw-static');
  fs.writeFileSync(path.join(staticRoot, 'index.html'), '<!doctype html><title>Agent Cowork</title>', 'utf8');
  fs.writeFileSync(path.join(staticRoot, 'app.css'), 'body { color: black; }', 'utf8');
  fs.writeFileSync(path.join(staticRoot, 'app-utils.js'), 'window.KimiCoworkUtils = {};', 'utf8');
  fs.writeFileSync(path.join(staticRoot, 'app-api-client.js'), 'window.KimiCoworkApi = {};', 'utf8');
  fs.writeFileSync(path.join(staticRoot, 'app-run-events.js'), 'window.KimiCoworkRunEvents = {};', 'utf8');
  fs.writeFileSync(path.join(staticRoot, 'app-composer-popover.js'), 'window.KimiCoworkComposerPopover = {};', 'utf8');
  fs.writeFileSync(path.join(staticRoot, 'app.js'), 'window.kimiCowork = {};', 'utf8');

  await withServer({ trustedRoot, staticRoot }, async (baseUrl) => {
    const index = await fetch(`${baseUrl}/`);
    assert.equal(index.status, 200);
    assert.match(index.headers.get('content-type'), /text\/html/);
    assert.match(await index.text(), /Agent Cowork/);

    const script = await fetch(`${baseUrl}/app.js`);
    assert.equal(script.status, 200);
    assert.match(script.headers.get('content-type'), /javascript/);

    const utils = await fetch(`${baseUrl}/app-utils.js`);
    assert.equal(utils.status, 200);
    assert.match(utils.headers.get('content-type'), /javascript/);

    const apiClient = await fetch(`${baseUrl}/app-api-client.js`);
    assert.equal(apiClient.status, 200);
    assert.match(apiClient.headers.get('content-type'), /javascript/);

    const runEvents = await fetch(`${baseUrl}/app-run-events.js`);
    assert.equal(runEvents.status, 200);
    assert.match(runEvents.headers.get('content-type'), /javascript/);

    const composerPopover = await fetch(`${baseUrl}/app-composer-popover.js`);
    assert.equal(composerPopover.status, 200);
    assert.match(composerPopover.headers.get('content-type'), /javascript/);
  });
});

test('file tree rejects roots outside configured trusted root', async () => {
  const trustedRoot = makeTestWorkspace('kcw-trusted');
  const outsideRoot = makeTestWorkspace('kcw-outside');
  fs.writeFileSync(path.join(outsideRoot, 'leak.txt'), 'secret');

  await withServer({ trustedRoot }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/files/tree`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ root: outsideRoot }),
    });
    assert.notEqual(response.status, 200);
    const body = await response.json();
    assert.match(body.error, /trusted root/i);
  });
});
