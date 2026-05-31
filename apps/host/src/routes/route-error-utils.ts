// 路由错误归一化(host · L3 routes)
// ---------------------------------------------------------------------------
// 职责:把 unknown error 稳定转为 status/message/payload,避免各路由重复手写分支。

export type RouteError = Error & { statusCode?: number; payload?: Record<string, unknown> };

function partialRouteError(err: unknown): Partial<RouteError> {
  return err && typeof err === 'object' ? err as Partial<RouteError> : {};
}

export function errorStatus(err: unknown, fallback: number): number {
  return Number(partialRouteError(err).statusCode) || fallback;
}

export function errorMessage(err: unknown): string {
  return partialRouteError(err).message || String(err || 'request failed');
}

export function errorPayload(err: unknown): Record<string, unknown> {
  const payload = partialRouteError(err).payload;
  return payload && typeof payload === 'object' ? payload : {};
}
