// @ts-check
// Kimi CLI 探测(host · L1 领域层)
// ---------------------------------------------------------------------------
// 职责:运行 `kimi --version` / `kimi info`,把输出解析成版本与线协议等元信息,
//       供主机判断本地是否装了可用的 Kimi CLI。
// 依赖:node:child_process(spawn)、./protocol-info(纯文本解析)。
// 导出:detectKimiInfo;并转出 parseKimiVersion / parseKimiInfo。
import childProcess from 'node:child_process';
import { parseKimiVersion, parseKimiInfo } from './protocol-info.js';

export { parseKimiVersion, parseKimiInfo };

/** 无 shell 地 spawn 一个命令,收集 stdout;非零退出码或出错时 reject。 @param {string} command @param {string[]} args @returns {Promise<string>} */
function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(command, args, {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => {
      out += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      err += chunk.toString();
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

/** 探测本地 Kimi CLI:返回命令名、版本号与 info 解析出的协议信息。 @param {string} [command] */
export async function detectKimiInfo(command = 'kimi') {
  const versionOutput = await runCommand(command, ['--version']);
  const infoOutput = await runCommand(command, ['info']);
  return {
    command,
    version: parseKimiVersion(versionOutput),
    ...parseKimiInfo(infoOutput),
  };
}
