// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { normalizeSandboxSpec } from '../sandbox/index.js';

// Hook engine (Claude Code / Kimi CLI style). Hooks fire on agent events:
//   - pre_tool  : before a tool runs; a hook may BLOCK it ({ block:true, reason })
//   - post_tool : after a tool runs (observe / log)
// Hooks match by tool name (regex string, or '*' for all). Handlers are async
// functions; loadHooksConfig builds shell-command hooks from .AgentCowork/hooks.json.

/**
 * @typedef {'pre_tool' | 'post_tool' | string} HookEvent
 * @typedef {{ name?: unknown, [key: string]: unknown }} HookPayload
 * @typedef {{ block?: boolean, reason?: string, error?: string, ok?: boolean, [key: string]: unknown }} HookResult
 * @typedef {{ event: HookEvent, tool?: string, handler: (payload: HookPayload) => HookResult | undefined | Promise<HookResult | undefined> }} HookSpec
 * @typedef {{ hooks?: HookSpec[] }} HookEngineOptions
 * @typedef {{ run(event: HookEvent, payload?: HookPayload): Promise<HookResult[]>, blocked(results?: HookResult[]): HookResult | null, hookCount(): number }} HookEngine
 * @typedef {import('../sandbox/sandbox-spec.js').SandboxLimits} SandboxLimits
 * @typedef {{ exec(spec: unknown, options: { trustedRoot?: string, context: Record<string, unknown> }): Promise<{ exitCode: number, stdout?: string, stderr?: string }> }} SandboxLike
 * @typedef {{ event?: unknown, tool?: unknown, command?: unknown }} RawHook
 * @typedef {{ trustedRoot?: string, sandbox?: SandboxLike | null, sandboxLimits?: SandboxLimits, configPath?: string }} LoadHooksOptions
 */

/** @param {{ tool?: string }} hook @param {unknown} name */
function toolMatches(hook, name) {
  if (!hook.tool || hook.tool === '*') return true;
  try { return new RegExp(hook.tool).test(String(name || '')); } catch { return hook.tool === name; }
}

/** @param {HookEngineOptions} [options] @returns {HookEngine} */
export function createHookEngine({ hooks = [] } = {}) {
  const list = Array.isArray(hooks) ? hooks : [];
  return {
    /** @param {HookEvent} event @param {HookPayload} [payload] */
    async run(event, payload = {}) {
      /** @type {HookResult[]} */
      const results = [];
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
    /** @param {HookResult[]} [results] */
    blocked(results) {
      return (results || []).find((r) => r && r.block) || null;
    },
    hookCount() { return list.length; },
  };
}

// Build a hook engine from <root>/.AgentCowork/hooks.json. Each entry:
//   { "event": "pre_tool"|"post_tool", "tool": "Shell|Write", "command": "<shell cmd>" }
// A pre_tool hook whose command exits non-zero BLOCKS the tool.
/** @param {LoadHooksOptions} [options] @returns {HookEngine} */
export function loadHooksConfig({ trustedRoot, sandbox, sandboxLimits, configPath } = {}) {
  const file = configPath || (trustedRoot ? path.join(trustedRoot, '.AgentCowork', 'hooks.json') : null);
  /** @type {RawHook[]} */
  let raw = [];
  try {
    if (file && fs.existsSync(file)) {
      const parsed = /** @type {unknown} */ (JSON.parse(fs.readFileSync(file, 'utf8')));
      const parsedObject = parsed && typeof parsed === 'object' ? /** @type {{ hooks?: unknown }} */ (parsed) : null;
      raw = Array.isArray(parsed) ? /** @type {RawHook[]} */ (parsed) : (Array.isArray(parsedObject?.hooks) ? /** @type {RawHook[]} */ (parsedObject.hooks) : []);
    }
  } catch {
    raw = [];
  }
  const hooks = raw
    .filter((h) => h && (h.event === 'pre_tool' || h.event === 'post_tool') && typeof h.command === 'string')
    .map((h) => ({
      event: h.event === 'post_tool' ? 'post_tool' : 'pre_tool',
      tool: typeof h.tool === 'string' ? h.tool : '*',
      handler: async (/** @type {HookPayload} */ payload) => {
        if (!sandbox) return undefined;
        const command = typeof h.command === 'string' ? h.command : '';
        const parts = command.trim().split(/\s+/).filter(Boolean);
        if (!parts.length) return undefined;
        let spec;
        try { spec = normalizeSandboxSpec({ tool: parts[0], args: parts.slice(1) }, sandboxLimits); } catch { return undefined; }
        const res = await sandbox.exec(spec, { trustedRoot, context: { hook: h.event, tool: payload.name } });
        if (h.event === 'pre_tool' && res.exitCode !== 0) {
          return { block: true, reason: (res.stderr || res.stdout || `hook exit ${res.exitCode}`).slice(0, 300) };
        }
        return { ok: res.exitCode === 0 };
      },
    }));
  return createHookEngine({ hooks });
}
