// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { assertTrustedPath, assertTrustedPathForCreate } from '../security/path-policy.js';
import { readTextFile } from '../workspace/file-reader.js';
import { searchWorkspaceIndex } from '../workspace/index/search.js';
import { planFileOrganization } from '../workspace/file-organizer.js';
import { normalizeSandboxSpec } from '../sandbox/index.js';
import { webFetch } from '../tools/web-fetch.js';
import { createGitCommitTool, createGitDiffTool, createGitLogTool, createGitStatusTool } from '../tools/dev/git.js';
import { analyzeDataFile } from '../tools/data/report.js';
import { clip, globToRegExp, walkFiles } from './agent-tools-support.js';

// Agent tools aligned with the Kimi CLI / Claude Code native tool set:
//   Read, Write, Edit, Glob, Grep, Shell, WebFetch, git helpers.
// Mutating tools (Write/Edit/Shell) carry `mutating: true` so the agent loop
// can gate them behind an approval prompt. All file paths are jailed to the
// trusted workspace root.

/**
 * @typedef {Record<string, unknown>} ToolArgs
 * @typedef {{ allowTools?: string[] }} SandboxLimits
 * @typedef {{ backend?: string, exec(spec: unknown, options: { trustedRoot: string, context?: unknown }): Promise<{ exitCode?: unknown, stdout?: unknown, stderr?: unknown, timedOut?: unknown }> }} SandboxLike
 * @typedef {{ trustedRoot?: string, sandbox?: SandboxLike, sandboxLimits?: SandboxLimits, context?: unknown }} AgentToolsContext
 * @typedef {{ name: string, mutating?: boolean, risk?: string, description?: string, parameters?: unknown, inputSchema?: unknown, handler?: (args?: ToolArgs) => unknown | Promise<unknown> }} AgentTool
 */

/** @param {AgentToolsContext} [ctx] @returns {AgentTool[]} */
export function createAgentTools(ctx = {}) {
  const { trustedRoot, sandbox, sandboxLimits } = ctx;
  if (typeof trustedRoot !== 'string' || !trustedRoot) throw new Error('trustedRoot is required');
  const root = assertTrustedPath(path.resolve(trustedRoot), path.resolve(trustedRoot));
  /** @param {unknown} rel */
  const within = (rel) => assertTrustedPath(path.join(root, String(rel || '')), root);
  // Create-aware variant for write targets that may not exist yet (defeats
  // junction/symlink parent escape on brand-new files).
  /** @param {unknown} rel */
  const withinForCreate = (rel) => assertTrustedPathForCreate(path.join(root, String(rel || '')), root);

  /** @type {AgentTool[]} */
  const tools = [
    {
      name: 'Read', mutating: false, risk: 'safe',
      description: '读取工作区内一个文本文件的内容。',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      handler: async (args = {}) => {
        const file = readTextFile(within(args.path), { trustedRoot: root });
        return { path: args.path, size: file.size, content: clip(file.content) };
      },
    },
    {
      name: 'Write', mutating: true, risk: 'write',
      description: '写入/覆盖工作区内一个文件（自动创建目录）。',
      parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
      handler: async (args = {}) => {
        if (!args.path) throw new Error('path is required');
        const target = withinForCreate(args.path);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, String(args.content ?? ''), 'utf8');
        return { ok: true, path: args.path, bytes: Buffer.byteLength(String(args.content ?? '')) };
      },
    },
    {
      name: 'Edit', mutating: true, risk: 'write',
      description: '在工作区文件中把 old_string 精确替换为 new_string（默认替换第一处，replace_all=true 替换全部）。',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' }, replace_all: { type: 'boolean' } },
        required: ['path', 'old_string', 'new_string'],
      },
      handler: async (args = {}) => {
        const target = within(args.path);
        const original = fs.readFileSync(target, 'utf8');
        const oldStr = String(args.old_string ?? '');
        if (!oldStr || !original.includes(oldStr)) throw new Error('old_string not found in file');
        const next = args.replace_all
          ? original.split(oldStr).join(String(args.new_string ?? ''))
          : original.replace(oldStr, String(args.new_string ?? ''));
        fs.writeFileSync(target, next, 'utf8');
        return { ok: true, path: args.path, replacements: args.replace_all ? original.split(oldStr).length - 1 : 1 };
      },
    },
    {
      name: 'Glob', mutating: false, risk: 'safe',
      description: '按 glob 模式列出工作区内匹配的文件（如 **/*.md）。',
      parameters: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] },
      handler: async (args = {}) => {
        /** @type {string[]} */
        const all = [];
        walkFiles(root, root, all, 2000);
        const re = globToRegExp(args.pattern || '**/*');
        return { pattern: args.pattern, matches: all.filter((p) => re.test(p)).slice(0, 200) };
      },
    },
    {
      name: 'Grep', mutating: false, risk: 'safe',
      description: '在工作区文件内容中搜索正则模式，返回命中的文件与行。',
      parameters: { type: 'object', properties: { pattern: { type: 'string' }, glob: { type: 'string' }, maxResults: { type: 'number' } }, required: ['pattern'] },
      handler: async (args = {}) => {
        /** @type {string[]} */
        const files = [];
        walkFiles(root, root, files, 2000);
        const fileRe = args.glob ? globToRegExp(args.glob) : null;
        /** @type {RegExp} */
        let re;
        try { re = new RegExp(String(args.pattern || ''), 'i'); } catch { throw new Error('invalid regex pattern'); }
        const limit = Math.min(Number(args.maxResults) || 50, 200);
        /** @type {Array<{ file: string, line: number, text: string }>} */
        const hits = [];
        for (const rel of files) {
          if (hits.length >= limit) break;
          if (fileRe && !fileRe.test(rel)) continue;
          let text;
          try {
            text = readTextFile(path.join(root, rel), { trustedRoot: root }).content;
          } catch {
            continue;
          }
          const lines = text.split('\n');
          for (let i = 0; i < lines.length && hits.length < limit; i += 1) {
            if (re.test(lines[i])) hits.push({ file: rel, line: i + 1, text: lines[i].slice(0, 200) });
          }
        }
        return { pattern: args.pattern, hits };
      },
    },
    {
      name: 'SearchWorkspace', mutating: false, risk: 'safe',
      description: '在工作区内做本地关键词/RAG 检索，返回相关文本块、来源文件和行号。适合回答“在我的资料里找/根据项目资料回答”。',
      parameters: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] },
      handler: async (args = {}) => searchWorkspaceIndex({ root, query: args.query, limit: args.limit }),
    },
    {
      name: 'PlanFileOrganization', mutating: false, risk: 'safe',
      description: '为批量整理/改名/去重生成文件操作预览；不会直接移动文件，实际执行必须交给审批后的文件操作。mode: byExtension/rename/dedupe。',
      parameters: {
        type: 'object',
        properties: {
          files: { type: 'array', items: { type: 'string' } },
          mode: { type: 'string' },
          targetDir: { type: 'string' },
          renamePrefix: { type: 'string' },
        },
        required: ['files'],
      },
      handler: async (args = {}) => planFileOrganization({ trustedRoot: root, ...args }),
    },
    {
      name: 'AnalyzeDataFile', mutating: false, risk: 'safe',
      description: '分析工作区内 CSV/TSV 数据文件，返回列统计、图表数据和 Markdown 报告草稿；不会修改文件。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          maxRows: { type: 'number' },
          maxBytes: { type: 'number' },
        },
        required: ['path'],
      },
      handler: async (args = {}) => analyzeDataFile({ trustedRoot: root, ...args }),
    },
    {
      name: 'WebFetch', mutating: false, risk: 'safe',
      description: '抓取一个 http(s) 网址的文本内容（联网检索）。',
      parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
      handler: async (args = {}) => {
        const r = await webFetch({ url: args.url });
        return { status: r.status, contentType: r.contentType, text: clip(r.text) };
      },
    },
    {
      ...createGitStatusTool(),
      name: 'GitStatus',
      mutating: false,
      risk: 'safe',
      parameters: createGitStatusTool().inputSchema,
    },
    {
      ...createGitDiffTool(),
      name: 'GitDiff',
      mutating: false,
      risk: 'safe',
      parameters: createGitDiffTool().inputSchema,
    },
    {
      ...createGitLogTool(),
      name: 'GitLog',
      mutating: false,
      risk: 'safe',
      parameters: createGitLogTool().inputSchema,
    },
    createGitCommitTool(),
  ];

  if (sandbox) {
    // On the local desktop backend, run the (user-approved) command through the
    // OS shell so ordinary commands work — Windows: PowerShell, POSIX: `sh -c`.
    // `cmd /s /c` drops stdout for quoted inline scripts such as `node -e "..."`.
    // The structured allowlist still guards VM/server backends. Shell stays
    // risk:'high' — every command is approval-gated and the cwd is jailed to the
    // workspace root.
    const isLocalBackend = !sandbox.backend || sandbox.backend === 'local-subprocess';
    const isWindows = process.platform === 'win32';
    tools.push({
      name: 'Shell', mutating: true, risk: 'high',
      description: isWindows
        ? '在工作区目录里运行一条命令(经系统 shell)。优先用 Windows/PowerShell 命令(如 Get-ChildItem、dir、type)或 node/python 脚本；返回 stdout/stderr/退出码。每条命令都需用户确认。'
        : '在隔离沙箱里运行一个命令（如 `node script.js`、`python x.py`），返回 stdout/stderr/退出码。默认无网络、cwd 限定工作区。',
      parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
      handler: async (args = {}) => {
        const command = String(args.command || '').trim();
        if (!command) throw new Error('command is required');
        let spec;
        if (isLocalBackend) {
          const shellSpec = isWindows
            ? { tool: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', command] }
            : { tool: 'sh', args: ['-c', command] };
          // Permit the OS shell binary for this approval-gated wrapper; other
          // backends keep their strict tool allowlist unchanged.
          const limits = { ...sandboxLimits, allowTools: [...((sandboxLimits && sandboxLimits.allowTools) || []), shellSpec.tool] };
          spec = normalizeSandboxSpec(shellSpec, limits);
        } else {
          const parts = command.split(/\s+/).filter(Boolean);
          spec = normalizeSandboxSpec({ tool: parts[0], args: parts.slice(1) }, sandboxLimits);
        }
        const result = await sandbox.exec(spec, { trustedRoot: root, context: ctx.context });
        return { exitCode: result.exitCode, stdout: clip(result.stdout, 4000), stderr: clip(result.stderr, 2000), timedOut: result.timedOut };
      },
    });
  }

  return tools;
}
