// PostgreSQL event-bus 基础契约与纯辅助函数(host · L1 领域层 · storage)
// ---------------------------------------------------------------------------
// 职责:集中 PG Client 最小结构类型、通道/超时参数校验和有界 Promise 等待。
// 依赖:无。所有 I/O 与事件总线生命周期仍由 postgres-event-bus.ts 管理。

export type PgNotification = { payload?: string | null };
export type PgEventHandler = ((message: PgNotification) => void) | ((cause: unknown) => void);
export type PgNotifyClient = {
  on(event: 'notification' | 'error', handler: PgEventHandler): unknown;
  query(text: string, params?: unknown[]): Promise<unknown>;
  connect?: () => Promise<unknown>;
  end?: () => Promise<unknown>;
};
export type PgNotifyPool = { query(text: string, params?: unknown[]): Promise<unknown> };
export type PgNotifyClientConstructor = new (options?: Record<string, unknown>) => PgNotifyClient;
export type PgModule = {
  default?: { Client?: PgNotifyClientConstructor };
  Client?: PgNotifyClientConstructor;
};

export function publishTimeout(value: unknown): number {
  const timeoutMs = Number(value);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('PostgresEventBus: publishTimeoutMs must be a positive number');
  }
  return Math.floor(timeoutMs);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class NotificationTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`notification timed out after ${timeoutMs}ms`);
    this.name = 'NotificationTimeoutError';
  }
}

export async function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new NotificationTimeoutError(timeoutMs)), timeoutMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 校验 NOTIFY 通道名合法(通道名不能参数化,需防注入)。 */
export function safePgIdentifier(value: unknown): string {
  const text = String(value || '').trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/.test(text)) {
    throw new Error('PostgresEventBus: invalid channel name');
  }
  return text;
}
