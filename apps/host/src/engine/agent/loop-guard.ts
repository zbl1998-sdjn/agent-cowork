// 循环看护:检测工具调用打转/连续失败并叫停(host · L1 领域层 · engine/agent)
// ---------------------------------------------------------------------------
// 职责:为每次工具调用计算稳定指纹(工具名 + 规范化参数),累计同指纹的重复次数与
//      连续失败次数;超过阈值即返回 shouldBreak,让主循环跳出无效死循环。
// 依赖:仅标准库。
// 导出:LoopGuard(类)/ createLoopGuard(工厂)
const DEFAULT_MAX_REPEATS = 4;
const DEFAULT_MAX_CONSECUTIVE_FAILURES = 3;

export type ToolCallLike = { name?: string; tool?: string; args?: unknown; arguments?: unknown };
export type LoopDecision = {
  shouldBreak: boolean;
  reason: string;
  tool: string;
  fingerprint: string;
  repeatCount: number;
  consecutiveFailures: number;
};
export type LoopGuardOptions = { maxRepeats?: number; maxConsecutiveFailures?: number };

function normalizeForFingerprint(value: unknown, seen: WeakSet<object>): unknown {
  if (value === undefined || value === null) return value;
  if (typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => normalizeForFingerprint(item, seen));
  const record = value as Record<string, unknown>;
  return Object.keys(record).sort().reduce((out, key) => {
    out[key] = normalizeForFingerprint(record[key], seen);
    return out;
  }, {} as Record<string, unknown>);
}

function stableStringify(value: unknown): string {
  try {
    return JSON.stringify(normalizeForFingerprint(value, new WeakSet()));
  } catch {
    return String(value);
  }
}

function normalizeCall(call: ToolCallLike): { tool: string; args: unknown; fingerprint: string } {
  const tool = String(call?.name || call?.tool || 'unknown');
  const args = call?.args !== undefined ? call.args : call?.arguments;
  return { tool, args, fingerprint: `${tool}:${stableStringify(args || {})}` };
}

function decision(partial: Partial<LoopDecision> = {}): LoopDecision {
  return {
    shouldBreak: false,
    reason: '',
    tool: '',
    fingerprint: '',
    repeatCount: 0,
    consecutiveFailures: 0,
    ...partial,
  };
}

/** 循环看护器:按指纹追踪工具调用的重复与连续失败,超阈值即建议中断。 */
export class LoopGuard {
  readonly maxRepeats: number;
  readonly maxConsecutiveFailures: number;
  readonly repeatCounts = new Map<string, number>();
  readonly failureCounts = new Map<string, number>();
  lastDecision: LoopDecision;

  /** 构造看护器,设定重复次数与连续失败次数的上限(均至少为 1)。 */
  constructor(options: LoopGuardOptions = {}) {
    this.maxRepeats = Math.max(1, Math.round(Number(options.maxRepeats) || DEFAULT_MAX_REPEATS));
    this.maxConsecutiveFailures = Math.max(1, Math.round(Number(options.maxConsecutiveFailures) || DEFAULT_MAX_CONSECUTIVE_FAILURES));
    this.lastDecision = decision();
  }

  /**
   * 观察一次工具调用及其成败,更新计数并产出本次决策(是否应中断)。
   */
  observe(call: ToolCallLike, okOrResult: boolean | { ok?: boolean } = true): LoopDecision {
    const { tool, fingerprint } = normalizeCall(call);
    const ok = typeof okOrResult === 'object' ? okOrResult.ok !== false : okOrResult !== false;
    const repeatCount = (this.repeatCounts.get(fingerprint) || 0) + 1;
    this.repeatCounts.set(fingerprint, repeatCount);
    const consecutiveFailures = ok ? 0 : (this.failureCounts.get(fingerprint) || 0) + 1;
    this.failureCounts.set(fingerprint, consecutiveFailures);

    if (consecutiveFailures >= this.maxConsecutiveFailures) {
      this.lastDecision = decision({
        shouldBreak: true,
        reason: `Tool ${tool} failed ${consecutiveFailures} consecutive times with the same arguments; stop retrying this path.`,
        tool,
        fingerprint,
        repeatCount,
        consecutiveFailures,
      });
      return this.lastDecision;
    }
    if (repeatCount >= this.maxRepeats) {
      this.lastDecision = decision({
        shouldBreak: true,
        reason: `Tool ${tool} repeated the same arguments ${repeatCount} times; stop the loop and ask for a new approach.`,
        tool,
        fingerprint,
        repeatCount,
        consecutiveFailures,
      });
      return this.lastDecision;
    }
    this.lastDecision = decision({ tool, fingerprint, repeatCount, consecutiveFailures });
    return this.lastDecision;
  }

  /** 返回最近一次 observe 的决策。 */
  shouldBreak(): LoopDecision {
    return this.lastDecision;
  }
}

/**
 * 工厂:创建一个 LoopGuard 实例。
 */
export function createLoopGuard(options: LoopGuardOptions = {}): LoopGuard {
  return new LoopGuard(options);
}
