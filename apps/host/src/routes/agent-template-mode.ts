// Agent 模板锁定模式(host · L3 路由层 · routes)
// ---------------------------------------------------------------------------
// 职责:在请求入口组装模板契约、受限工具集与明确提示，阻止通用写入和子代理绕过模板。
import type { ArtifactTemplateContract } from '../artifacts/artifact-template-contract.js';
import { applyArtifactTemplateCopy, buildArtifactTemplateContracts } from '../artifacts/artifact-template-contract.js';
import type { AgentTool } from '../kimi/agent/approval-gate-types.js';

const TEMPLATE_SAFE_TOOLS = new Set([
  'Read', 'Glob', 'Grep', 'SearchWorkspace', 'SearchMemory', 'AnalyzeDataFile',
  'WebFetch', 'GitStatus', 'GitDiff', 'GitLog', 'AskUserQuestion',
]);

export function createTemplateLockedToolset<T extends { name: string }>(tools: T[], applyTool: T): T[] {
  return [...tools.filter((tool) => TEMPLATE_SAFE_TOOLS.has(tool.name)), applyTool];
}

function promptContract(contract: ArtifactTemplateContract): Record<string, unknown> {
  return {
    templatePath: contract.sourcePath,
    name: contract.name,
    kind: contract.kind,
    revisionSha256: contract.revisionSha256,
    sections: contract.sections,
    ...(contract.htmlSource === undefined ? {} : { htmlSource: contract.htmlSource }),
  };
}

export function buildTemplateLockedPrompt(prompt: string, contracts: ArtifactTemplateContract[]): string {
  return [
    '【模板锁定模式：最高优先级】',
    '用户已明确指定下列文件为版式模板。必须严格保留模板的结构、顺序、样式、布局、工作表、幻灯片和未选中内容。',
    '只能调用 ApplyArtifactTemplate 创建新副本；禁止重建文件，禁止调用任何通用写入、Shell、Skill 或子 Agent。',
    'DOCX/XLSX/PPTX 只可提交契约中存在且非只读的 targetId；HTML 只可替换可见文本，所有标签、属性、class、内联样式、style/script 内容必须原样保留。',
    '输出副本必须使用与模板相同的扩展名。若模板没有足够节点承载需求，应明确说明限制，不得擅自改版。',
    `模板契约：${JSON.stringify(contracts.map(promptContract))}`,
    `用户任务：${prompt}`,
  ].join('\n\n');
}

export function createApplyArtifactTemplateTool(options: {
  trustedRoot: string;
  context: unknown;
  contracts: ArtifactTemplateContract[];
}): AgentTool {
  return {
    name: 'ApplyArtifactTemplate',
    mutating: true,
    risk: 'write',
    description: '严格基于已锁定的用户模板创建一个新副本；Office 仅修改指定节点，HTML 仅替换文本且保持结构与样式。',
    parameters: {
      type: 'object',
      properties: {
        templatePath: { type: 'string' },
        copyName: { type: 'string' },
        changes: {
          type: 'array', minItems: 1,
          items: {
            type: 'object',
            properties: { targetId: { type: 'string' }, text: { type: 'string' } },
            required: ['targetId', 'text'],
            additionalProperties: false,
          },
        },
      },
      required: ['templatePath', 'copyName', 'changes'],
      additionalProperties: false,
    },
    handler: (args = {}) => {
      const templatePath = String(args.templatePath || '');
      const contract = options.contracts.find((candidate) => candidate.sourcePath === templatePath);
      if (!contract) throw new Error('templatePath is not one of the locked user templates');
      if (!Array.isArray(args.changes)) throw new Error('changes must be an array');
      return applyArtifactTemplateCopy({
        trustedRoot: options.trustedRoot,
        context: options.context,
        contract,
        copyName: String(args.copyName || ''),
        changes: args.changes.map((change) => {
          const item = change && typeof change === 'object' ? change as Record<string, unknown> : {};
          return { targetId: String(item.targetId || ''), text: String(item.text ?? '') };
        }),
      });
    },
  };
}

export function createAgentTemplateMode(options: {
  trustedRoot: string;
  context: unknown;
  templateFiles: string[];
  prompt: string;
}) {
  const contracts = buildArtifactTemplateContracts(options);
  const active = contracts.length > 0;
  return Object.freeze({
    active,
    prompt: active ? buildTemplateLockedPrompt(options.prompt, contracts) : options.prompt,
    lockTools(tools: AgentTool[]): AgentTool[] {
      return active
        ? createTemplateLockedToolset(tools, createApplyArtifactTemplateTool({ ...options, contracts }))
        : tools;
    },
    assertApplied(steps: Array<Record<string, unknown>>): void {
      if (active && !steps.some((step) => step.tool === 'ApplyArtifactTemplate' && step.ok === true)) {
        throw new Error('模板锁定模式未生成合规副本；原模板未被修改。');
      }
    },
  });
}
