//
// 熔断器(host · L2 运行时 · runtime)
// ---------------------------------------------------------------------------
// 职责:保护调用方免受不稳定/慢依赖(如上游模型 API)拖累——明显不健康时快速失败,冷却后再试探恢复。
//       状态机:closed(累计失败)→ open(短路拒绝,冷却中)→ half-open(放行少量试探,成功则闭合、失败再开)。
//       是韧性栈「别再猛敲坏后端」的一半,配合 resilience.js 的超时/重试/降级。依赖:无。导出:熔断器。
// 状态细节:
//   closed     正常执行,累计连续失败;达到 failureThreshold 后转 open。
//   open       冷却期内所有调用立即抛 OpenCircuitError,不再给坏依赖叠加压力。
//   half-open  冷却结束后只放行 halfOpenMax 个试探调用;成功则闭合,失败则重新打开。

export type CircuitState = 'closed' | 'open' | 'half-open';
export type CircuitBreakerOptions = {
  name?: string;
  failureThreshold?: number;
  cooldownMs?: number;
  halfOpenMax?: number;
  now?: () => number;
};
export type CircuitBreakerStats = {
  name: string;
  state: CircuitState;
  failures: number;
  trips: number;
  successes: number;
};

export class OpenCircuitError extends Error {
  readonly code = 'CIRCUIT_OPEN';

  constructor(name: string) {
    super(`circuit '${name}' is open`);
    this.name = 'OpenCircuitError';
  }
}

export class CircuitBreaker {
  readonly name: string;
  readonly failureThreshold: number;
  readonly cooldownMs: number;
  readonly halfOpenMax: number;
  readonly _now: () => number;
  _state: CircuitState;
  _failures: number;
  _openedAt: number;
  _halfOpenInFlight: number;
  _successes: number;
  _trips: number;

  constructor({ name = 'breaker', failureThreshold = 5, cooldownMs = 10000, halfOpenMax = 1, now = () => Date.now() }: CircuitBreakerOptions = {}) {
    this.name = name;
    this.failureThreshold = Math.max(1, failureThreshold);
    this.cooldownMs = Math.max(0, cooldownMs);
    this.halfOpenMax = Math.max(1, halfOpenMax);
    this._now = now;
    this._state = 'closed';
    this._failures = 0;
    this._openedAt = 0;
    this._halfOpenInFlight = 0;
    this._successes = 0;
    this._trips = 0;
  }

  get state(): CircuitState {
    this._maybeHalfOpen();
    return this._state;
  }

  // 惰性执行 open -> half-open:读取状态/判断请求时才检查冷却是否结束。
  // 这样不需要定时器,注入时钟的单测也能保持确定性。
  _maybeHalfOpen(): void {
    if (this._state === 'open' && this._now() - this._openedAt >= this.cooldownMs) {
      this._state = 'half-open';
      this._halfOpenInFlight = 0;
    }
  }

  canRequest(): boolean {
    this._maybeHalfOpen();
    if (this._state === 'closed') return true;
    if (this._state === 'open') return false;
    return this._halfOpenInFlight < this.halfOpenMax; // half-open:只允许有限试探。
  }

  onSuccess(): void {
    this._successes += 1;
    this._failures = 0;
    if (this._state === 'half-open') this._halfOpenInFlight = Math.max(0, this._halfOpenInFlight - 1);
    this._state = 'closed';
  }

  onFailure(): void {
    if (this._state === 'half-open') {
      this._open(); // 试探失败直接回到 open。
      return;
    }
    this._failures += 1;
    if (this._failures >= this.failureThreshold) this._open();
  }

  _open(): void {
    this._state = 'open';
    this._openedAt = this._now();
    this._failures = 0;
    this._halfOpenInFlight = 0;
    this._trips += 1;
  }

  // 包裹异步/同步调用;熔断 open 时立即抛 OpenCircuitError。
  async run<T>(fn: () => Promise<T> | T): Promise<T> {
    if (!this.canRequest()) throw new OpenCircuitError(this.name);
    if (this._state === 'half-open') this._halfOpenInFlight += 1;
    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  stats(): CircuitBreakerStats {
    return { name: this.name, state: this.state, failures: this._failures, trips: this._trips, successes: this._successes };
  }
}

export function createCircuitBreaker(options: CircuitBreakerOptions = {}): CircuitBreaker {
  return new CircuitBreaker(options);
}
