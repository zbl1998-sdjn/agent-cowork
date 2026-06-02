// CI 门禁步骤编排与按变更触发 eval 的判定(scripts · 门禁(gate))
// ---------------------------------------------------------------------------
// 职责:纯逻辑库,定义 CI 的基础步骤序列(check / test:host / test:ui),并根据
//   本次变更的文件路径判断是否需要追加 eval 步骤;同时提供变更文件解析与环境变量读取。
//   仅返回步骤描述与判定结果,不实际执行(执行由 ci.ts 负责)。
// 用法:被 scripts/ci.ts 导入调用(buildCiSteps / changedFilesFromEnv),
//   变更文件经由 KCW_CI_CHANGED_FILES 或 CHANGED_FILES 环境变量传入;
//   KCW_CI_FORCE_EVAL=1 可强制追加 eval。无独立 npm 脚本。
// 依赖:kimi/eval 相关源码路径的正则白名单(命中即触发 eval)。

export type CiStep = {
  name: string;
  args: readonly string[];
};

type ChangedFilesInput = string | readonly unknown[] | null | undefined;

const BASE_STEPS: readonly CiStep[] = [
  { name: 'check', args: ['run', 'check'] },
  { name: 'test:host', args: ['run', 'test:host'] },
  { name: 'test:ui', args: ['run', 'test:ui'] },
];

const EVAL_TRIGGER_PATTERNS = [
  /^apps\/host\/src\/kimi\/system-prompt\.(?:js|ts)$/,
  /^apps\/host\/src\/kimi\/model-call\.(?:js|ts)$/,
  /^apps\/host\/src\/kimi\/model-/,
  /^apps\/host\/src\/kimi\/agent\//,
  /^apps\/host\/src\/kimi\/agent-runner\.(?:js|ts)$/,
  /^eval\//,
  /^scripts\/eval\.(?:mjs|ts)$/,
];

function normalizeFilePath(filePath: unknown): string {
  return String(filePath || '').trim().replace(/\\/g, '/');
}

export function parseChangedFiles(value: ChangedFilesInput): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(normalizeFilePath).filter(Boolean);
  return String(value)
    .split(/[\r\n,;]+/)
    .map(normalizeFilePath)
    .filter(Boolean);
}

export function shouldRunEvalForFiles(files: ChangedFilesInput): boolean {
  return parseChangedFiles(files).some((filePath) => EVAL_TRIGGER_PATTERNS.some((pattern) => pattern.test(filePath)));
}

export function buildCiSteps({
  changedFiles = [],
  forceEval = false,
}: {
  changedFiles?: ChangedFilesInput;
  forceEval?: boolean;
} = {}): CiStep[] {
  const files = parseChangedFiles(changedFiles);
  const changedFilesUnknown = files.length === 0;
  const runEval = forceEval || changedFilesUnknown || shouldRunEvalForFiles(files);
  return runEval ? [...BASE_STEPS, { name: 'eval', args: ['run', 'eval'] }] : [...BASE_STEPS];
}

export function changedFilesFromEnv(env: Record<string, string | undefined> = process.env): string[] {
  return parseChangedFiles(env.KCW_CI_CHANGED_FILES || env.CHANGED_FILES);
}
