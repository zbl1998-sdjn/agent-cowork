import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listWorkspaceTree } from './workspace/file-tree.js';
import { readTextFile } from './workspace/file-reader.js';
import { buildContextBundle } from './workspace/context-bundle.js';
import { previewFileOperations, applyFileOperations } from './workspace/file-operations.js';
import { importUploadedFiles } from './workspace/uploads.js';
import { detectKimiInfo } from './kimi/cli-detect.js';
import { runKimiCliChat, runKimiCliPlan } from './kimi/cli-runner.js';
import { createRunId, listRunRecords, readRunRecord, writeRunRecord } from './runtime/run-store.js';
import { assertTrustedPath } from './security/path-policy.js';
import fs from 'node:fs';

const hostSrcDir = path.dirname(fileURLToPath(import.meta.url));
const defaultStaticRoot = path.resolve(hostSrcDir, '../../windows-client/resources');
const staticFiles = new Map([
  ['/', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/index.html', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/app.css', { file: 'app.css', type: 'text/css; charset=utf-8' }],
  ['/app.js', { file: 'app.js', type: 'text/javascript; charset=utf-8' }],
]);

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

function sendFile(response, filePath, contentType) {
  try {
    const body = fs.readFileSync(filePath);
    response.writeHead(200, {
      'content-type': contentType,
      'content-length': body.length,
      'cache-control': 'no-store',
    });
    response.end(body);
  } catch (err) {
    sendJson(response, 404, { error: `Static asset not found: ${err.message}` });
  }
}

function readJsonBody(request, { maxBytes = 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let rejected = false;
    request.on('data', (chunk) => {
      if (rejected) {
        return;
      }
      raw += chunk.toString();
      if (raw.length > maxBytes) {
        rejected = true;
        reject(new Error(`Request body too large; max ${maxBytes} bytes`));
        request.destroy();
      }
    });
    request.on('end', () => {
      if (rejected) {
        return;
      }
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    request.on('error', reject);
  });
}

async function withJsonBody(request, response, handler, options = {}) {
  let body;
  try {
    body = await readJsonBody(request, options);
  } catch (err) {
    sendJson(response, 400, { error: `Invalid JSON body: ${err.message}` });
    return;
  }
  try {
    await handler(body);
  } catch (err) {
    sendJson(response, err.statusCode || 400, {
      error: err.message,
      ...(err.payload || {}),
    });
  }
}

export function createServer(config = {}) {
  const trustedRootDefault = path.resolve(config.trustedRoot || process.env.TRUSTED_ROOT || process.cwd());
  const staticRoot = config.staticRoot === false ? null : path.resolve(config.staticRoot || defaultStaticRoot);
  const kimiCliPlanEnabled = config.enableKimiCliPlan === true;
  const kimiPlanRunner = config.kimiPlanRunner || runKimiCliPlan;
  const kimiChatRunner = config.kimiChatRunner || runKimiCliChat;
  const runStoreRoot = path.resolve(config.runStoreRoot || path.join(trustedRootDefault, '.KimiCowork', 'runs'));

  async function runKimiAndRecord({
    type,
    mode,
    trustedRoot,
    prompt,
    summary,
    runner,
    response,
  }) {
    const runId = createRunId();
    const startedAt = new Date();
    const baseRecord = {
      id: runId,
      type,
      provider: 'kimi-cli',
      command: config.kimiExecutable || 'kimi',
      mode,
      trustedRoot,
      startedAt: startedAt.toISOString(),
      input: {
        prompt,
        summary: typeof summary === 'string' ? summary : '',
      },
    };
    try {
      const result = await runner({
        command: baseRecord.command,
        trustedRoot,
        prompt,
        summary,
        mode,
        timeoutMs: config.kimiCliTimeoutMs,
        maxSteps: config.kimiCliMaxSteps,
        model: config.kimiModel,
      });
      const finishedAt = new Date();
      const runPath = writeRunRecord(runStoreRoot, {
        ...baseRecord,
        status: 'succeeded',
        finishedAt: finishedAt.toISOString(),
        durationMs: result.durationMs ?? finishedAt.getTime() - startedAt.getTime(),
        result: {
          ok: result.ok,
          text: result.text,
        },
      });
      sendJson(response, 200, {
        ...result,
        runId,
        runPath,
      });
    } catch (err) {
      const finishedAt = new Date();
      const runPath = writeRunRecord(runStoreRoot, {
        ...baseRecord,
        status: 'failed',
        finishedAt: finishedAt.toISOString(),
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        error: {
          message: err.message,
        },
      });
      err.statusCode = /timed out/i.test(err.message) ? 504 : 502;
      err.payload = { runId, runPath };
      throw err;
    }
  }

  const server = http.createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url || '/', 'http://127.0.0.1');
      const pathname = requestUrl.pathname;

      if (request.method === 'GET' && staticRoot && staticFiles.has(pathname)) {
        const asset = staticFiles.get(pathname);
        sendFile(response, path.join(staticRoot, asset.file), asset.type);
        return;
      }

      if (request.method === 'GET' && pathname === '/health') {
        sendJson(response, 200, { ok: true, service: 'kimi-cowork-host' });
        return;
      }

      if (request.method === 'GET' && pathname === '/api/workspace') {
        sendJson(response, 200, {
          trustedRoot: trustedRootDefault,
          kimiCli: {
            planEnabled: kimiCliPlanEnabled,
            chatEnabled: kimiCliPlanEnabled,
          },
        });
        return;
      }

      if (request.method === 'GET' && pathname === '/api/kimi/info') {
        const info = await detectKimiInfo(config.kimiExecutable || 'kimi');
        sendJson(response, 200, info);
        return;
      }

      if (request.method === 'POST' && pathname === '/api/kimi/plan') {
        await withJsonBody(request, response, async (body) => {
          if (!kimiCliPlanEnabled) {
            sendJson(response, 503, {
              error: 'Kimi CLI plan is disabled. Set ENABLE_KIMI_CLI_PLAN=1 to enable it.',
            });
            return;
          }
          if (!body || typeof body.prompt !== 'string' || !body.prompt.trim()) {
            throw new Error('body.prompt is required');
          }
          const trustedRoot = path.resolve(body.trustedRoot || trustedRootDefault);
          const safeRoot = assertTrustedPath(trustedRoot, trustedRootDefault);
          await runKimiAndRecord({
            type: 'kimi-plan',
            mode: body.mode === 'code' ? 'code' : 'cowork',
            trustedRoot: safeRoot,
            prompt: body.prompt,
            summary: body.summary,
            runner: kimiPlanRunner,
            response,
          });
        });
        return;
      }

      if (request.method === 'POST' && pathname === '/api/kimi/chat') {
        await withJsonBody(request, response, async (body) => {
          if (!kimiCliPlanEnabled) {
            sendJson(response, 503, {
              error: 'Kimi CLI chat is disabled. Set ENABLE_KIMI_CLI_PLAN=1 to enable it.',
            });
            return;
          }
          if (!body || typeof body.prompt !== 'string' || !body.prompt.trim()) {
            throw new Error('body.prompt is required');
          }
          const trustedRoot = path.resolve(body.trustedRoot || trustedRootDefault);
          const safeRoot = assertTrustedPath(trustedRoot, trustedRootDefault);
          await runKimiAndRecord({
            type: 'kimi-chat',
            mode: 'chat',
            trustedRoot: safeRoot,
            prompt: body.prompt,
            summary: body.summary,
            runner: kimiChatRunner,
            response,
          });
        });
        return;
      }

      if (request.method === 'GET' && pathname === '/api/runs') {
        sendJson(response, 200, {
          runStoreRoot,
          runs: listRunRecords(runStoreRoot, {
            limit: Number(requestUrl.searchParams.get('limit')) || 20,
          }),
        });
        return;
      }

      if (request.method === 'GET' && pathname.startsWith('/api/runs/')) {
        const runId = decodeURIComponent(pathname.slice('/api/runs/'.length));
        const run = readRunRecord(runStoreRoot, runId);
        if (!run) {
          sendJson(response, 404, { error: 'Run record not found' });
          return;
        }
        sendJson(response, 200, run);
        return;
      }

      if (request.method === 'POST' && pathname === '/api/files/tree') {
        await withJsonBody(request, response, async (body) => {
          if (!body || typeof body.root !== 'string' || !body.root.trim()) {
            throw new Error('body.root is required');
          }
          const requestedRoot = path.resolve(body.root);
          const trustedRoot = assertTrustedPath(requestedRoot, trustedRootDefault);
          const tree = listWorkspaceTree(trustedRoot, {
            includeFiles: body.includeFiles !== false,
            includeDirectories: body.includeDirectories !== false,
          });
          sendJson(response, 200, { root: trustedRoot, files: tree });
        });
        return;
      }

      if (request.method === 'POST' && pathname === '/api/uploads/import') {
        await withJsonBody(request, response, async (body) => {
          const trustedRoot = path.resolve(body.trustedRoot || trustedRootDefault);
          const safeRoot = assertTrustedPath(trustedRoot, trustedRootDefault);
          const imported = importUploadedFiles({
            trustedRoot: safeRoot,
            files: body.files,
          });
          sendJson(response, 200, imported);
        }, { maxBytes: config.maxUploadJsonBytes || 18 * 1024 * 1024 });
        return;
      }

      if (request.method === 'POST' && pathname === '/api/files/read') {
        await withJsonBody(request, response, async (body) => {
          if (!body || typeof body.path !== 'string' || !body.path.trim()) {
            throw new Error('body.path is required');
          }
          const trustedRoot = path.resolve(body.trustedRoot || trustedRootDefault);
          const file = readTextFile(body.path, {
            trustedRoot,
            maxSize: body.maxSize,
          });
          sendJson(response, 200, file);
        });
        return;
      }

      if (request.method === 'POST' && pathname === '/api/context/bundle') {
        await withJsonBody(request, response, async (body) => {
          const trustedRoot = path.resolve(body.trustedRoot || trustedRootDefault);
          if (!Array.isArray(body.paths)) {
            throw new Error('body.paths must be an array');
          }
          const bundle = buildContextBundle({
            root: trustedRoot,
            paths: body.paths,
            maxTextSize: body.maxTextSize,
            fsStatFn: (candidate) => {
              const safe = assertTrustedPath(candidate, trustedRoot);
              return fs.statSync(safe);
            },
          });
          sendJson(response, 200, bundle);
        });
        return;
      }

      if (request.method === 'POST' && pathname === '/api/file-ops/preview') {
        await withJsonBody(request, response, async (body) => {
          const trustedRoot = path.resolve(body.trustedRoot || trustedRootDefault);
          const preview = previewFileOperations(body.operations, { trustedRoot });
          sendJson(response, 200, preview);
        });
        return;
      }

      if (request.method === 'POST' && pathname === '/api/file-ops/apply') {
        await withJsonBody(request, response, async (body) => {
          const trustedRoot = path.resolve(body.trustedRoot || trustedRootDefault);
          const applied = applyFileOperations(body.operations, {
            trustedRoot,
            journalWriter: config.journalWriter,
          });
          sendJson(response, 200, applied);
        });
        return;
      }

      sendJson(response, 404, { error: 'Not found' });
    } catch (err) {
      sendJson(response, 500, { error: err.message });
    }
  });

  return server;
}
