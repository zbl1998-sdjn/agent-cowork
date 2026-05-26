import fs from 'node:fs';
import path from 'node:path';
import { assertTrustedPath } from '../security/path-policy.js';
import { normalizeSandboxSpec } from './index.js';
import { resolveLocalRuntimeTool, withLocalRuntimeToolLimits } from './local-runtime-tools.js';
import { MAX_CODE_BYTES, SCRIPT_DIR_SEGMENTS, fail, pickExt, preview, toHttpError } from './code-runner-utils.js';
import { createRunId, writeRunRecord } from '../runtime/run-store.js';
import { summariseRunForIndex } from '../runtime/runs-index.js';

/**
 * @typedef {import('./sandbox-spec.js').SandboxSpec} SandboxSpec
 * @typedef {import('./sandbox-spec.js').SandboxLimits} SandboxLimits
 * @typedef {{ backend?: unknown, exitCode: number, stdout?: string, stderr?: string, timedOut?: boolean, truncated?: boolean, durationMs?: number }} SandboxExecResult
 * @typedef {{ backend?: unknown, exec(spec: SandboxSpec, ctx?: { trustedRoot?: string, context?: Record<string, unknown> }): Promise<SandboxExecResult> | SandboxExecResult }} SandboxLike
 * @typedef {{ publish(runId: string, event: Record<string, unknown>): Record<string, unknown> }} RunEventsLike
 * @typedef {{ upsert(summary: unknown, context?: Record<string, unknown>): unknown }} RunsIndexLike
 * @typedef {{
 *   sandbox?: SandboxLike | null,
 *   sandboxLimits?: SandboxLimits,
 *   runtimeEnv?: Record<string, string | undefined>,
 *   nodeExecPath?: unknown,
 *   tool?: unknown,
 *   code?: unknown,
 *   prompt?: unknown,
 *   ext?: unknown,
 *   timeoutMs?: unknown,
 *   network?: boolean,
 *   trustedRoot: string,
 *   runStoreRoot: string,
 *   runEvents?: RunEventsLike | null,
 *   runsIndex?: RunsIndexLike | null,
 *   context?: Record<string, unknown>,
 * }} RunCodeOptions
 * @typedef {{ id: string, [key: string]: unknown }} RunRecordLike
 */

/**
 * @param {RunCodeOptions} options
 */
export async function runCode({
  sandbox,
  sandboxLimits = {},
  runtimeEnv = process.env,
  nodeExecPath = process.execPath,
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

  // Validate the requested tool *before* applying local runtime preferences:
  // bundled Python must not widen the caller's allowlist.
  let requestedSpec;
  try {
    requestedSpec = normalizeSandboxSpec(
      { tool: toolName, args: [scriptRelative], timeoutMs, network },
      sandboxLimits,
    );
  } catch (err) {
    throw toHttpError(err, 400);
  }

  const localRuntime = resolveLocalRuntimeTool(toolName, sandbox, runtimeEnv, nodeExecPath);

  // Validate the spec *before* writing anything: an unknown tool or a budget
  // violation should 400 without leaving a stray script behind.
  let spec;
  try {
    if (localRuntime) {
      spec = normalizeSandboxSpec(
        {
          tool: localRuntime.tool,
          args: requestedSpec.args,
          timeoutMs: requestedSpec.timeoutMs,
          network: requestedSpec.network,
          env: { PATH: localRuntime.pathPrefix },
        },
        withLocalRuntimeToolLimits(sandboxLimits, localRuntime.tool),
      );
    } else {
      spec = requestedSpec;
    }
  } catch (err) {
    throw toHttpError(err, 400);
  }

  /** @type {Record<string, unknown>[]} */
  const events = [];
  /** @param {string} type @param {Record<string, unknown>} [payload] */
  const emit = (type, payload = {}) => {
    /** @type {Record<string, unknown>} */
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

  /** @param {RunRecordLike} record */
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
    const error = toHttpError(err);
    emit('assistant_end', { status: 'failed', error: error.message });
    const finishedAt = new Date();
    const runPath = finalize({
      ...baseRecord,
      status: 'failed',
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      error: { message: error.message },
    });
    error.payload = { runId, runPath };
    throw error;
  }

  emit('progress', { icon: 'check', text: `已写入脚本 ${scriptRelative}` });
  emit('sandbox_start', { tool: spec.tool, args: spec.args, timeoutMs: spec.timeoutMs });

  let result;
  try {
    result = await sandbox.exec(spec, { trustedRoot: safeRoot, context });
  } catch (err) {
    const error = toHttpError(err, 502);
    emit('sandbox_end', { status: 'failed', error: error.message });
    emit('assistant_end', { status: 'failed', error: error.message });
    const finishedAt = new Date();
    const runPath = finalize({
      ...baseRecord,
      status: 'failed',
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      error: { message: error.message },
    });
    error.payload = { runId, runPath };
    throw error;
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
