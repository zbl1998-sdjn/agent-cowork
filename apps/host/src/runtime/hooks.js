import fs from 'node:fs';
import path from 'node:path';
import { normalizeSandboxSpec } from '../sandbox/index.js';

// Hook engine (Claude Code / Kimi CLI style). Hooks fire on agent events:
//   - pre_tool  : before a tool runs; a hook may BLOCK it ({ block:true, reason })
//   - post_tool : after a tool runs (observe / log)
// Hooks match by tool name (regex string, or '*' for all). Handlers are async
// functions; loadHooksConfig builds shell-command hooks from .KimiCowork/hooks.json.

function toolMatches(hook, name) {
  if (!hook.tool || hook.tool === '*') return true;
  try { return new RegExp(hook.tool).test(String(name || '')); } catch { return hook.tool === name; }
}

export function createHookEngine({ hooks = [] } = {}) {
  const list = Array.isArray(hooks) ? hooks : [];
  return {
    async run(event, payload = {}) {
      const results = [];
      for (const hook of list) {
        if (hook.event !== event) continue;
        if ((event === 'pre_tool' || event === 'post_tool') && !toolMatches(hook, payload.name)) continue;
        try {
          const r = await hook.handler(payload);
          if (r) results.push(r);
        } catch (err) {
          results.push({ error: err.message });
        }
      }
      return results;
    },
    blocked(results) {
      return (results || []).find((r) => r && r.block) || null;
    },
    hookCount() { return list.length; },
  };
}

// Build a hook engine from <root>/.KimiCowork/hooks.json. Each entry:
//   { "event": "pre_tool"|"post_tool", "tool": "Shell|Write", "command": "<shell cmd>" }
// A pre_tool hook whose command exits non-zero BLOCKS the tool.
export function loadHooksConfig({ trustedRoot, sandbox, sandboxLimits, configPath } = {}) {
  const file = configPath || (trustedRoot ? path.join(trustedRoot, '.KimiCowork', 'hooks.json') : null);
  let raw = [];
  try {
    if (file && fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      raw = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.hooks) ? parsed.hooks : []);
    }
  } catch {
    raw = [];
  }
  const hooks = raw
    .filter((h) => h && (h.event === 'pre_tool' || h.event === 'post_tool') && typeof h.command === 'string')
    .map((h) => ({
      event: h.event,
      tool: h.tool || '*',
      handler: async (payload) => {
        if (!sandbox) return undefined;
        const parts = String(h.command).trim().split(/\s+/).filter(Boolean);
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
