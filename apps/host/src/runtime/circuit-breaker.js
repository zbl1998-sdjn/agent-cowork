// Circuit breaker — protects callers from a flaky/slow dependency (e.g. the
// upstream model API) by failing fast once it is clearly unhealthy, then probing
// for recovery. This is the "stop hammering a broken backend" half of the
// resilience stack; pair it with timeout/retry/fallback (see resilience.js).
//
// State machine:
//   closed     normal operation; consecutive failures are counted.
//              >= failureThreshold failures  ->  open.
//   open       short-circuit: every call is rejected immediately (OpenCircuitError)
//              for cooldownMs, so we stop piling load onto a dead dependency.
//   half-open  after the cooldown, allow up to halfOpenMax trial calls. One
//              success closes the circuit; any failure re-opens it.

export class OpenCircuitError extends Error {
  constructor(name) {
    super(`circuit '${name}' is open`);
    this.name = 'OpenCircuitError';
    this.code = 'CIRCUIT_OPEN';
  }
}

export class CircuitBreaker {
  constructor({ name = 'breaker', failureThreshold = 5, cooldownMs = 10000, halfOpenMax = 1, now = () => Date.now() } = {}) {
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

  get state() {
    this._maybeHalfOpen();
    return this._state;
  }

  // Lazily transition open -> half-open once the cooldown has elapsed. Done on
  // read so we don't need a timer (and stay deterministic under an injected clock).
  _maybeHalfOpen() {
    if (this._state === 'open' && this._now() - this._openedAt >= this.cooldownMs) {
      this._state = 'half-open';
      this._halfOpenInFlight = 0;
    }
  }

  canRequest() {
    this._maybeHalfOpen();
    if (this._state === 'closed') return true;
    if (this._state === 'open') return false;
    return this._halfOpenInFlight < this.halfOpenMax; // half-open: limited trials
  }

  onSuccess() {
    this._successes += 1;
    this._failures = 0;
    if (this._state === 'half-open') this._halfOpenInFlight = Math.max(0, this._halfOpenInFlight - 1);
    this._state = 'closed';
  }

  onFailure() {
    if (this._state === 'half-open') {
      this._open(); // a trial failed -> straight back to open
      return;
    }
    this._failures += 1;
    if (this._failures >= this.failureThreshold) this._open();
  }

  _open() {
    this._state = 'open';
    this._openedAt = this._now();
    this._failures = 0;
    this._halfOpenInFlight = 0;
    this._trips += 1;
  }

  // Wrap an async call. Throws OpenCircuitError immediately when open.
  async run(fn) {
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

  stats() {
    return { name: this.name, state: this.state, failures: this._failures, trips: this._trips, successes: this._successes };
  }
}

export function createCircuitBreaker(options = {}) {
  return new CircuitBreaker(options);
}
