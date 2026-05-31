// Agent Shell 工具(host · L1 领域层):高风险命令执行入口,始终依赖审批门。

import { normalizeSandboxSpec } from '../sandbox/index.js';
import { clip } from './agent-tools-support.js';
import type { AgentTool, SandboxLike, SandboxLimits, ToolArgs } from './agent-tools-types.js';

type ShellToolOptions = {
  root: string;
  sandbox: SandboxLike;
  sandboxLimits?: SandboxLimits;
  context?: unknown;
};

/** 构造 approval-gated Shell 工具:本地后端走 OS shell,其他后端保留严格 allowlist。 */
export function createShellTool({ root, sandbox, sandboxLimits, context }: ShellToolOptions): AgentTool {
  const isLocalBackend = !sandbox.backend || sandbox.backend === 'local-subprocess';
  const isWindows = process.platform === 'win32';
  return {
    name: 'Shell',
    mutating: true,
    risk: 'high',
    description: isWindows
      ? '在工作区目录里运行一条命令(经系统 shell)。优先用 Windows/PowerShell 命令(如 Get-ChildItem、dir、type)或 node/python 脚本；返回 stdout/stderr/退出码。每条命令都需用户确认。'
      : '在隔离沙箱里运行一个命令（如 `node script.js`、`python x.py`），返回 stdout/stderr/退出码。默认无网络、cwd 限定工作区。',
    parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    handler: async (args: ToolArgs = {}) => {
      const command = String(args.command || '').trim();
      if (!command) throw new Error('command is required');
      let spec;
      if (isLocalBackend) {
        const shellSpec = isWindows
          ? { tool: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', command] }
          : { tool: 'sh', args: ['-c', command] };
        // Permit only the wrapper shell for this already approval-gated local backend path.
        const limits = { ...sandboxLimits, allowTools: [...(sandboxLimits?.allowTools || []), shellSpec.tool] };
        spec = normalizeSandboxSpec(shellSpec, limits);
      } else {
        const parts = command.split(/\s+/).filter(Boolean);
        spec = normalizeSandboxSpec({ tool: parts[0], args: parts.slice(1) }, sandboxLimits);
      }
      const result = await sandbox.exec(spec, { trustedRoot: root, context });
      return {
        exitCode: result.exitCode,
        stdout: clip(result.stdout, 4000),
        stderr: clip(result.stderr, 2000),
        timedOut: result.timedOut,
      };
    },
  };
}
