type DataListener = (chunk: Buffer | string) => void;
type EndListener = () => void;
type ErrorListener = (error: Error) => void;
type RequestListener = DataListener | EndListener | ErrorListener;
type StoredListener = (...args: unknown[]) => void;

export class ManualHttpRequest {
  readonly headers: Record<string, string | string[] | undefined>;

  resumed = false;

  destroyed = false;

  readonly #listeners = new Map<string, StoredListener[]>();

  constructor(headers: Record<string, string | string[] | undefined> = { 'content-type': 'application/json' }) {
    this.headers = headers;
  }

  on(event: 'data', listener: DataListener): this;
  on(event: 'end', listener: EndListener): this;
  on(event: 'error', listener: ErrorListener): this;
  on(event: string, listener: RequestListener): this {
    const listeners = this.#listeners.get(event) ?? [];
    listeners.push(listener as StoredListener);
    this.#listeners.set(event, listeners);
    return this;
  }

  emit(event: 'data', chunk: Buffer | string): void;
  emit(event: 'end'): void;
  emit(event: 'error', error: Error): void;
  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.#listeners.get(event) ?? []) {
      listener(...args);
    }
  }

  resume(): void {
    this.resumed = true;
  }

  destroy(): void {
    this.destroyed = true;
  }
}
