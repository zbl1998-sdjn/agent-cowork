// @ts-check
import childProcess from 'node:child_process';
import { parseKimiVersion, parseKimiInfo } from './protocol-info.js';

export { parseKimiVersion, parseKimiInfo };

/** @param {string} command @param {string[]} args @returns {Promise<string>} */
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

/** @param {string} [command] */
export async function detectKimiInfo(command = 'kimi') {
  const versionOutput = await runCommand(command, ['--version']);
  const infoOutput = await runCommand(command, ['info']);
  return {
    command,
    version: parseKimiVersion(versionOutput),
    ...parseKimiInfo(infoOutput),
  };
}
