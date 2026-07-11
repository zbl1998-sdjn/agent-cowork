// CI 子进程有界执行器(scripts · 门禁基础设施)
// ---------------------------------------------------------------------------
// 职责:无 shell 启动单个 CI step，硬超时后终止整棵进程树，并返回结构化失败。
// 依赖:node:child_process；Windows 使用 taskkill /T /F，POSIX 使用独立进程组。
import childProcess from 'node:child_process';

const PROCESS_TREE_EXIT_GRACE_MS = 5_000;
export const CI_TREE_KILL_TIMEOUT_MS = 5_000;

type ChildLike = {
  pid?: number;
  kill(signal?: string): void;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'close', listener: (code: number | null, signal: string | null) => void): unknown;
};

export type CiProcessResult = {
  code: number;
  signal: string | null;
  error?: string;
};

export type RunCiProcessOptions = {
  stepName: string;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  timeoutMs: number;
  stdio?: 'inherit' | 'ignore';
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function killProcessTree(child: ChildLike): string | null {
  const pid = child.pid;
  if (!pid) {
    try {
      child.kill('SIGKILL');
      return null;
    } catch (cause) {
      return `child PID unavailable and direct kill failed: ${errorMessage(cause)}`;
    }
  }

  if (process.platform === 'win32') {
    const killed = childProcess.spawnSync(
      'taskkill.exe',
      ['/PID', String(pid), '/T', '/F'],
      {
        shell: false,
        windowsHide: true,
        stdio: 'ignore',
        timeout: CI_TREE_KILL_TIMEOUT_MS,
      },
    );
    if (!killed.error && killed.status === 0) return null;
    try {
      child.kill('SIGKILL');
    } catch {
      // 下面返回 taskkill 的明确失败证据。
    }
    return killed.error
      ? `taskkill failed: ${killed.error.message}`
      : `taskkill exited with status ${String(killed.status)}`;
  }

  try {
    process.kill(-pid, 'SIGKILL');
    return null;
  } catch (cause) {
    try {
      child.kill('SIGKILL');
    } catch {
      // 下面返回进程组 kill 的明确失败证据。
    }
    return `process-group kill failed: ${errorMessage(cause)}`;
  }
}

function timeoutError(stepName: string, timeoutMs: number, detail?: string | null): string {
  const suffix = detail ? `; ${detail}` : '';
  return `CI step ${JSON.stringify(stepName)} timed out after ${timeoutMs}ms${suffix}`;
}

/** 无 shell 运行 CI step；到点杀树，且即使 close 丢失也在终止宽限期后失败返回。 */
export function runCiProcess({
  stepName,
  command,
  args,
  cwd,
  env,
  timeoutMs,
  stdio = 'inherit',
}: RunCiProcessOptions): Promise<CiProcessResult> {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    return Promise.resolve({
      code: 1,
      signal: null,
      error: `CI step ${JSON.stringify(stepName)} has invalid timeout ${String(timeoutMs)}ms`,
    });
  }

  let child: ChildLike;
  try {
    child = childProcess.spawn(command, args, {
      cwd,
      env,
      detached: process.platform !== 'win32',
      shell: false,
      stdio,
      windowsHide: true,
    }) as ChildLike;
  } catch (cause) {
    return Promise.resolve({
      code: 1,
      signal: null,
      error: `CI step ${JSON.stringify(stepName)} failed to start: ${errorMessage(cause)}`,
    });
  }

  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let terminationDetail: string | null = null;
    let exitGraceTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: CiProcessResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (exitGraceTimer) clearTimeout(exitGraceTimer);
      resolve(result);
    };
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      terminationDetail = killProcessTree(child);
      exitGraceTimer = setTimeout(() => {
        const detail = terminationDetail
          ? terminationDetail
          : `process tree did not close within ${PROCESS_TREE_EXIT_GRACE_MS}ms`;
        finish({ code: 1, signal: null, error: timeoutError(stepName, timeoutMs, detail) });
      }, PROCESS_TREE_EXIT_GRACE_MS);
    }, timeoutMs);

    child.on('error', (error) => {
      finish({
        code: 1,
        signal: null,
        error: `CI step ${JSON.stringify(stepName)} failed to start: ${error.message}`,
      });
    });
    child.on('close', (code, signal) => {
      if (timedOut) {
        finish({ code: 1, signal, error: timeoutError(stepName, timeoutMs, terminationDetail) });
        return;
      }
      finish({ code: code ?? 1, signal });
    });
  });
}
