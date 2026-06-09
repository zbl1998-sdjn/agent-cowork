// 受约束子进程运行器(host · L1 领域层 · sandbox)
// ---------------------------------------------------------------------------
// 职责:本地与 VM(WSL/Docker)后端共用的子进程启动方式——无 shell、argv 数组、硬超时(SIGKILL)、
//       输出字节上限。集中在此,保证各后端的安全行为一致。
// 亮点:CappedBuffer 在「写入时」即限内存(超额只计数不保留),避免高产出命令在超时前耗尽堆。
// 依赖:无。导出:createCappedBuffer / runConstrainedChild。

const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024; // 1 MiB per stream

export type StreamLike = {
  on(event: 'data', listener: (chunk: unknown) => void): unknown;
};
export type ChildLike = {
  stdout: StreamLike;
  stderr: StreamLike;
  kill(signal?: string): void;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'close', listener: (code: number | null, signal: string | null) => void): unknown;
};
export type SpawnLike = (command: string, args: string[], options: Record<string, unknown>) => ChildLike;
export type CappedBuffer = {
  push(chunk: unknown): void;
  readonly text: string;
  readonly truncated: boolean;
  readonly bytes: number;
};
export type RunChildOptions = {
  spawn: SpawnLike;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  maxOutputBytes: number;
  abortSignal?: AbortSignal | null;
};
export type RunChildResult = {
  exitCode: number;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  bytesStdout: number;
  bytesStderr: number;
  durationMs: number;
};

/** 造一个「写入即限内存」的输出缓冲:超过 maxBytes 的分块只计数不保留,内存恒为 O(maxBytes)。 */
export function createCappedBuffer(maxBytes: number): CappedBuffer {
  const cap = Math.max(1, Number(maxBytes) || DEFAULT_MAX_OUTPUT_BYTES);
  const parts: Buffer[] = [];
  let stored = 0; // 实际保留的字节数(<= cap)。
  let total = 0;  // 已见总字节数(截断前)。
  return {
    push(chunk) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      total += buf.length;
      if (stored >= cap) return; // 缓冲已满,之后只计数不保留。
      if (stored + buf.length <= cap) {
        parts.push(buf);
        stored += buf.length;
      } else {
        parts.push(buf.subarray(0, cap - stored));
        stored = cap;
      }
    },
    get text() { return Buffer.concat(parts).toString('utf8'); },
    get truncated() { return total > cap; },
    get bytes() { return total; },
  };
}

/** 在资源限制下运行子进程:无 shell、限时(到点 SIGKILL)、stdout/stderr 各自限额,返回结构化结果。 */
export async function runConstrainedChild({ spawn, command, args, cwd, env, timeoutMs, maxOutputBytes, abortSignal }: RunChildOptions): Promise<RunChildResult> {
  const startedAt = Date.now();
  const child = spawn(command, args, {
    cwd,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env,
  });

  const out = createCappedBuffer(maxOutputBytes);
  const err = createCappedBuffer(maxOutputBytes);
  let timedOut = false;

  child.stdout.on('data', (chunk) => out.push(chunk));
  child.stderr.on('data', (chunk) => err.push(chunk));

  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, timeoutMs);

  // 取消/超时信号到达即 SIGKILL 杀子进程——治"UI 已停止后 shell 仍在跑/写文件"。
  const onAbort = () => child.kill('SIGKILL');
  if (abortSignal) {
    if (abortSignal.aborted) onAbort();
    else abortSignal.addEventListener('abort', onAbort, { once: true });
  }

  const closed: Promise<{ code: number | null; signal: string | null }> = new Promise((resolve, reject) => {
    child.on('error', (err2) => reject(err2));
    child.on('close', (code, signal) => resolve({ code, signal }));
  });

  try {
    const { code, signal } = await closed;
    return {
      exitCode: code === null ? -1 : code,
      signal,
      stdout: out.text,
      stderr: err.text,
      timedOut,
      truncated: out.truncated || err.truncated,
      bytesStdout: out.bytes,
      bytesStderr: err.bytes,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    clearTimeout(timer);
    if (abortSignal) abortSignal.removeEventListener('abort', onAbort);
  }
}
