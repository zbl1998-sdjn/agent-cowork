const ROLES = [
  {
    id: 'office',
    label: '办公协作',
    description: '适合文档处理、资料整理、表格分析和日常自动化。',
  },
  {
    id: 'developer',
    label: '开发者',
    description: '适合代码阅读、项目执行、调试、测试和版本管理。',
  },
  {
    id: 'research',
    label: '研究分析',
    description: '适合资料检索、论文阅读、数据分析和报告产出。',
  },
  {
    id: 'operations',
    label: '运营管理',
    description: '适合任务跟进、流程协调、数据看板和例行汇报。',
  },
];

const BASE_DEPENDENCY_IDS = ['node', 'python-embedded', 'cjk-fonts', 'webview2', 'sqlite'];

const RECOMMENDATIONS_BY_ROLE = {
  office: {
    skills: [
      { id: 'office-writer', label: '办公文档生成', reason: '快速起草、改写和整理 Word/Markdown 文档。' },
      { id: 'spreadsheet-analysis', label: '表格分析', reason: '帮助清洗表格、生成摘要和发现异常值。' },
      { id: 'file-organizer', label: '文件整理', reason: '适合首启后建立本地资料归档流程。' },
    ],
    connectors: [
      { id: 'filesystem', label: '本地文件系统', reason: '允许引导流程读取和整理选定工作区文件。' },
      { id: 'office-documents', label: 'Office 文档', reason: '面向日常文档编辑和导出场景。' },
    ],
    setup: [
      { id: 'choose-workspace', label: '选择工作区', reason: '先确定默认资料目录，减少后续授权和路径选择。' },
      { id: 'dependency-check', label: '运行依赖检查', reason: '确认 WebView、字体和文档工具链状态。' },
    ],
  },
  developer: {
    skills: [
      { id: 'repo-grounded-workflow', label: '仓库上下文工作流', reason: '优先从真实文件、脚本和测试命令理解项目。' },
      { id: 'test-runner', label: '测试执行', reason: '便于首启后直接运行项目内的单测和检查命令。' },
      { id: 'code-review', label: '代码审查', reason: '辅助发现回归风险、缺失测试和边界条件。' },
    ],
    connectors: [
      { id: 'filesystem', label: '本地文件系统', reason: '读取仓库文件和写入受控代码改动。' },
      { id: 'github', label: 'GitHub', reason: '用于后续查看 PR、issue 和 CI 状态。' },
    ],
    setup: [
      { id: 'trust-workspace', label: '信任当前仓库', reason: '确认允许访问的代码根目录和命令执行边界。' },
      { id: 'detect-toolchain', label: '检测开发工具链', reason: '确认 Node、Python、Git 和项目测试入口可用。' },
    ],
  },
  research: {
    skills: [
      { id: 'document-extractor', label: '文档抽取', reason: '从 PDF、网页和资料包中提取结构化内容。' },
      { id: 'data-profile', label: '数据画像', reason: '快速了解数据字段、缺失值和分布特征。' },
      { id: 'citation-notes', label: '资料笔记', reason: '帮助保留来源、摘要和待验证结论。' },
    ],
    connectors: [
      { id: 'filesystem', label: '本地文件系统', reason: '管理研究资料、数据文件和输出报告。' },
      { id: 'web-fetch', label: '网页抓取', reason: '用于收集公开页面和参考资料。' },
    ],
    setup: [
      { id: 'research-folder', label: '建立研究目录', reason: '把原始资料、处理结果和报告输出分开保存。' },
      { id: 'ocr-tooling', label: '准备 OCR/转换工具', reason: '提升扫描件、PDF 和长文档处理质量。' },
    ],
  },
  operations: {
    skills: [
      { id: 'task-planner', label: '任务计划', reason: '把目标拆成可跟踪的步骤和交付物。' },
      { id: 'status-report', label: '状态汇报', reason: '稳定生成日报、周报和风险摘要。' },
      { id: 'workflow-audit', label: '流程检查', reason: '发现重复工作、阻塞点和交接缺口。' },
    ],
    connectors: [
      { id: 'filesystem', label: '本地文件系统', reason: '读取项目资料、会议记录和报告模板。' },
      { id: 'calendar-export', label: '日程导出', reason: '为后续任务提醒和计划同步预留入口。' },
    ],
    setup: [
      { id: 'team-workspace', label: '配置团队工作区', reason: '集中管理计划、纪要、模板和输出文件。' },
      { id: 'report-template', label: '选择汇报模板', reason: '让首批运营输出格式保持一致。' },
    ],
  },
};

const ROLE_DEPENDENCY_IDS = {
  office: ['data-science', 'tesseract-ocr', 'pandoc'],
  developer: ['mingit'],
  research: ['data-science', 'tesseract-ocr', 'pandoc'],
  operations: ['pandoc'],
};

/**
 * @param {unknown} value
 * @returns {string}
 */
function normalizeText(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/**
 * @param {string} role
 * @returns {role is keyof typeof RECOMMENDATIONS_BY_ROLE}
 */
function isKnownRole(role) {
  return Object.prototype.hasOwnProperty.call(RECOMMENDATIONS_BY_ROLE, role);
}

/**
 * @param {string[]} ids
 * @returns {string[]}
 */
function uniqueIds(ids) {
  return [...new Set(ids)];
}

/**
 * @param {{ role?: unknown, workspaceType?: unknown }} [input]
 */
export function buildOnboardingRecommendations(input = {}) {
  const requestedRole = normalizeText(input.role);
  const selectedRole = isKnownRole(requestedRole) ? requestedRole : 'office';
  const workspaceType = normalizeText(input.workspaceType) || 'local';
  const recommendations = RECOMMENDATIONS_BY_ROLE[selectedRole];
  const recommendedIds = uniqueIds([
    ...BASE_DEPENDENCY_IDS,
    ...ROLE_DEPENDENCY_IDS[selectedRole],
  ]);

  return {
    roles: ROLES,
    selectedRole,
    workspaceType,
    recommendations,
    dependencyCheck: {
      route: '/api/runtime/dependencies',
      recommendedIds,
    },
  };
}
