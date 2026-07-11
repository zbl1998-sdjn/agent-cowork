// Run 事件发布 scope 适配器(host · L0 基础层 · util)
// ---------------------------------------------------------------------------
// 职责:把带 tenant/user 上下文的发布器显式收窄为二参 publisher,供各执行入口向深层传递。
//       只快照隔离键,不代理其他方法,避免业务事件误落入 legacy local key。

export type RunEventScopeLike = { tenantId?: unknown; userId?: unknown };
export type RunEventPublisher<Result = unknown> = {
  publish(
    runId: string,
    event: Record<string, unknown>,
    scope?: RunEventScopeLike,
  ): Result;
};
export type ScopedRunEventPublisher<Result = unknown> = {
  publish(runId: string, event: Record<string, unknown>): Result;
};

export function bindRunEventPublisher<Result>(
  runEvents: RunEventPublisher<Result>,
  context?: RunEventScopeLike,
): ScopedRunEventPublisher<Result>;
export function bindRunEventPublisher<Result>(
  runEvents: RunEventPublisher<Result> | null | undefined,
  context?: RunEventScopeLike,
): ScopedRunEventPublisher<Result> | null;
export function bindRunEventPublisher<Result>(
  runEvents: RunEventPublisher<Result> | null | undefined,
  context?: RunEventScopeLike,
): ScopedRunEventPublisher<Result> | null {
  if (!runEvents) return null;
  const scope = arguments.length < 2
    ? undefined
    : { tenantId: context?.tenantId, userId: context?.userId };
  return {
    publish(runId, event) {
      return runEvents.publish(runId, event, scope);
    },
  };
}
