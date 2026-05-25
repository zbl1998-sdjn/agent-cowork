export const ONBOARDING_DONE_KEY = 'kcw.onboardingDone';

export type OnboardingRole = 'office' | 'developer' | 'research' | 'operations';

export interface OnboardingRoleOption {
  id: OnboardingRole;
  label: string;
  description: string;
}

export interface OnboardingRecommendationItem {
  id: string;
  label: string;
  reason: string;
}

export interface OnboardingRecommendations {
  skills: OnboardingRecommendationItem[];
  connectors: OnboardingRecommendationItem[];
  setup: OnboardingRecommendationItem[];
}

export interface OnboardingDependencyCheck {
  route: string;
  recommendedIds: string[];
}

export interface OnboardingResponse {
  roles: OnboardingRoleOption[];
  selectedRole: OnboardingRole;
  workspaceType: string;
  recommendations: OnboardingRecommendations;
  dependencyCheck: OnboardingDependencyCheck;
}

export interface OnboardingViewModel extends OnboardingResponse {
  roleOptions: OnboardingRoleOption[];
  recommendationSections: Array<{
    id: keyof OnboardingRecommendations;
    title: string;
    items: OnboardingRecommendationItem[];
  }>;
  dependencySummary: string;
}

export interface RuntimeDependencyItem {
  id: string;
  label: string;
  status: string;
  required?: boolean;
}

export const DEFAULT_ONBOARDING_ROLES: OnboardingRoleOption[] = [
  { id: 'office', label: '办公协作', description: '文档、会议和日常协作优先。' },
  { id: 'developer', label: '开发者', description: '代码、终端和仓库工作流优先。' },
  { id: 'research', label: '研究分析', description: '资料整理、检索和证据归纳优先。' },
  { id: 'operations', label: '运营支持', description: '流程跟进、定时任务和连接器优先。' },
];

const FALLBACK_BY_ROLE: Record<OnboardingRole, OnboardingRecommendations> = {
  office: {
    skills: [
      { id: 'write-summary', label: '会议纪要整理', reason: '把讨论快速整理成行动项和负责人。' },
      { id: 'doc-polish', label: '文档润色', reason: '适合日常汇报、邮件和说明文档。' },
    ],
    connectors: [
      { id: 'local-files', label: '本地文件', reason: '先从当前工作区读取资料，不需要额外配置。' },
    ],
    setup: [
      { id: 'api-key', label: '配置 Kimi API', reason: '启用通用聊天和更完整的协作能力。' },
      { id: 'trusted-root', label: '确认工作目录', reason: '让文件检索和产物打开更准确。' },
    ],
  },
  developer: {
    skills: [
      { id: 'repo-review', label: '仓库审查', reason: '读取真实代码、测试和脚本后再给结论。' },
      { id: 'bugfix-loop', label: '修复并验证', reason: '适合从失败命令一路修到可复现通过。' },
    ],
    connectors: [
      { id: 'filesystem', label: '文件系统', reason: '用于读取仓库、编辑文件和检查产物。' },
      { id: 'terminal', label: '本地终端', reason: '运行测试、构建和 smoke 命令。' },
    ],
    setup: [
      { id: 'api-key', label: '配置 Kimi API', reason: '启用长上下文开发协作。' },
      { id: 'repo-root', label: '固定仓库根目录', reason: '减少误操作到错误目录的风险。' },
    ],
  },
  research: {
    skills: [
      { id: 'source-brief', label: '资料摘要', reason: '把多份材料压缩成可引用结论。' },
      { id: 'evidence-table', label: '证据表', reason: '适合比较来源、时间和可信度。' },
    ],
    connectors: [
      { id: 'local-files', label: '本地文件', reason: '先处理已有 PDF、Markdown 和报告。' },
    ],
    setup: [
      { id: 'workspace-index', label: '索引工作区', reason: '让资料检索更快。' },
      { id: 'api-key', label: '配置 Kimi API', reason: '提升长文档理解质量。' },
    ],
  },
  operations: {
    skills: [
      { id: 'task-followup', label: '任务跟进', reason: '把待办、状态和下一步集中起来。' },
      { id: 'schedule-check', label: '定时检查', reason: '适合例行巡检和周期提醒。' },
    ],
    connectors: [
      { id: 'schedules', label: '定时任务', reason: '让重复工作自动触发。' },
      { id: 'memory', label: '本地记忆', reason: '保留项目偏好和常用术语。' },
    ],
    setup: [
      { id: 'api-key', label: '配置 Kimi API', reason: '启用更完整的任务理解。' },
      { id: 'notifications', label: '检查提醒策略', reason: '避免关键任务无声失败。' },
    ],
  },
};

function isRole(value: string | null | undefined): value is OnboardingRole {
  return value === 'office' || value === 'developer' || value === 'research' || value === 'operations';
}

function normalizeRoleOptions(roles: unknown): OnboardingRoleOption[] {
  if (!Array.isArray(roles)) return DEFAULT_ONBOARDING_ROLES;
  const normalized = roles
    .map((role) => {
      if (typeof role === 'string' && isRole(role)) {
        return DEFAULT_ONBOARDING_ROLES.find((option) => option.id === role) || null;
      }
      if (!role || typeof role !== 'object') return null;
      const candidate = role as Partial<OnboardingRoleOption>;
      if (!isRole(candidate.id)) return null;
      const fallback = DEFAULT_ONBOARDING_ROLES.find((option) => option.id === candidate.id);
      return {
        id: candidate.id,
        label: candidate.label || fallback?.label || candidate.id,
        description: candidate.description || fallback?.description || '',
      };
    })
    .filter((role): role is OnboardingRoleOption => Boolean(role));
  return normalized.length ? normalized : DEFAULT_ONBOARDING_ROLES;
}

export function selectInitialRole(preferred?: string | null, roles: OnboardingRoleOption[] = DEFAULT_ONBOARDING_ROLES): OnboardingRole {
  if (isRole(preferred) && roles.some((role) => role.id === preferred)) return preferred;
  if (roles.some((role) => role.id === 'office')) return 'office';
  return roles[0]?.id ?? 'office';
}

export function getFallbackOnboarding(role?: string | null, workspaceType = 'local'): OnboardingResponse {
  const selectedRole = selectInitialRole(role);
  const recommendations = FALLBACK_BY_ROLE[selectedRole];
  return {
    roles: DEFAULT_ONBOARDING_ROLES,
    selectedRole,
    workspaceType,
    recommendations,
    dependencyCheck: {
      route: '/api/runtime/dependencies',
      recommendedIds: ['node', 'webview2', 'python-embedded', 'cjk-fonts', 'sqlite'],
    },
  };
}

export function toOnboardingViewModel(response: OnboardingResponse): OnboardingViewModel {
  const roles = normalizeRoleOptions(response.roles);
  const selectedRole = selectInitialRole(response.selectedRole, roles);
  const dependencyIds = response.dependencyCheck.recommendedIds;
  return {
    ...response,
    roles,
    selectedRole,
    roleOptions: roles,
    recommendationSections: [
      { id: 'skills', title: '推荐技能', items: response.recommendations.skills },
      { id: 'connectors', title: '推荐连接器', items: response.recommendations.connectors },
      { id: 'setup', title: '建议设置', items: response.recommendations.setup },
    ],
    dependencySummary: dependencyIds.length
      ? `依赖体检将关注 ${dependencyIds.length} 个组件: ${dependencyIds.slice(0, 4).join(', ')}${dependencyIds.length > 4 ? '…' : ''}`
      : '暂无推荐依赖体检项',
  };
}

export function selectRecommendedDependencies(
  dependencies: RuntimeDependencyItem[],
  recommendedIds: string[],
): RuntimeDependencyItem[] {
  const selected = new Set(recommendedIds);
  return dependencies.filter((dependency) => selected.has(dependency.id));
}
