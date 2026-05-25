const BASE_STEPS = [
  { name: 'check', args: ['run', 'check'] },
  { name: 'test:host', args: ['run', 'test:host'] },
  { name: 'test:ui', args: ['run', 'test:ui'] },
];

const EVAL_TRIGGER_PATTERNS = [
  /^apps\/host\/src\/kimi\/system-prompt\.js$/,
  /^apps\/host\/src\/kimi\/model-call\.js$/,
  /^apps\/host\/src\/kimi\/model-/,
  /^apps\/host\/src\/kimi\/agent\//,
  /^apps\/host\/src\/kimi\/agent-runner\.js$/,
  /^eval\//,
  /^scripts\/eval\.mjs$/,
];

function normalizeFilePath(filePath) {
  return String(filePath || '').trim().replace(/\\/g, '/');
}

export function parseChangedFiles(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(normalizeFilePath).filter(Boolean);
  return String(value)
    .split(/[\r\n,;]+/)
    .map(normalizeFilePath)
    .filter(Boolean);
}

export function shouldRunEvalForFiles(files) {
  return parseChangedFiles(files).some((filePath) => EVAL_TRIGGER_PATTERNS.some((pattern) => pattern.test(filePath)));
}

export function buildCiSteps({ changedFiles = [], forceEval = false } = {}) {
  const files = parseChangedFiles(changedFiles);
  const changedFilesUnknown = files.length === 0;
  const runEval = forceEval || changedFilesUnknown || shouldRunEvalForFiles(files);
  return runEval ? [...BASE_STEPS, { name: 'eval', args: ['run', 'eval'] }] : BASE_STEPS.slice();
}

export function changedFilesFromEnv(env = process.env) {
  return parseChangedFiles(env.KCW_CI_CHANGED_FILES || env.CHANGED_FILES);
}
