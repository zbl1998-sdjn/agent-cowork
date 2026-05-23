import fs from 'node:fs';
import path from 'node:path';
import { assertTrustedPath } from '../security/path-policy.js';
import { normalizeSandboxSpec } from './index.js';
import { createRunId, writeRunRecord } from '../runtime/run-store.js';
import { summariseRunForIndex } from '../runtime/runs-index.js';

// Run an inline code snippet inside the sandbox.
//
// This is the bridge between "task templates / recipes" and the sandbox: a
// caller hands us a tool name (node/python/...) plus the source text, and we
//
//   1. materialise the source as a script file *inside the trusted root*
//      (so both the local cwd-jail and the docker `-v root:/work` mount can
//      see it),
//   2. run it through the same structured SandboxSpec the /exec route uses,
//   3. record a `sandbox-code` run + event timeline, identical in shape to a
//      recipe run so the history/timeline UIs work unchanged.
//
// The script path handed to the tool is *relative* to the trusted root so it
// resolves correctly across backends: local (cwd = root) and docker (-w /work,
// where /work is the mounted root) both interpret it the same way.
//
// Returns { ok, runId, runPath, backend, scriptPath, scriptRelative, spec, result, events }.

const MAX_CODE_BYTES = 256 * 1024;
const EXT_BY_TOOL = Object.freeze({
  node: 'js',
  python: 'py',
  python3: 'py',
});
const EXT_RE = /^[a-z0-9]{1,8}$/i;
const SCRIPT_DIR_SEGMENTS = ['.AgentCowork', 'scripts'];

function fail(message, statusCode = 400) {
  const error = new Error(`code runner: ${message}`);
  error.statusCode = statusCode;
  return error;
}

function pickExt(tool, override) {
  if (override != null) {
    const ext = String(override).replace(/^\./, '');
    if (!EXT_RE.test(ext)) {
      throw fail('ext must be a short alphanumeric extension');
    }
    return ext.toLowerCase();
  }
  return EXT_BY_TOOL[tool] || 'txt';
}

function preview(text, max = 2000) {
  if (typeof text !== 'string' || text.length === 0) {
    return '';
  }
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export async function runCode({
  sandbox,
  sandboxLimits = {},
  tool,
  code,
  prompt = '',
  ext,
  timeoutMs,
  network = false,
  trustedRoot,
  runStoreRoot,
  runEvents = null,
  runsIndex = null,
  context = {},
}) {
  if (!sandbox) {
    throw fail('a sandbox is required', 503);
  }
  if (!runStoreRoot) {
    throw new Error('runCode: runStoreRoot required');
  }
  if (typeof code !== 'string' || !code.trim()) {
    throw fail('code is required');
  }
  if (Buffer.byteLength(code, 'utf8') > MAX_CODE_BYTES) {
    throw fail(`code too large (max ${MAX_CODE_BYTES} bytes)`);
  }

  const toolName = String(tool || '').trim();
  if (!toolName) {
    throw fail('tool is required');
  }
  const scriptExt = pickExt(toolName, ext);

  const safeRoot = assertTrustedPath(path.resolve(trustedRoot), path.resolve(trustedRoot));
  const runId = createRunId();
  const startedAt = new Date();

  const scriptName = `${runId}.${scriptExt}`;
  const scriptRelative = [...SCRIPT_DIR_SEGMENTS, scriptName].join('/');
  const scriptPath = assertTrustedPath(
    path.join(safeRoot, ...SCRIPT_DIR_SEGMENTS, scriptName),
    safeRoot,
  );

  // Validate the spec *before* writing anything: an unknown tool or a budget
  // violation should 400 without leaving a stray script behind.
  let spec;
  try {
    spec = normalizeSandboxSpec(
      { tool: toolName, args: [scriptRelative], timeoutMs, network },
      sandboxLimits,
    );
  } catch (err) {
    err.statusCode = err.statusCode || 400;
    throw err;
  }

  const events = [];
  const emit = (type, payload = {}) => {
    let enriched;
    if (runEvents) {
      enriched = runEvents.publish(runId, { type, ...payload });
    } else {
      enriched = { seq: events.length + 1, ts: new Date().toISOString(), type, ...payload };
    }
    events.push(enriched);
    return enriched;
  };

  const promptText = String(prompt || '').slice(0, 2000);
  emit('user_message', { text: promptText || `${toolName} ${scriptRelative}` });
  emit('assistant_start', { status: 'running', tool: toolName });

  const baseRecord = {
    id: runId,
    type: 'sandbox-code',
    provider: sandbox.backend,
    command: toolName,
    mode: 'sandbox',
    trustedRoot: safeRoot,
    startedAt: startedAt.toISOString(),
    context,
    input: { prompt: promptText, tool: toolName, script: scriptRelative },
  };

  const finalize = (record) => {
    const runPath = writeRunRecord(runStoreRoot, record);
    if (runsIndex) {
      try {
        runsIndex.upsert(summariseRunForIndex({ ...record, runPath }, context), context);
      } catch {
        // index failures never break the run
      }
    }
    return runPath;
  };

  try {
    fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
    fs.writeFileSync(scriptPath, code, 'utf8');
  } catch (err) {
    emit('assistant_end', { status: 'failed', error: err.message });
    const finishedAt = new Date();
    const runPath = finalize({
      ...baseRecord,
      status: 'failed',
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      error: { message: err.message },
    });
    err.payload = { runId, runPath };
    throw err;
  }

  emit('progress', { icon: 'check', text: `已写入脚本 ${scriptRelative}` });
  emit('sandbox_start', { tool: spec.tool, args: spec.args, timeoutMs: spec.timeoutMs });

  let result;
  try {
    result = await sandbox.exec(spec, { trustedRoot: safeRoot, context });
  } catch (err) {
    emit('sandbox_end', { status: 'failed', error: err.message });
    emit('assistant_end', { status: 'failed', error: err.message });
    const finishedAt = new Date();
    const runPath = finalize({
      ...baseRecord,
      status: 'failed',
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      error: { message: err.message },
    });
    err.payload = { runId, runPath };
    err.statusCode = err.statusCode || 502;
    throw err;
  }

  const finishedAt = new Date();
  const durationMs = result.durationMs ?? finishedAt.getTime() - startedAt.getTime();
  const ok = result.exitCode === 0 && !result.timedOut;
  emit('sandbox_end', {
    status: ok ? 'succeeded' : 'failed',
    exitCode: result.exitCode,
    timedOut: result.timedOut,
  });
  emit('assistant_end', { status: ok ? 'succeeded' : 'failed', durationMs });

  const runPath = finalize({
    ...baseRecord,
    status: ok ? 'succeeded' : 'failed',
    finishedAt: finishedAt.toISOString(),
    durationMs,
    result: {
      ok,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      truncated: result.truncated,
      stdoutPreview: preview(result.stdout),
      stderrPreview: preview(result.stderr),
    },
  });

  return {
    ok,
    runId,
    runPath,
    backend: result.backend,
    scriptPath,
    scriptRelative,
    spec: { tool: spec.tool, args: spec.args, timeoutMs: spec.timeoutMs, network: spec.network },
    result: { ...result, ok },
    events,
  };
}
