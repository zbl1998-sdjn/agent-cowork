import path from 'node:path';
import { MEMORY_LIMITS } from '../memory/memory-store.js';
import { assertTrustedPath } from '../security/path-policy.js';
import { decodePathSegment, sendJson, withJsonBody } from '../http/request-utils.js';

export async function handleMemoryRoutes({
  request,
  response,
  pathname,
  requestUrl,
  requestContext,
  trustedRootDefault,
  memoryStore,
}) {
  if (request.method === 'GET' && pathname === '/api/memory') {
    const trustedRoot = path.resolve(
      requestUrl.searchParams.get('trustedRoot') || trustedRootDefault,
    );
    const safeRoot = assertTrustedPath(trustedRoot, trustedRootDefault);
    const main = await memoryStore.readMainMemory(safeRoot, requestContext);
    const notes = (await memoryStore.listMemoryNotes(safeRoot, requestContext)).map((note) => ({
      name: note.name,
      size: note.size,
      modifiedAt: note.modifiedAt,
    }));
    sendJson(response, 200, {
      trustedRoot: safeRoot,
      memory: {
        enabled: Boolean(main.trim()),
        bytes: Buffer.byteLength(main, 'utf8'),
        text: main,
        notes,
      },
      limits: MEMORY_LIMITS,
    });
    return true;
  }

  if (request.method === 'POST' && pathname === '/api/memory/facts') {
    await withJsonBody(request, response, async (body) => {
      const trustedRoot = path.resolve(body?.trustedRoot || trustedRootDefault);
      const safeRoot = assertTrustedPath(trustedRoot, trustedRootDefault);
      const result = await memoryStore.appendMemoryFact(
        safeRoot,
        { key: body?.key, value: body?.value, scope: body?.scope },
        requestContext,
      );
      sendJson(response, 200, {
        trustedRoot: safeRoot,
        fact: result.fact,
        file: result.file,
        context: requestContext,
      });
    });
    return true;
  }

  if (request.method === 'POST' && pathname === '/api/memory/notes') {
    await withJsonBody(request, response, async (body) => {
      if (!body || typeof body.name !== 'string' || !body.name.trim()) {
        throw new Error('body.name is required');
      }
      if (typeof body.body !== 'string') {
        throw new Error('body.body must be a string');
      }
      const trustedRoot = path.resolve(body.trustedRoot || trustedRootDefault);
      const safeRoot = assertTrustedPath(trustedRoot, trustedRootDefault);
      const written = await memoryStore.writeMemoryNote(safeRoot, body.name, body.body, requestContext);
      sendJson(response, 200, {
        trustedRoot: safeRoot,
        note: { name: body.name, path: written },
        context: requestContext,
      });
    });
    return true;
  }

  if (request.method === 'GET' && pathname.startsWith('/api/memory/notes/')) {
    const noteName = decodePathSegment(pathname.slice('/api/memory/notes/'.length));
    if (!noteName) {
      sendJson(response, 400, { error: 'Invalid memory note name' });
      return true;
    }
    const trustedRoot = path.resolve(
      requestUrl.searchParams.get('trustedRoot') || trustedRootDefault,
    );
    const safeRoot = assertTrustedPath(trustedRoot, trustedRootDefault);
    const body = await memoryStore.readMemoryNote(safeRoot, noteName, requestContext);
    if (body == null) {
      sendJson(response, 404, { error: 'Memory note not found' });
      return true;
    }
    sendJson(response, 200, {
      trustedRoot: safeRoot,
      note: { name: noteName, body },
    });
    return true;
  }

  return false;
}
