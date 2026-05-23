// Shared constrained child-process runner.
//
// Both the local subprocess adapter and the VM (WSL/Docker) runner spawn a
// child the same way: no shell, argv array, hard timeout (SIGKILL), and an
// output byte cap. Centralising it here keeps that safety behaviour in one
// place and identical across backends.

const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024; // 1 MiB per stream

/**
 * A streaming, memory-bounded sink for a child stdout/stderr stream.
 *
 * The previous implementation buffered EVERY chunk into an array and only
 * truncated after the process closed — so a high-output command (`yes`,
 * `cat hugefile`, a chatty build) could exhaust the heap long before the
 * timeout fired, defeating the point of `maxOutputBytes`.
 *
 * This sink instead caps retained memory at `maxBytes` on ingestion: chunks
 * past the cap are counted (so we still know output was truncated and how many
 * bytes were produced) but discarded. We keep consuming `data` events so the
 * child's pipe drains and a *bounded* command can still finish naturally with a
 * real exit code; an *unbounded* producer is bounded in time by the SIGKILL
 * timeout. Either way memory stays O(maxBytes).
 */
export function createCappedBuffer(maxBytes) {
  const cap = Math.max(1, Number(maxBytes) || DEFAULT_MAX_OUTPUT_BYTES);
  const parts = [];
  let stored = 0; // bytes actually retained (<= cap)
  let total = 0;  // bytes seen (pre-truncation)
  return {
    push(chunk) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      total += buf.length;
      if (stored >= cap) return; // already full — count only
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

/**
 * Run a child process under resource limits.
 *
 * @param {object} opts
 * @param {Function} opts.spawn child_process.spawn-compatible function
 * @param {string} opts.command executable
 * @param {string[]} opts.args argv
 * @param {string} opts.cwd working directory
 * @param {object} opts.env environment
 * @param {number} opts.timeoutMs hard timeout
 * @param {number} opts.maxOutputBytes per-stream output cap (retained memory)
 * @returns Promise<{ exitCode, signal, stdout, stderr, timedOut, truncated, bytesStdout, bytesStderr, durationMs }>
 */
export function runConstrainedChild({ spawn, command, args, cwd, env, timeoutMs, maxOutputBytes }) {
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

  const closed = new Promise((resolve, reject) => {
    child.on('error', (err2) => reject(err2));
    child.on('close', (code, signal) => resolve({ code, signal }));
  });

  return closed
    .finally(() => clearTimeout(timer))
    .then(({ code, signal }) => ({
      exitCode: code === null ? -1 : code,
      signal,
      stdout: out.text,
      stderr: err.text,
      timedOut,
      truncated: out.truncated || err.truncated,
      bytesStdout: out.bytes,
      bytesStderr: err.bytes,
      durationMs: Date.now() - startedAt,
    }));
}
