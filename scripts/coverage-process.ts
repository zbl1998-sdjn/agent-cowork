// Host coverage 子进程有界执行器(scripts · 门禁基础设施)
// ---------------------------------------------------------------------------
// 职责:无 shell 启动 coverage 测试、捕获报告；硬超时后终止整棵进程树并有界返回。
// 依赖:node:child_process；Windows 使用 taskkill /T /F，POSIX 使用独立进程组。
import childProcess from 'node:child_process';

export const HOST_COVERAGE_TIMEOUT_MS = 1_680_000;
const TASKKILL_TIMEOUT_MS = 15_000;
const PROCESS_TREE_EXIT_GRACE_MS = 5_000;

type CapturedStream = {
  setEncoding(encoding: string): unknown;
  on(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
  destroy?: () => void;
};

type CoverageChild = {
  pid?: number;
  stdout: CapturedStream;
  stderr: CapturedStream;
  kill(signal?: string): void;
  unref(): void;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'close', listener: (code: number | null, signal: string | null) => void): unknown;
};

export type CoverageProcessResult = {
  status: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error?: Error;
  cleanupError?: string;
};

export type RunCoverageProcessOptions = {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  timeoutMs: number;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function appendError(current: string | null, next: string): string {
  return current ? `${current}; ${next}` : next;
}

function directKill(child: CoverageChild): string | null {
  try {
    child.kill('SIGKILL');
    return null;
  } catch (cause) {
    return `direct child kill failed: ${errorMessage(cause)}`;
  }
}

function runTaskkill(pid: number): Promise<string | null> {
  let killer: CoverageChild;
  try {
    killer = childProcess.spawn(
      'taskkill.exe',
      ['/PID', String(pid), '/T', '/F'],
      { shell: false, windowsHide: true, stdio: 'ignore' },
    ) as CoverageChild;
  } catch (cause) {
    return Promise.resolve(`could not start taskkill for PID ${pid}: ${errorMessage(cause)}`);
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (detail: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(detail);
    };
    const timer = setTimeout(() => {
      const killError = directKill(killer);
      killer.unref();
      const suffix = killError ? `; ${killError}` : '';
      finish(`taskkill timed out for PID ${pid} after ${TASKKILL_TIMEOUT_MS}ms${suffix}`);
    }, TASKKILL_TIMEOUT_MS);
    killer.on('error', (error) => {
      finish(`taskkill failed to start for PID ${pid}: ${error.message}`);
    });
    killer.on('close', (code) => {
      finish(code === 0 ? null : `taskkill exited with status ${String(code)} for PID ${pid}`);
    });
  });
}

async function terminateProcessTree(child: CoverageChild): Promise<string | null> {
  const pid = child.pid;
  if (!pid) return directKill(child);

  if (process.platform === 'win32') {
    const taskkillError = await runTaskkill(pid);
    if (!taskkillError) return null;
    const directKillError = directKill(child);
    return directKillError ? `${taskkillError}; ${directKillError}` : taskkillError;
  }

  try {
    process.kill(-pid, 'SIGKILL');
    return null;
  } catch (cause) {
    const groupError = `process-group kill failed for ${pid}: ${errorMessage(cause)}`;
    const directKillError = directKill(child);
    return directKillError ? `${groupError}; ${directKillError}` : groupError;
  }
}

function timeoutError(timeoutMs: number, cleanupError: string | null): Error {
  const detail = cleanupError ? `; cleanup error: ${cleanupError}` : '';
  return new Error(`coverage process timed out after ${timeoutMs}ms${detail}`);
}

function destroyCaptureStreams(child: CoverageChild): void {
  child.stdout.destroy?.();
  child.stderr.destroy?.();
}

/** Run one coverage command without a shell and tear down its full process tree on timeout. */
export function runCoverageProcess({
  command,
  args,
  cwd,
  env,
  timeoutMs,
}: RunCoverageProcessOptions): Promise<CoverageProcessResult> {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    return Promise.resolve({
      status: null,
      signal: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      error: new Error(`coverage process has invalid timeout ${String(timeoutMs)}ms`),
    });
  }

  let child: CoverageChild;
  try {
    child = childProcess.spawn(command, args, {
      cwd,
      env,
      detached: process.platform !== 'win32',
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    }) as CoverageChild;
  } catch (cause) {
    return Promise.resolve({
      status: null,
      signal: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      error: new Error(`coverage process failed to start: ${errorMessage(cause)}`),
    });
  }

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += String(chunk); });
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });

  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let childClosed = false;
    let childSignal: string | null = null;
    let terminationComplete = false;
    let cleanupError: string | null = null;
    let closeGraceTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (
      status: number | null,
      signal: string | null,
      error?: Error,
    ): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (closeGraceTimer) clearTimeout(closeGraceTimer);
      const result: CoverageProcessResult = { status, signal, stdout, stderr, timedOut };
      if (error) result.error = error;
      if (cleanupError) result.cleanupError = cleanupError;
      resolve(result);
    };
    const completeTermination = (detail: string | null): void => {
      cleanupError = detail;
      terminationComplete = true;
      if (settled) return;
      if (childClosed) {
        finish(null, childSignal, timeoutError(timeoutMs, cleanupError));
        return;
      }
      closeGraceTimer = setTimeout(() => {
        const fallbackError = directKill(child);
        if (fallbackError) cleanupError = appendError(cleanupError, fallbackError);
        cleanupError = appendError(
          cleanupError,
          `process tree did not close within ${PROCESS_TREE_EXIT_GRACE_MS}ms`,
        );
        destroyCaptureStreams(child);
        child.unref();
        finish(null, null, timeoutError(timeoutMs, cleanupError));
      }, PROCESS_TREE_EXIT_GRACE_MS);
    };
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      void terminateProcessTree(child).then(
        completeTermination,
        (cause) => completeTermination(`process-tree termination crashed: ${errorMessage(cause)}`),
      );
    }, timeoutMs);

    child.on('error', (error) => {
      if (timedOut) {
        childClosed = true;
        cleanupError = appendError(cleanupError, `child process error: ${error.message}`);
        if (terminationComplete) finish(null, childSignal, timeoutError(timeoutMs, cleanupError));
      } else {
        finish(null, null, new Error(`coverage process failed to start: ${error.message}`));
      }
    });
    child.on('close', (code, signal) => {
      if (timedOut) {
        childClosed = true;
        childSignal = signal;
        if (terminationComplete) finish(null, childSignal, timeoutError(timeoutMs, cleanupError));
      } else {
        finish(code, signal);
      }
    });
  });
}
