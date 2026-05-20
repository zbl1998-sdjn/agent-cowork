import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from '../src/server.js';
import { makeTestWorkspace } from './test-fixtures.js';

async function withServer(config, fn) {
  const server = createServer(config);
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
    assert.deepEqual(await response.json(), {
      trustedRoot,
      kimiCli: {
        chatEnabled: false,
        planEnabled: false,
      },
    });
  });
});

test('kimi plan endpoint is disabled unless explicitly enabled', async () => {
  const trustedRoot = makeTestWorkspace('kcw-trusted');
  await withServer({ trustedRoot }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/kimi/plan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ trustedRoot, prompt: '生成计划' }),
    });
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /disabled/i);
  });
});

test('kimi plan endpoint calls configured runner inside trusted root', async () => {
  const trustedRoot = makeTestWorkspace('kcw-trusted');
  let captured;
  await withServer({
    trustedRoot,
    enableKimiCliPlan: true,
    kimiExecutable: 'kimi-test',
    kimiPlanRunner: async (input) => {
      captured = input;
      return {
        ok: true,
        provider: 'kimi-cli',
        command: 'kimi-test',
        mode: input.mode,
        text: 'Kimi CLI 计划输出',
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
    assert.equal(body.text, 'Kimi CLI 计划输出');
    assert.equal(captured.command, 'kimi-test');
    assert.equal(captured.trustedRoot, trustedRoot);
    assert.equal(captured.prompt, '生成计划');
    assert.equal(captured.summary, '本地摘要');

    const record = JSON.parse(fs.readFileSync(body.runPath, 'utf8'));
    assert.equal(record.id, body.runId);
    assert.equal(record.status, 'succeeded');
    assert.equal(record.type, 'kimi-plan');
    assert.equal(record.input.prompt, '生成计划');
    assert.equal(record.result.text, 'Kimi CLI 计划输出');
  });
});

test('kimi chat endpoint calls configured Kimi runner', async () => {
  const trustedRoot = makeTestWorkspace('kcw-trusted');
  let captured;
  await withServer({
    trustedRoot,
    enableKimiCliPlan: true,
    kimiExecutable: 'kimi-test',
    kimiChatRunner: async (input) => {
      captured = input;
      return {
        ok: true,
        provider: 'kimi-cli',
        command: 'kimi-test',
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
    assert.equal(captured.command, 'kimi-test');
    assert.equal(captured.mode, 'chat');
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
    enableKimiCliPlan: true,
    kimiPlanRunner: async () => ({
      ok: true,
      provider: 'kimi-cli',
      command: 'kimi',
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

test('kimi plan failures persist run record and expose run id', async () => {
  const trustedRoot = makeTestWorkspace('kcw-trusted');
  await withServer({
    trustedRoot,
    enableKimiCliPlan: true,
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
  fs.writeFileSync(path.join(staticRoot, 'index.html'), '<!doctype html><title>Kimi Cowork</title>', 'utf8');
  fs.writeFileSync(path.join(staticRoot, 'app.css'), 'body { color: black; }', 'utf8');
  fs.writeFileSync(path.join(staticRoot, 'app.js'), 'window.kimiCowork = {};', 'utf8');

  await withServer({ trustedRoot, staticRoot }, async (baseUrl) => {
    const index = await fetch(`${baseUrl}/`);
    assert.equal(index.status, 200);
    assert.match(index.headers.get('content-type'), /text\/html/);
    assert.match(await index.text(), /Kimi Cowork/);

    const script = await fetch(`${baseUrl}/app.js`);
    assert.equal(script.status, 200);
    assert.match(script.headers.get('content-type'), /javascript/);
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
