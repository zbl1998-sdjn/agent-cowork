// 停止本地 MVP Host 服务并清理运行时文件(scripts · MVP生命周期)
// ---------------------------------------------------------------------------
// 职责:读取 build/mvp-runtime.json 中的 pid——文件缺失视为已停止;进程已死则
//       清理过期运行时文件;否则发送 SIGTERM 并轮询至多 5s 等待退出,成功后删除文件;
//       拒绝停止当前进程,超时未退出则抛错。运行结果以 JSON 打印。
// 用法:npm run stop:mvp(即 node scripts/run-host-node.mjs scripts/stop-mvp.ts);
//       可用 MVP_RUNTIME_FILE 指定运行时文件位置;失败即 exit 1。
// 依赖:与 start-mvp.ts 写入的运行时文件契约一致(pid 字段),配合 status-mvp.ts 使用。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

type RuntimeState = Record<string, unknown> & {
  pid?: unknown;
};

type ProcessWithKill = typeof process & {
  kill(pid: number, signal?: string | number): void;
};

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const runtimeFile = path.resolve(process.env.MVP_RUNTIME_FILE || path.join(repoRoot, 'build', 'mvp-runtime.json'));
const processWithKill = process as ProcessWithKill;

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseRuntime(value: unknown): RuntimeState {
  if (typeof value === 'object' && value != null) {
    return value as RuntimeState;
  }
  throw new Error(`Runtime file ${runtimeFile} did not contain an object`);
}

function parsePid(value: unknown): number {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return value;
  }
  throw new Error(`Runtime file ${runtimeFile} did not contain a valid pid`);
}

function isPidAlive(pid: number): boolean {
  if (pid <= 0) {
    return false;
  }
  try {
    processWithKill.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForStop(pid: number, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !isPidAlive(pid);
}

async function main(): Promise<void> {
  if (!fs.existsSync(runtimeFile)) {
    console.log(JSON.stringify({ ok: true, stopped: false, reason: 'runtime file not found', runtimeFile }, null, 2));
    return;
  }

  let runtime: RuntimeState;
  try {
    runtime = parseRuntime(JSON.parse(fs.readFileSync(runtimeFile, 'utf8')));
  } catch (error) {
    throw new Error(`Could not parse runtime file ${runtimeFile}: ${formatError(error)}`);
  }
  const pid = parsePid(runtime.pid);

  if (!isPidAlive(pid)) {
    fs.rmSync(runtimeFile, { force: true });
    console.log(JSON.stringify({ ok: true, stopped: false, reason: 'stale runtime file removed', runtimeFile, runtime }, null, 2));
    return;
  }

  if (pid === process.pid) {
    throw new Error('Refusing to stop the current process');
  }

  processWithKill.kill(pid, 'SIGTERM');
  const stopped = await waitForStop(pid);
  if (!stopped) {
    throw new Error(`Timed out waiting for Agent Cowork MVP process to stop: ${pid}`);
  }

  if (fs.existsSync(runtimeFile)) {
    fs.rmSync(runtimeFile, { force: true });
  }
  console.log(JSON.stringify({ ok: true, stopped: true, runtimeFile, runtime }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
