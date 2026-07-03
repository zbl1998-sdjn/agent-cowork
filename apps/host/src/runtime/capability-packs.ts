// 能力包目录(host · L2 运行时)
// ---------------------------------------------------------------------------
// 职责:把已有运行时依赖目录提升成 2.1 的 Capability/Role Pack 视图,用于推荐、
//       install plan 预检与 UI 展示。这里只生成可审查计划,不下载、不安装。
import { buildRuntimeDependencyInstallPlan } from './dependency-install-plan.js';
import { RUNTIME_DEPENDENCY_CATALOG } from './dependencies-catalog.js';
import type { RuntimeDependencyInstallPlanOptions } from './dependency-install-plan-types.js';

export type CapabilityPackCategory = 'capability' | 'role' | 'connector' | 'model' | 'design';
export type CapabilityPack = {
  schemaVersion: 'agent-cowork.pack.v1';
  id: string;
  name: string;
  version: string;
  description: string;
  category: CapabilityPackCategory;
  publisher: string;
  license: string;
  capabilities: string[];
  dependencyIds: string[];
  requiredPackIds: string[];
  recommendedForRoles: string[];
  permissions: Array<{ kind: string; scope: string; reason: string; default: 'deny' | 'ask' | 'allow' }>;
  installMode: 'bundled' | 'plan-only';
  security: {
    signed: boolean;
    sandboxRequired: boolean;
    networkDuringRuntime: 'none' | 'ask' | 'required';
  };
};

export type CapabilityRecommendation = CapabilityPack & {
  reason: string;
  missingDependencyIds: string[];
};

const PACKS: readonly CapabilityPack[] = Object.freeze([
  {
    schemaVersion: 'agent-cowork.pack.v1',
    id: 'core-text-pack',
    name: 'Core Text Pack',
    version: '0.1.0',
    description: 'Markdown、TXT、JSON、CSV 等基础本地文本处理能力,随主包可用。',
    category: 'capability',
    publisher: 'Agent Cowork',
    license: 'internal',
    capabilities: ['text.read', 'markdown.write', 'json.read', 'csv.read'],
    dependencyIds: ['node', 'sqlite'],
    requiredPackIds: [],
    recommendedForRoles: ['developer', 'pm', 'legal', 'finance', 'hr', 'sales', 'design'],
    permissions: [{ kind: 'filesystem', scope: 'trustedRoot', reason: '读取和写入用户批准的工作区文件。', default: 'ask' }],
    installMode: 'bundled',
    security: { signed: true, sandboxRequired: false, networkDuringRuntime: 'none' },
  },
  {
    schemaVersion: 'agent-cowork.pack.v1',
    id: 'browser-automation-pack',
    name: 'Browser Automation Pack',
    version: '0.1.0',
    description: '按需补齐 Chromium 截图、网页交互 smoke 与前端视觉验收能力。',
    category: 'capability',
    publisher: 'Agent Cowork',
    license: 'internal',
    capabilities: ['browser.screenshot', 'web.smoke', 'ui.visual-check'],
    dependencyIds: ['playwright-chromium'],
    requiredPackIds: [],
    recommendedForRoles: ['developer', 'design', 'pm'],
    permissions: [{ kind: 'shell', scope: 'local-browser', reason: '启动本地浏览器执行截图和 smoke。', default: 'ask' }],
    installMode: 'plan-only',
    security: { signed: false, sandboxRequired: false, networkDuringRuntime: 'ask' },
  },
  {
    schemaVersion: 'agent-cowork.pack.v1',
    id: 'frontend-design-pack',
    name: 'Frontend Design Pack',
    version: '0.1.0',
    description: '前端 UI 编码的 design brief、组件扫描、静态审查与可选截图验收。',
    category: 'design',
    publisher: 'Agent Cowork',
    license: 'internal',
    capabilities: ['design.brief', 'design.static-review', 'design.visual-smoke'],
    dependencyIds: ['playwright-chromium'],
    requiredPackIds: ['browser-automation-pack'],
    recommendedForRoles: ['developer', 'design'],
    permissions: [
      { kind: 'filesystem', scope: 'trustedRoot', reason: '读取组件和样式以生成设计上下文。', default: 'ask' },
      { kind: 'shell', scope: 'local-browser', reason: '可选启动本地浏览器生成截图。', default: 'ask' },
    ],
    installMode: 'plan-only',
    security: { signed: false, sandboxRequired: false, networkDuringRuntime: 'ask' },
  },
  {
    schemaVersion: 'agent-cowork.pack.v1',
    id: 'pdf-ocr-pack',
    name: 'PDF OCR Pack',
    version: '0.1.0',
    description: '扫描件 PDF 和图片文字识别能力;缺失时应降级为文本页摘要。',
    category: 'capability',
    publisher: 'Agent Cowork',
    license: 'internal',
    capabilities: ['pdf.read', 'ocr.scan'],
    dependencyIds: ['tesseract-ocr', 'pandoc'],
    requiredPackIds: [],
    recommendedForRoles: ['legal', 'finance', 'hr', 'pm'],
    permissions: [{ kind: 'filesystem', scope: 'trustedRoot', reason: '读取用户选择的 PDF/图片文件。', default: 'ask' }],
    installMode: 'plan-only',
    security: { signed: false, sandboxRequired: false, networkDuringRuntime: 'none' },
  },
  {
    schemaVersion: 'agent-cowork.pack.v1',
    id: 'data-analysis-pack',
    name: 'Data Analysis Pack',
    version: '0.1.0',
    description: 'CSV、Excel、统计和本地数据分析增强能力。',
    category: 'capability',
    publisher: 'Agent Cowork',
    license: 'internal',
    capabilities: ['data.profile', 'data.analyze', 'chart.write'],
    dependencyIds: ['data-science'],
    requiredPackIds: [],
    recommendedForRoles: ['finance', 'developer', 'pm'],
    permissions: [{ kind: 'filesystem', scope: 'trustedRoot', reason: '读取用户批准的数据文件并写入产物。', default: 'ask' }],
    installMode: 'plan-only',
    security: { signed: false, sandboxRequired: true, networkDuringRuntime: 'none' },
  },
  {
    schemaVersion: 'agent-cowork.pack.v1',
    id: 'developer-role-pack',
    name: 'Developer Role Pack',
    version: '0.1.0',
    description: '开发者岗位推荐包:代码理解、Git、浏览器验收和前端设计审查。',
    category: 'role',
    publisher: 'Agent Cowork',
    license: 'internal',
    capabilities: ['role.developer'],
    dependencyIds: ['mingit', 'playwright-chromium'],
    requiredPackIds: ['frontend-design-pack'],
    recommendedForRoles: ['developer'],
    permissions: [
      { kind: 'filesystem', scope: 'trustedRoot', reason: '读取代码仓库和写入用户批准的补丁。', default: 'ask' },
      { kind: 'shell', scope: 'git', reason: '运行只读 Git 检查或用户批准的仓库命令。', default: 'ask' },
    ],
    installMode: 'plan-only',
    security: { signed: false, sandboxRequired: true, networkDuringRuntime: 'ask' },
  },
]);

const packById = new Map(PACKS.map((pack) => [pack.id, pack]));

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function dependencyExists(id: string): boolean {
  return RUNTIME_DEPENDENCY_CATALOG.some((item) => item.id === id);
}

export function listCapabilityPacks(): CapabilityPack[] {
  return PACKS.map((pack) => ({ ...pack, dependencyIds: [...pack.dependencyIds], requiredPackIds: [...pack.requiredPackIds] }));
}

export function recommendCapabilityPacks(options: { role?: unknown; taskIntent?: unknown } = {}): CapabilityRecommendation[] {
  const role = String(options.role || '').trim().toLowerCase();
  const taskIntent = String(options.taskIntent || '').trim().toLowerCase();
  return listCapabilityPacks()
    .filter((pack) => {
      if (role && pack.recommendedForRoles.includes(role)) return true;
      if (/front|ui|react|design|视觉|前端/.test(taskIntent)) return pack.id === 'frontend-design-pack' || pack.id === 'browser-automation-pack';
      if (/pdf|ocr|扫描|合同|发票/.test(taskIntent)) return pack.id === 'pdf-ocr-pack';
      if (/csv|excel|data|数据|报表/.test(taskIntent)) return pack.id === 'data-analysis-pack';
      return pack.id === 'core-text-pack';
    })
    .map((pack) => ({
      ...pack,
      reason: role && pack.recommendedForRoles.includes(role) ? `匹配岗位 ${role}` : '匹配当前任务意图',
      missingDependencyIds: pack.dependencyIds.filter(dependencyExists),
    }));
}

export function dependencyIdsForPacks(packIds: unknown): { dependencyIds: string[]; unknownPackIds: string[] } {
  const ids = Array.isArray(packIds) ? packIds.map((item) => String(item || '').trim()).filter(Boolean) : [];
  const unknownPackIds: string[] = [];
  const dependencyIds: string[] = [];
  for (const id of ids) {
    const pack = packById.get(id);
    if (!pack) {
      unknownPackIds.push(id);
      continue;
    }
    dependencyIds.push(...pack.dependencyIds);
  }
  return { dependencyIds: unique(dependencyIds), unknownPackIds };
}

export function buildCapabilityInstallPlan(options: RuntimeDependencyInstallPlanOptions & { packIds?: unknown } = {}) {
  const fromPacks = dependencyIdsForPacks(options.packIds);
  const selectedIds = unique([
    ...(Array.isArray(options.selectedIds) ? options.selectedIds.map((item) => String(item || '').trim()) : []),
    ...fromPacks.dependencyIds,
  ]);
  const runtimePlan = buildRuntimeDependencyInstallPlan({ ...options, selectedIds });
  return {
    ok: runtimePlan.ok && fromPacks.unknownPackIds.length === 0,
    packIds: Array.isArray(options.packIds) ? options.packIds.map((item) => String(item || '').trim()).filter(Boolean) : [],
    unknownPackIds: fromPacks.unknownPackIds,
    dependencyIds: selectedIds,
    runtimePlan,
  };
}
