// 钩子引擎(host · L2 运行时 · runtime)
// ---------------------------------------------------------------------------
// 职责:在 Agent 事件上触发用户配置的钩子——pre_tool(工具运行前,可 BLOCK)、post_tool 等,实现
//       「在某事发生前/后自动做某事」的可编程拦截。钩子命令经沙箱规格化执行。依赖:sandbox + node:fs/path。
import fs from 'node:fs';
import path from 'node:path';
import { normalizeSandboxSpec } from '../sandbox/index.js';
import { omitUndefined } from '../util/object.js';
import type { SandboxLimits } from '../sandbox/sandbox-spec.js';

export type HookEvent = 'pre_tool' | 'post_tool' | string;
export type HookPayload = { name?: unknown; [key: string]: unknown };
export type HookResult = { block?: boolean; reason?: string; error?: string; ok?: boolean; [key: string]: unknown };
export type HookSpec = {
  event: HookEvent;
  tool?: string;
  handler: (payload: HookPayload) => HookResult | undefined | Promise<HookResult | undefined>;
};
export type HookEngineOptions = { hooks?: HookSpec[] };
export type HookEngine = {
  run(event: HookEvent, payload?: HookPayload): Promise<HookResult[]>;
  blocked(results?: HookResult[]): HookResult | null;
  hookCount(): number;
};
export type SandboxExecResult = { exitCode: number; stdout?: string; stderr?: string };
export type SandboxLike = {
  exec(spec: unknown, options: { trustedRoot?: string; context: Record<string, unknown> }): Promise<SandboxExecResult>;
};
type RawHook = { event?: unknown; tool?: unknown; command?: unknown };
export type LoadHooksOptions = {
  trustedRoot?: string;
  sandbox?: SandboxLike | null;
  sandboxLimits?: SandboxLimits;
  configPath?: string;
};

// 工具名匹配接受正则或 * 通配;正则写错时回退到字面量比较,避免配置错误击穿钩子引擎。
function toolMatches(hook: { tool?: string }, name: unknown): boolean {
  if (!hook.tool || hook.tool === '*') return true;
  try { return new RegExp(hook.tool).test(String(name || '')); } catch { return hook.tool === name; }
}

// 创建纯内存钩子引擎;执行阶段只聚合结果,不负责读取文件或直接访问 shell。
export function createHookEngine({ hooks = [] }: HookEngineOptions = {}): HookEngine {
  const list = Array.isArray(hooks) ? hooks : [];
  return {
    async run(event, payload = {}) {
      const results: HookResult[] = [];
      for (const hook of list) {
        if (hook.event !== event) continue;
        if ((event === 'pre_tool' || event === 'post_tool') && !toolMatches(hook, payload.name)) continue;
        try {
          const r = await hook.handler(payload);
          if (r) results.push(r);
        } catch (err) {
          results.push({ error: err instanceof Error ? err.message : String(err) });
        }
      }
      return results;
    },
    blocked(results?: HookResult[]) {
      return (results || []).find((r) => r && r.block) || null;
    },
    hookCount() { return list.length; },
  };
}

// 从 <root>/.AgentCowork/hooks.json 构建钩子:
//   { "event": "pre_tool"|"post_tool", "tool": "Shell|Write", "command": "<shell cmd>" }
// pre_tool 命令非零退出即阻断工具调用;命令必须先经 sandbox 规格化,不能绕过安全边界。
export function loadHooksConfig({ trustedRoot, sandbox, sandboxLimits, configPath }: LoadHooksOptions = {}): HookEngine {
  const file = configPath || (trustedRoot ? path.join(trustedRoot, '.AgentCowork', 'hooks.json') : null);
  let raw: RawHook[] = [];
  try {
    if (file && fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
      const parsedObject = parsed && typeof parsed === 'object' ? (parsed as { hooks?: unknown }) : null;
      raw = Array.isArray(parsed) ? (parsed as RawHook[]) : (Array.isArray(parsedObject?.hooks) ? (parsedObject.hooks as RawHook[]) : []);
    }
  } catch {
    raw = [];
  }
  const hooks = raw
    .filter((h) => h && (h.event === 'pre_tool' || h.event === 'post_tool') && typeof h.command === 'string')
    .map((h) => ({
      event: h.event === 'post_tool' ? 'post_tool' : 'pre_tool',
      tool: typeof h.tool === 'string' ? h.tool : '*',
      handler: async (payload: HookPayload) => {
        if (!sandbox) return undefined;
        const command = typeof h.command === 'string' ? h.command : '';
        const parts = command.trim().split(/\s+/).filter(Boolean);
        if (!parts.length) return undefined;
        let spec;
        try { spec = normalizeSandboxSpec({ tool: parts[0], args: parts.slice(1) }, sandboxLimits); } catch { return undefined; }
        const res = await sandbox.exec(spec, omitUndefined({ trustedRoot, context: { hook: h.event, tool: payload.name } }));
        if (h.event === 'pre_tool' && res.exitCode !== 0) {
          return { block: true, reason: (res.stderr || res.stdout || `hook exit ${res.exitCode}`).slice(0, 300) };
        }
        return { ok: res.exitCode === 0 };
      },
    }));
  return createHookEngine({ hooks });
}
