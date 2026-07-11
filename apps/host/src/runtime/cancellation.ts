// 取消登记表(host · L2 运行时 · runtime)
// ---------------------------------------------------------------------------
// 职责:让长任务(流式聊天、Agent 运行)可按 runId 被中断——即「停止」按钮。run 在自己 runId 下注册一个
//       AbortController,取消请求即 abort 其 signal,run 观察到后提前停止。条目随结束清理。依赖:无。
import {
  identityScopeTupleKey,
  requireIdentityScopeFrom,
} from '../security/identity-scope.js';

export type CancellationScope = { tenantId: string; userId: string };

const LEGACY_SCOPE_KEY = 'legacy';

function scopeKey(context: CancellationScope | null | undefined): string {
  if (context == null) return LEGACY_SCOPE_KEY;
  const owner = requireIdentityScopeFrom(context, { label: 'CancellationRegistry scope' });
  return identityScopeTupleKey(owner);
}

export class CancellationRegistry {
  readonly _controllers = new Map<string, Map<string, AbortController>>(); // runId 下再按 tenant/user 精确隔离。

  register(runId: string, context: CancellationScope | null = null): AbortController {
    if (!runId) {
      throw new Error('CancellationRegistry.register: runId is required');
    }
    const key = scopeKey(context);
    const controller = new AbortController();
    const scoped = this._controllers.get(runId) || new Map<string, AbortController>();
    scoped.set(key, controller);
    this._controllers.set(runId, scoped);
    return controller;
  }

  signal(runId: string, context: CancellationScope | null = null): AbortSignal | null {
    const key = scopeKey(context);
    const controller = this._controllers.get(runId)?.get(key);
    return controller ? controller.signal : null;
  }

  isCancelled(runId: string, context: CancellationScope | null = null): boolean {
    const key = scopeKey(context);
    const controller = this._controllers.get(runId)?.get(key);
    return controller ? controller.signal.aborted : false;
  }

  cancel(runId: string, reason = 'cancelled', context: CancellationScope | null = null): boolean {
    const key = scopeKey(context);
    const controller = this._controllers.get(runId)?.get(key);
    if (!controller) {
      return false;
    }
    if (!controller.signal.aborted) {
      controller.abort(reason);
    }
    return true;
  }

  done(runId: string, context: CancellationScope | null = null): boolean {
    const key = scopeKey(context);
    const scoped = this._controllers.get(runId);
    if (!scoped || !scoped.delete(key)) return false;
    if (scoped.size === 0) this._controllers.delete(runId);
    return true;
  }

  // 关闭流程调用此方法中断所有在途 run,让 SSE 等长连接尽快排空。
  cancelAll(reason = 'shutdown'): number {
    let n = 0;
    for (const [, scoped] of this._controllers) {
      for (const [, controller] of scoped) {
        if (!controller.signal.aborted) { controller.abort(reason); n += 1; }
      }
    }
    return n;
  }

  pending(): string[] {
    const runIds: string[] = [];
    for (const [runId, scoped] of this._controllers) {
      for (const _controller of scoped.values()) runIds.push(runId);
    }
    return runIds;
  }
}

export function createCancellationRegistry(): CancellationRegistry {
  return new CancellationRegistry();
}
