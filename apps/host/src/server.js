import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listWorkspaceTree } from './workspace/file-tree.js';
import { readTextFile } from './workspace/file-reader.js';
import { buildContextBundle } from './workspace/context-bundle.js';
import { previewFileOperations, applyFileOperations } from './workspace/file-operations.js';
import { detectKimiInfo } from './kimi/cli-detect.js';
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

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let raw = '';
    request.on('data', (chunk) => {
      raw += chunk.toString();
      if (raw.length > 1024 * 1024) {
        reject(new Error('Request body too large'));
      }
    });
    request.on('end', () => {
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

function withJsonBody(request, response, handler) {
  return readJsonBody(request)
    .then((body) => handler(body))
    .catch((err) => {
      sendJson(response, 400, { error: `Invalid JSON body: ${err.message}` });
    });
}

export function createServer(config = {}) {
  const trustedRootDefault = path.resolve(config.trustedRoot || process.env.TRUSTED_ROOT || process.cwd());
  const staticRoot = config.staticRoot === false ? null : path.resolve(config.staticRoot || defaultStaticRoot);

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
        sendJson(response, 200, { trustedRoot: trustedRootDefault });
        return;
      }

      if (request.method === 'GET' && pathname === '/api/kimi/info') {
        const info = await detectKimiInfo(config.kimiExecutable || 'kimi');
        sendJson(response, 200, info);
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
