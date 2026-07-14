// CI 门禁步骤编排与按变更触发 eval 的判定(scripts · 门禁(gate))
// ---------------------------------------------------------------------------
// 职责:纯逻辑库,定义 CI 的基础步骤序列及其有界并行分组(check / coverage host tests /
//   test:ui),并根据本次变更的文件路径判断是否需要追加 eval 步骤;同时提供变更文件解析与环境变量读取。
//   仅返回步骤描述与判定结果,不实际执行(执行由 ci.ts 负责)。
// 用法:被 scripts/ci.ts 导入调用(buildCiSteps / changedFilesFromEnv),
//   变更文件经由 KCW_CI_CHANGED_FILES 或 CHANGED_FILES 环境变量传入;
//   KCW_CI_FORCE_EVAL=1 可强制追加 eval。无独立 npm 脚本。
// 依赖:engine/eval 相关源码路径的正则白名单(命中即触发 eval)。

export type CiStep = {
  name: string;
  args: readonly string[];
  timeoutMs: number;
  env?: Readonly<Record<string, string>>;
  parallelGroup?: string;
};

type ChangedFilesInput = string | readonly unknown[] | null | undefined;

const BASE_STEPS: readonly CiStep[] = [
  { name: 'check', args: ['run', 'check'], timeoutMs: 1_800_000, parallelGroup: 'source-gates' },
  { name: 'test:host:coverage:90', args: ['run', 'test:host:coverage:90'], timeoutMs: 1_800_000, parallelGroup: 'source-gates' },
  { name: 'test:ui', args: ['run', 'test:ui'], timeoutMs: 1_200_000, parallelGroup: 'source-gates' },
];

export const CI_EVAL_REPLAY_FIXTURE = 'eval/fixtures/ci-model-records.json';
const EVAL_STEP: CiStep = {
  name: 'eval',
  args: ['run', 'eval'],
  timeoutMs: 1_800_000,
  env: { KCW_EVAL_REPLAY_RECORDS: CI_EVAL_REPLAY_FIXTURE },
  parallelGroup: 'source-gates',
};

const EVAL_TRIGGER_PATTERNS = [
  /^apps\/host\/src\/engine\/system-prompt\.(?:js|ts)$/,
  /^apps\/host\/src\/engine\/model-call\.(?:js|ts)$/,
  /^apps\/host\/src\/engine\/model-/,
  /^apps\/host\/src\/engine\/agent\//,
  /^apps\/host\/src\/engine\/agent-runner\.(?:js|ts)$/,
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
  return runEval ? [...BASE_STEPS, EVAL_STEP] : [...BASE_STEPS];
}

export function changedFilesFromEnv(env: Record<string, string | undefined> = process.env): string[] {
  return parseChangedFiles(env.KCW_CI_CHANGED_FILES || env.CHANGED_FILES);
}

export function ciStepEnvironment(
  step: CiStep,
  env: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
  const merged = { ...env };
  for (const [key, value] of Object.entries(step.env || {})) {
    if (merged[key] === undefined) merged[key] = value;
  }
  return merged;
}
