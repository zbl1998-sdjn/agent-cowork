// 沙箱代码执行(run-code)的类型契约(host · L1 领域层 · sandbox)
// ---------------------------------------------------------------------------
// 职责:定义在沙箱中跑用户代码的输入选项(RunCodeOptions)、执行结果与依赖端口
//       (SandboxLike/RunEventsLike/RunsIndexLike),让 code-runner 专注执行编排。
import type { SandboxLimits, SandboxSpec } from './sandbox-spec.js';

export type SandboxExecResult = {
  backend?: unknown;
  exitCode: number;
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
  truncated?: boolean;
  durationMs?: number;
};
export type SandboxLike = {
  backend?: unknown;
  exec(
    spec: SandboxSpec,
    ctx?: { trustedRoot?: string; context?: Record<string, unknown> },
  ): Promise<SandboxExecResult> | SandboxExecResult;
};
export type RunEventsLike = {
  publish(
    runId: string,
    event: Record<string, unknown>,
  ): Record<string, unknown> | Promise<Record<string, unknown>>;
};
export type RunsIndexLike = {
  upsert(summary: unknown, context?: Record<string, unknown>): unknown;
};
export type RunCodeOptions = {
  sandbox?: SandboxLike | null;
  sandboxLimits?: SandboxLimits;
  runtimeEnv?: Record<string, string | undefined>;
  nodeExecPath?: unknown;
  tool?: unknown;
  code?: unknown;
  prompt?: unknown;
  ext?: unknown;
  timeoutMs?: unknown;
  network?: boolean;
  trustedRoot: string;
  runStoreRoot: string;
  runEvents?: RunEventsLike | null;
  runsIndex?: RunsIndexLike | null;
  context?: Record<string, unknown>;
};
export type RunCodeResult = {
  ok: boolean;
  runId: string;
  runPath: string;
  backend: unknown;
  scriptPath: string;
  scriptRelative: string;
  spec: Pick<SandboxSpec, 'tool' | 'args' | 'timeoutMs' | 'network'>;
  result: SandboxExecResult & { ok: boolean };
  events: Record<string, unknown>[];
};
