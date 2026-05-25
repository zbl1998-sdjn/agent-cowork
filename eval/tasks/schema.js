const CATEGORIES = new Set([
  'file-read',
  'file-write',
  'workspace-search',
  'multi-step-refactor',
  'approval-flow',
  'office-artifact',
  'batch-files',
  'conversation-branches',
]);

const ASSERTION_TYPES = new Set([
  'responseContains',
  'fileExists',
  'fileContains',
  'fileNotExists',
  'toolCalled',
  'approvalRequested',
  'artifactCreated',
  'conversationBranchExists',
  'noFileOutsideRoot',
]);

function fail(message) {
  throw new Error(`Invalid EvalTask: ${message}`);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requireString(value, name, minLength = 1) {
  if (typeof value !== 'string' || value.trim().length < minLength) {
    fail(`${name} must be a string`);
  }
  return value.trim();
}

function requireSafeRelativePath(value, name) {
  const text = requireString(value, name);
  const normalized = text.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[a-z]:\//i.test(normalized) || normalized.split('/').includes('..')) {
    fail(`${name} must be a relative path inside the eval workspace`);
  }
  return normalized;
}

function validateFixture(fixture) {
  if (!isPlainObject(fixture)) fail('fixture must be an object');
  const files = fixture.files;
  if (!Array.isArray(files)) fail('fixture.files must be an array');
  return {
    files: files.map((file, index) => {
      if (!isPlainObject(file)) fail(`fixture.files[${index}] must be an object`);
      return {
        path: requireSafeRelativePath(file.path, `fixture.files[${index}].path`),
        content: typeof file.content === 'string' ? file.content : fail(`fixture.files[${index}].content must be a string`),
      };
    }),
  };
}

function validateAssertion(assertion, index) {
  if (!isPlainObject(assertion)) fail(`assertions[${index}] must be an object`);
  const type = requireString(assertion.type, `assertions[${index}].type`);
  if (!ASSERTION_TYPES.has(type)) fail(`assertions[${index}].type is unsupported: ${type}`);
  const out = { type };
  for (const [key, value] of Object.entries(assertion)) {
    if (key === 'type') continue;
    if (key === 'path') out.path = requireSafeRelativePath(value, `assertions[${index}].path`);
    else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') out[key] = value;
    else if (Array.isArray(value) && value.every((item) => typeof item === 'string')) out[key] = value.slice();
    else fail(`assertions[${index}].${key} must be scalar or string array`);
  }
  return out;
}

export function validateEvalTask(task) {
  if (!isPlainObject(task)) fail('task must be an object');
  const id = requireString(task.id, 'id');
  if (!/^[a-z0-9][a-z0-9-]{4,80}$/.test(id)) fail('id must be stable kebab-case');
  const title = requireString(task.title, 'title', 5);
  const category = requireString(task.category, 'category');
  if (!CATEGORIES.has(category)) fail(`category is unsupported: ${category}`);
  const prompt = requireString(task.prompt, 'prompt', 10);
  const maxSteps = Number(task.maxSteps);
  if (!Number.isInteger(maxSteps) || maxSteps <= 0) fail('maxSteps must be a positive integer');
  if (!Array.isArray(task.assertions) || task.assertions.length === 0) {
    fail('assertions must contain at least one deterministic assertion');
  }
  const tags = Array.isArray(task.tags)
    ? task.tags.map((tag, index) => requireString(tag, `tags[${index}]`))
    : [];
  return {
    id,
    title,
    category,
    tags,
    prompt,
    maxSteps,
    fixture: validateFixture(task.fixture),
    assertions: task.assertions.map(validateAssertion),
  };
}

export function evalTaskCategories() {
  return Array.from(CATEGORIES);
}

export function evalTaskAssertionTypes() {
  return Array.from(ASSERTION_TYPES);
}
