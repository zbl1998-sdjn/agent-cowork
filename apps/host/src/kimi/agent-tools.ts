// Agent 原生工具集定义:Read/Write/Edit/Glob/Grep/Shell/WebFetch/Git 等(host · L1 领域层)
// ---------------------------------------------------------------------------
// 职责:构造与 Kimi CLI / Claude Code 对齐的工具清单;写类工具标 mutating:true 以便
//       Agent 循环走审批门;所有文件路径都被 jail 到可信工作区根。
import fs from 'node:fs';
import path from 'node:path';
import { assertExternalWorkspaceRoot } from '../security/external-workspace-boundary.js';
import { assertTrustedPath } from '../security/path-policy.js';
import { readTextFile } from '../workspace/file-reader.js';
import { searchWorkspaceIndex } from '../workspace/index/search.js';
import { recallRelevantKnowledge } from '../memory/knowledge-recall.js';
import { planFileOrganization } from '../workspace/file-organizer.js';
import { webFetch, type WebFetchLike } from '../tools/web-fetch.js';
import { createGitCommitTool, createGitDiffTool, createGitLogTool, createGitStatusTool } from '../tools/dev/git.js';
import { analyzeDataFile } from '../tools/data/report.js';
import { createDataChartArtifact } from '../tools/data/artifact.js';
import { parseBuiltinToolArgs } from '../tools/builtin-tool-options.js';
import { createArtifactAccessGuards } from '../artifacts/artifact-access-guards.js';
import { createShellTool } from './agent-tools-shell.js';
import { clip, globToRegExp, walkFiles } from './agent-tools-support.js';
import { omitUndefined } from '../util/object.js';
import { decideEgressPolicy, enforceRecordedEgressDecision } from '../security/egress-gateway.js';
import type { AgentTool, AgentToolsContext } from './agent-tools-types.js';

export type { AgentTool, AgentToolsContext, SandboxLike, SandboxLimits, ToolArgs } from './agent-tools-types.js';

const DATA_FILE_ARGS = ['path', 'maxRows', 'maxBytes'] as const; const DATA_CHART_ARGS = ['path', 'title', 'id', 'maxRows', 'maxBytes'] as const;

/** 按给定上下文(可信根、沙箱、限额)构造该工作区的 Agent 工具数组。 */
export function createAgentTools(ctx: AgentToolsContext = {}): AgentTool[] {
  const { trustedRoot, sandbox, sandboxLimits, context, fetchImpl } = ctx;
  if (typeof trustedRoot !== 'string' || !trustedRoot) throw new Error('trustedRoot is required');
  const root = assertTrustedPath(assertExternalWorkspaceRoot(path.resolve(trustedRoot)), path.resolve(trustedRoot));
  const artifactAccess = createArtifactAccessGuards(root, context);
  // 不要 path.join(root, rel):rel 可能是「root 内的绝对路径」(模型常这么给),
  // path.join 会把它当相对段拼成 <root>\<root>\… → mkdir ENOENT。assert* 内部已用
  // resolveWithinRoot 正确处理绝对/相对,并由 isInside 守住越界,故直接传原值。
  const gitStatusTool = createGitStatusTool();
  const gitDiffTool = createGitDiffTool();
  const gitLogTool = createGitLogTool();
  const tools: AgentTool[] = [
    {
      name: 'Read', mutating: false, risk: 'safe',
      description: '读取工作区内一个文本文件的内容。',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      handler: async (args = {}) => {
        const target = artifactAccess.readPath(args.path);
        const file = readTextFile(target, { trustedRoot: root });
        return { path: args.path, size: file.size, content: clip(file.content) };
      },
    },
    {
      name: 'Write', mutating: true, risk: 'write',
      description: '写入/覆盖工作区内一个文件（自动创建目录）。',
      parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
      handler: async (args = {}) => {
        if (!args.path) throw new Error('path is required');
        const content = String(args.content ?? '');
        const { path: target, preparation } = artifactAccess.prepareWrite(args.path, content);
        try {
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, content, 'utf8');
        } catch (error) {
          preparation?.abort();
          throw error;
        }
        return { ok: true, path: args.path, bytes: Buffer.byteLength(content) };
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
        const target = artifactAccess.readPath(args.path);
        const original = fs.readFileSync(target, 'utf8');
        const oldStr = String(args.old_string ?? '');
        if (!oldStr || !original.includes(oldStr)) throw new Error('old_string not found in file');
        const next = args.replace_all
          ? original.split(oldStr).join(String(args.new_string ?? ''))
          : original.replace(oldStr, String(args.new_string ?? ''));
        const { preparation } = artifactAccess.prepareWrite(target, next);
        try {
          fs.writeFileSync(target, next, 'utf8');
        } catch (error) {
          preparation?.abort();
          throw error;
        }
        return { ok: true, path: args.path, replacements: args.replace_all ? original.split(oldStr).length - 1 : 1 };
      },
    },
    {
      name: 'Glob', mutating: false, risk: 'safe',
      description: '按 glob 模式列出工作区内匹配的文件（如 **/*.md）。',
      parameters: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] },
      handler: async (args = {}) => {
        const all: string[] = [];
        walkFiles(root, root, all, 2000, artifactAccess.includeEntry);
        const re = globToRegExp(args.pattern || '**/*');
        return { pattern: args.pattern, matches: all.filter((p) => re.test(p)).slice(0, 200) };
      },
    },
    {
      name: 'Grep', mutating: false, risk: 'safe',
      description: '在工作区文件内容中搜索正则模式，返回命中的文件与行。',
      parameters: { type: 'object', properties: { pattern: { type: 'string' }, glob: { type: 'string' }, maxResults: { type: 'number' } }, required: ['pattern'] },
      handler: async (args = {}) => {
        const files: string[] = [];
        walkFiles(root, root, files, 2000, artifactAccess.includeEntry);
        const fileRe = args.glob ? globToRegExp(args.glob) : null;
        let re: RegExp;
        try { re = new RegExp(String(args.pattern || ''), 'i'); } catch { throw new Error('invalid regex pattern'); }
        const limit = Math.min(Number(args.maxResults) || 50, 200);
        const hits: Array<{ file: string; line: number; text: string }> = [];
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
            const lineText = lines[i] ?? '';
            if (re.test(lineText)) hits.push({ file: rel, line: i + 1, text: lineText.slice(0, 200) });
          }
        }
        return { pattern: args.pattern, hits };
      },
    },
    {
      name: 'SearchWorkspace', mutating: false, risk: 'safe',
      description: '在工作区内做本地关键词/RAG 检索，返回相关文本块、来源文件和行号。适合回答“在我的资料里找/根据项目资料回答”。',
      parameters: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] },
      handler: async (args = {}) => searchWorkspaceIndex({
        root,
        query: args.query,
        limit: args.limit,
        includeFile: (fullPath: string) => artifactAccess.includeEntry(fullPath, 'file'),
      }),
    },
    {
      name: 'SearchMemory', mutating: false, risk: 'safe',
      description: '在你的长期记忆(由过往对话提炼的主题知识)里检索相关条目。适合回答“我之前说过/你还记得…吗/根据我以前告诉你的”。返回主题、标题、内容与来源对话。',
      parameters: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] },
      handler: async (args = {}) => {
        const memoryContext = context && typeof context === 'object'
          ? context as { tenantId?: unknown; userId?: unknown }
          : {};
        const items = recallRelevantKnowledge(
          root,
          String(args.query || ''),
          omitUndefined({ limit: Number(args.limit) || undefined, context: memoryContext }),
        );
        return {
          items: items.map((it) => ({
            topic: it.topic, title: it.title, content: it.content,
            confidence: it.confidence, source: it.provenance?.sourceConversationId || '',
          })),
        };
      },
    },
    {
      name: 'PlanFileOrganization', mutating: false, risk: 'safe',
      description: '为批量整理/改名/去重生成文件操作预览；不会直接移动文件，实际执行必须交给审批后的文件操作。mode: byExtension/rename/dedupe。',
      parameters: {
        type: 'object',
        properties: { files: { type: 'array', items: { type: 'string' } }, mode: { type: 'string' }, targetDir: { type: 'string' }, renamePrefix: { type: 'string' } },
        required: ['files'],
        additionalProperties: false,
      },
      handler: async (args = {}) => {
        artifactAccess.inspectFiles(args.files);
        return planFileOrganization(omitUndefined({
          trustedRoot: root,
          files: args.files as string[] | undefined,
          mode: args.mode as string | undefined,
          targetDir: args.targetDir as string | undefined,
          renamePrefix: args.renamePrefix as string | undefined,
        }));
      },
    },
    {
      name: 'AnalyzeDataFile', mutating: false, risk: 'safe',
      description: '分析工作区内 CSV/TSV/XLSX 数据文件，返回列统计、图表数据和 Markdown 报告草稿；不会修改文件。',
      parameters: { type: 'object', properties: { path: { type: 'string' }, maxRows: { type: 'number' }, maxBytes: { type: 'number' } }, required: ['path'], additionalProperties: false },
      handler: async (rawArgs = {}) => {
        const args = parseBuiltinToolArgs(rawArgs, DATA_FILE_ARGS);
        const sourcePath = artifactAccess.readPath(args.path);
        return analyzeDataFile(omitUndefined({ ...args, path: sourcePath, trustedRoot: root }));
      },
    },
    {
      name: 'CreateDataChartArtifact', mutating: true, risk: 'high', requiresApproval: true,
      description: '分析工作区内 CSV/TSV/XLSX 数据文件，并把推荐图表保存为 .AgentCowork/artifacts 活页 artifact。需要用户审批。',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, title: { type: 'string' }, id: { type: 'string' }, maxRows: { type: 'number' }, maxBytes: { type: 'number' } },
        required: ['path'],
        additionalProperties: false,
      },
      handler: async (rawArgs = {}) => {
        const args = parseBuiltinToolArgs(rawArgs, DATA_CHART_ARGS);
        const sourcePath = artifactAccess.readPath(args.path);
        return createDataChartArtifact({
          ...args,
          path: sourcePath,
          trustedRoot: root,
          context: artifactAccess.owner,
        });
      },
    },
    {
      name: 'WebFetch', mutating: false, risk: 'high', requiresApproval: true,
      description: '抓取一个 http(s) 网址的文本内容（联网检索）。',
      parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
      // 出站前置检查:与 tools/web-builtin-tools.ts 的 web.fetch 同一道 L0 出站网关
      // (decideEgressPolicy, kind='web_fetch')。这是同一类问题的第二处实现:此前
      // 这份原生 WebFetch 完全绕过网关,不受 air_gap/local_strict「零外发」约束,也不
      // 写出站审计——dogfood 全量安全审计发现(2026-07-08)。非 allow(包括
      // needs_approval)一律抛错；本层没有审批回执消费接口，不能静默放行。
      handler: async (args = {}) => {
        const destination = args.url;
        const securityMode = context && typeof context === 'object'
          ? (context as { securityMode?: unknown }).securityMode
          : undefined;
        const egress = decideEgressPolicy({ kind: 'web_fetch', destination, securityMode, trustedRoot: root });
        enforceRecordedEgressDecision(root, egress);
        const r = await webFetch(omitUndefined({ url: destination, fetchImpl: fetchImpl as WebFetchLike | undefined }));
        return { status: r.status, contentType: r.contentType, text: clip(r.text) };
      },
    },
    { ...gitStatusTool, name: 'GitStatus', mutating: false, risk: 'safe', parameters: gitStatusTool.inputSchema },
    { ...gitDiffTool, name: 'GitDiff', mutating: false, risk: 'safe', parameters: gitDiffTool.inputSchema },
    { ...gitLogTool, name: 'GitLog', mutating: false, risk: 'safe', parameters: gitLogTool.inputSchema },
    createGitCommitTool(),
  ];

  if (sandbox) {
    tools.push(createShellTool(omitUndefined({ root, sandbox, sandboxLimits, context: ctx.context })));
  }
  return tools;
}
