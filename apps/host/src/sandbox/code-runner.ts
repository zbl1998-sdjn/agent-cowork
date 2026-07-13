// 内联代码运行器(host · L1 领域层 · sandbox)
// ---------------------------------------------------------------------------
// 职责:把一段内联代码(node/python)物化为可信根内的脚本文件,在沙箱里执行,并全程产出
//       run 事件与 run 记录(可观测/可回放)。写盘前先校验 spec,失败也落 run 记录、不留残脚本。
// 依赖:L0 path-policy + 同层 sandbox-spec/local-runtime-tools/code-runner-utils/storage 持久化。导出:runCode。
import fs from 'node:fs';
import path from 'node:path';
import { assertTrustedPath } from '../security/path-policy.js';
import { bindRunEventPublisher } from '../util/run-event-publisher.js';
import { normalizeSandboxSpec } from './index.js';
import { resolveLocalRuntimeTool, withLocalRuntimeToolLimits } from './local-runtime-tools.js';
import { MAX_CODE_BYTES, SCRIPT_DIR_SEGMENTS, fail, pickExt, preview, toHttpError } from './code-runner-utils.js';
import { createRunId, writeRunRecord } from '../storage/run-store.js';
import { summariseRunForIndex } from '../storage/runs-index.js';
import type { SandboxSpec } from './sandbox-spec.js';
import type { RunCodeOptions, RunCodeResult, SandboxExecResult } from './code-runner-types.js';

export type {
  RunCodeOptions,
  RunCodeResult,
  RunEventsLike,
  RunsIndexLike,
  SandboxExecResult,
  SandboxLike,
} from './code-runner-types.js';

type RunRecordLike = { id: string; [key: string]: unknown };

/**
 * 运行内联代码:校验代码/工具 → 选本地运行时(如内置 Python)→ 写脚本 → 沙箱执行 → 落 run 记录与事件。
 * 返回 { ok, runId, runPath, result, events, … }。任一阶段失败均会发出失败事件并写入失败 run 记录。
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
  unrestrictedHostExecution = false,
  trustedRoot,
  runStoreRoot,
  runEvents = null,
  runsIndex = null,
  context = {},
}: RunCodeOptions): Promise<RunCodeResult> {
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

  // 先校验用户请求的工具,再套本地运行时偏好;内置 Python 不能扩大调用方 allowlist。
  let requestedSpec: SandboxSpec;
  try {
    requestedSpec = normalizeSandboxSpec(
      { tool: toolName, args: [scriptRelative], timeoutMs, network, unrestrictedHostExecution },
      sandboxLimits,
    );
  } catch (err) {
    throw toHttpError(err, 400);
  }

  const localRuntime = resolveLocalRuntimeTool(toolName, sandbox, runtimeEnv, nodeExecPath);

  // 写盘前先校验最终 spec;未知工具或预算违规应直接 400,不留下残脚本。
  let spec: SandboxSpec;
  try {
    if (localRuntime) {
      spec = normalizeSandboxSpec(
        {
          tool: localRuntime.tool,
          args: requestedSpec.args,
          timeoutMs: requestedSpec.timeoutMs,
          network: requestedSpec.network,
          unrestrictedHostExecution: requestedSpec.unrestrictedHostExecution,
          env: { PATH: localRuntime.pathPrefix },
        },
        withLocalRuntimeToolLimits(sandboxLimits, localRuntime.tool),
      );
      spec = { ...spec, executablePath: localRuntime.executablePath };
    } else {
      spec = requestedSpec;
    }
  } catch (err) {
    throw toHttpError(err, 400);
  }

  const events: Record<string, unknown>[] = [];
  const scopedRunEvents = bindRunEventPublisher(runEvents, context);
  const emit = async (type: string, payload: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
    let enriched;
    if (scopedRunEvents) {
      enriched = await scopedRunEvents.publish(runId, { type, ...payload });
    } else {
      enriched = { seq: events.length + 1, ts: new Date().toISOString(), type, ...payload };
    }
    events.push(enriched);
    return enriched;
  };

  const promptText = String(prompt || '').slice(0, 2000);
  await emit('user_message', { text: promptText || `${toolName} ${scriptRelative}` });
  await emit('assistant_start', { status: 'running', tool: toolName });

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

  const finalize = (record: RunRecordLike): string => {
    const runPath = writeRunRecord(runStoreRoot, record);
    if (runsIndex) {
      try {
        runsIndex.upsert(summariseRunForIndex({ ...record, runPath }, context), context);
      } catch {
        // 索引失败不影响 run 结果落盘。
      }
    }
    return runPath;
  };

  try {
    fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
    fs.writeFileSync(scriptPath, code, 'utf8');
  } catch (err) {
    const error = toHttpError(err);
    await emit('assistant_end', { status: 'failed', error: error.message });
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

  await emit('progress', { icon: 'check', text: `已写入脚本 ${scriptRelative}` });
  await emit('sandbox_start', { tool: spec.tool, args: spec.args, timeoutMs: spec.timeoutMs });

  let result: SandboxExecResult;
  try {
    result = await sandbox.exec(spec, { trustedRoot: safeRoot, context });
  } catch (err) {
    const error = toHttpError(err, 502);
    await emit('sandbox_end', { status: 'failed', error: error.message });
    await emit('assistant_end', { status: 'failed', error: error.message });
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
  await emit('sandbox_end', {
    status: ok ? 'succeeded' : 'failed',
    exitCode: result.exitCode,
    timedOut: result.timedOut,
  });
  await emit('assistant_end', { status: ok ? 'succeeded' : 'failed', durationMs });

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
