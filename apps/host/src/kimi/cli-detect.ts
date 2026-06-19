// Kimi CLI 探测(host · L1 领域层)
// ---------------------------------------------------------------------------
// 职责:运行 `kimi --version` / `kimi info`,把输出解析成版本与线协议等元信息,
//       供主机判断本地是否装了可用的 Kimi CLI。
// 依赖:node:child_process(spawn)、./protocol-info(纯文本解析)。
// 导出:detectKimiInfo;并转出 parseKimiVersion / parseKimiInfo。
import childProcess from 'node:child_process';
import { parseKimiVersion, parseKimiInfo } from './protocol-info.js';
import type { KimiInfo } from './protocol-info.js';

export { parseKimiVersion, parseKimiInfo };

export type DetectedKimiInfo = KimiInfo & {
  command: string;
  version: string;
};
type StreamLike = {
  on(event: 'data', listener: (chunk: unknown) => void): unknown;
};
type SpawnedDetectChild = {
  stdout: StreamLike;
  stderr: StreamLike;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'close', listener: (code: number | null) => void): unknown;
};
type SpawnDetectProcess = (command: string, args: string[], options: Record<string, unknown>) => SpawnedDetectChild;

/** 无 shell 地 spawn 一个命令,收集 stdout;非零退出码或出错时 reject。 */
function runCommand(command: string, args: string[], spawn: SpawnDetectProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => {
      out += Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      err += Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Command ${command} ${args.join(' ')} failed: ${err.trim() || out.trim()}`));
        return;
      }
      resolve(out.trim());
    });
  });
}

/** 探测本地 Kimi CLI:返回命令名、版本号与 info 解析出的协议信息。 */
export async function detectKimiInfo(command = 'kimi', spawn = childProcess.spawn as SpawnDetectProcess): Promise<DetectedKimiInfo> {
  const versionOutput = await runCommand(command, ['--version'], spawn);
  const infoOutput = await runCommand(command, ['info'], spawn);
  const info = parseKimiInfo(infoOutput);
  return {
    ...info,
    command,
    version: info.version || parseKimiVersion(versionOutput),
  };
}
