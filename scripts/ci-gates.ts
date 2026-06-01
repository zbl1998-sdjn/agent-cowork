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
