import type { ChildLike, SpawnLike } from '../../src/sandbox/exec-child.js';
import type { ProbeError, ProbeResult, SpawnSyncLike } from '../../src/sandbox/startup-probe.js';

type ProbeHandler = {
  status?: number | null;
  stdout?: string;
  stderr?: string;
  error?: ProbeError;
};

export type CapturedSpawn = {
  command?: string;
  args?: string[];
};

class StreamStub {
  private readonly dataListeners: Array<(chunk: unknown) => void> = [];

  on(event: 'data', listener: (chunk: unknown) => void): unknown {
    if (event === 'data') this.dataListeners.push(listener);
    return this;
  }

  emitData(chunk: unknown): void {
    for (const listener of this.dataListeners) listener(chunk);
  }
}

class ChildStub {
  readonly stdout = new StreamStub();
  readonly stderr = new StreamStub();
  private readonly errorListeners: Array<(error: Error) => void> = [];
  private readonly closeListeners: Array<(code: number | null, signal: string | null) => void> = [];

  kill(): void {
    // Fake children finish on the scheduled close event; tests do not need kill semantics.
  }

  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'close', listener: (code: number | null, signal: string | null) => void): unknown;
  on(event: 'error' | 'close', listener: ((error: Error) => void) | ((code: number | null, signal: string | null) => void)): unknown {
    if (event === 'error') {
      this.errorListeners.push(listener as (error: Error) => void);
    } else {
      this.closeListeners.push(listener as (code: number | null, signal: string | null) => void);
    }
    return this;
  }

  emitClose(code: number | null): void {
    for (const listener of this.closeListeners) listener(code, null);
  }
}

export function fakeProbeSpawnSync(handlers: Record<string, ProbeHandler>): SpawnSyncLike {
  return (command: string, args: readonly string[] = []): ProbeResult => {
    const key = [command, ...args].join(' ');
    const handler = handlers[key];
    if (!handler) return { status: 1, stdout: '', stderr: `${command} not available` };
    const result: ProbeResult = { status: handler.status ?? 0, stdout: handler.stdout || '', stderr: handler.stderr || '' };
    if (handler.error) result.error = handler.error;
    return result;
  };
}

export function fakeSpawn(
  captured: CapturedSpawn,
  { stdout = '', stderr = '', exitCode = 0 }: { stdout?: string; stderr?: string; exitCode?: number | null } = {},
): SpawnLike {
  return (command: string, args: string[]): ChildLike => {
    captured.command = command;
    captured.args = args;
    const child = new ChildStub();
    void Promise.resolve().then(() => {
      if (stdout) child.stdout.emitData(Buffer.from(stdout));
      if (stderr) child.stderr.emitData(Buffer.from(stderr));
      child.emitClose(exitCode);
    });
    return child as ChildLike;
  };
}
