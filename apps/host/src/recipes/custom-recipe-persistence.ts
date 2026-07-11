// Strict decoder for untrusted custom-recipe JSON (host · L1 · recipes).
import { types as utilTypes } from 'node:util';
import { identityScopeTupleKey, requireIdentityScopeFrom } from '../security/identity-scope.js';
import { redactText } from '../security/redaction.js';
import { createCustomRecipeJsonCloner } from './custom-recipe-json.js';
import type {
  CapturedArtifact,
  CapturedStep,
  CustomRecipe,
  CustomRecipeFormat,
} from './custom-recipe-types.js';

const RECIPE_ID_RE = /^[a-z0-9_-]+$/i;
const REQUIRED_RECIPE_KEYS = [
  'artifacts', 'createdAt', 'custom', 'description', 'id', 'name', 'output', 'prompt',
  'redacted', 'riskLevel', 'sourceRunId', 'steps', 'tenantId', 'updatedAt', 'userId',
] as const;
const OPTIONAL_RECIPE_KEYS = ['format', 'requiresSources'] as const;
const RISK_LEVELS = new Set(['safe-write', 'preview-only', 'requires-approval']);

type Fields = Record<string, unknown>;
export type DecodedCustomRecipeSnapshot = { recipes: CustomRecipe[]; corrupt: boolean };

function shape(value: unknown, required: readonly string[], optional: readonly string[] = []): Fields | null {
  if (value === null || typeof value !== 'object' || utilTypes.isProxy(value) || Array.isArray(value)) return null;
  let prototype: object | null;
  let keys: PropertyKey[];
  try {
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
  } catch {
    return null;
  }
  if (prototype !== Object.prototype) return null;
  const allowed = new Set([...required, ...optional]);
  const fields: Fields = {};
  for (const key of keys) {
    if (typeof key !== 'string' || !allowed.has(key)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
    fields[key] = descriptor.value;
  }
  return required.every((key) => Object.hasOwn(fields, key)) ? fields : null;
}

function boundedStoredString(value: unknown, max: number, allowEmpty = true): value is string {
  return typeof value === 'string'
    && value.length <= max
    && (allowEmpty || value.length > 0)
    && redactText(value) === value;
}

function isoTimestamp(value: unknown): value is string {
  return boundedStoredString(value, 64, false)
    && !Number.isNaN(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function decodeFormat(value: unknown): CustomRecipeFormat | null {
  const fields = shape(value, ['body', 'kind']);
  return fields?.kind === 'markdown' && boundedStoredString(fields.body, 12_000, false) && fields.body.trim()
    ? { kind: 'markdown', body: fields.body }
    : null;
}

function decodeSteps(value: unknown): CapturedStep[] | null {
  if (utilTypes.isProxy(value) || !Array.isArray(value) || value.length > 40) return null;
  const steps: CapturedStep[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const fields = shape(value[index], ['index', 'tool'], ['args', 'result', 'status', 'summary']);
    if (!fields || fields.index !== index || !boundedStoredString(fields.tool, 120, false)) return null;
    if (Object.hasOwn(fields, 'status') && !boundedStoredString(fields.status, 80, false)) return null;
    steps.push({
      index,
      tool: fields.tool,
      ...(Object.hasOwn(fields, 'status') ? { status: fields.status as string } : {}),
      ...(Object.hasOwn(fields, 'args') ? { args: fields.args } : {}),
      ...(Object.hasOwn(fields, 'result') ? { result: fields.result } : {}),
      ...(Object.hasOwn(fields, 'summary') ? { summary: fields.summary } : {}),
    });
  }
  return steps;
}

function decodeArtifacts(value: unknown): CapturedArtifact[] | null {
  if (utilTypes.isProxy(value) || !Array.isArray(value) || value.length > 80) return null;
  const artifacts: CapturedArtifact[] = [];
  for (const item of value) {
    const fields = shape(item, ['kind', 'path'], ['source']);
    if (!fields || !boundedStoredString(fields.path, 500, false) || !boundedStoredString(fields.kind, 80, false)) return null;
    artifacts.push({
      path: fields.path,
      kind: fields.kind,
      ...(Object.hasOwn(fields, 'source') ? { source: fields.source } : {}),
    });
  }
  return artifacts;
}

export function decodeCustomRecipe(value: unknown): CustomRecipe | null {
  const fields = shape(value, REQUIRED_RECIPE_KEYS, OPTIONAL_RECIPE_KEYS);
  if (!fields) return null;
  let owner: { tenantId: string; userId: string };
  try {
    owner = requireIdentityScopeFrom(fields, { label: 'stored custom recipe identity' });
  } catch {
    return null;
  }
  const cloneJson = createCustomRecipeJsonCloner('validate');
  let safeSteps: unknown;
  let safeArtifacts: unknown;
  try {
    safeSteps = cloneJson(fields.steps);
    safeArtifacts = cloneJson(fields.artifacts);
  } catch {
    return null;
  }
  const steps = decodeSteps(safeSteps);
  const artifacts = decodeArtifacts(safeArtifacts);
  const format = Object.hasOwn(fields, 'format') ? decodeFormat(fields.format) : undefined;
  const requiresSources = Object.hasOwn(fields, 'requiresSources') ? fields.requiresSources : undefined;
  if (
    !boundedStoredString(fields.id, 120, false) || !RECIPE_ID_RE.test(fields.id)
    || !boundedStoredString(fields.name, 120, false)
    || !boundedStoredString(fields.description, 500)
    || !boundedStoredString(fields.output, 120, false)
    || typeof fields.riskLevel !== 'string' || !RISK_LEVELS.has(fields.riskLevel)
    || (requiresSources !== undefined && typeof requiresSources !== 'boolean')
    || (Object.hasOwn(fields, 'format') && !format)
    || fields.custom !== true || fields.redacted !== true
    || !boundedStoredString(owner.tenantId, 96, false)
    || !boundedStoredString(owner.userId, 96, false)
    || !(fields.sourceRunId === null || boundedStoredString(fields.sourceRunId, 120, false))
    || !boundedStoredString(fields.prompt, 4_000)
    || !steps || !artifacts
    || !isoTimestamp(fields.createdAt) || !isoTimestamp(fields.updatedAt)
    || Date.parse(fields.createdAt) > Date.parse(fields.updatedAt)
  ) return null;
  return {
    id: fields.id,
    name: fields.name,
    description: fields.description,
    output: fields.output,
    riskLevel: fields.riskLevel,
    ...(requiresSources === undefined ? {} : { requiresSources }),
    ...(format ? { format } : {}),
    custom: true,
    ...owner,
    sourceRunId: fields.sourceRunId,
    prompt: fields.prompt,
    steps,
    artifacts,
    redacted: true,
    createdAt: fields.createdAt,
    updatedAt: fields.updatedAt,
  };
}

export function decodeCustomRecipeSnapshot(value: unknown): DecodedCustomRecipeSnapshot {
  const fields = shape(value, ['recipes']);
  if (!fields || utilTypes.isProxy(fields.recipes) || !Array.isArray(fields.recipes)) {
    throw new Error('expected an exact object with a recipes array');
  }
  let corrupt = false;
  const decoded: CustomRecipe[] = [];
  for (const value of fields.recipes) {
    const recipe = decodeCustomRecipe(value);
    if (recipe) decoded.push(recipe);
    else corrupt = true;
  }
  const counts = new Map<string, number>();
  for (const recipe of decoded) {
    const key = identityScopeTupleKey(recipe, 'custom-recipe', recipe.id);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const recipes = decoded.filter((recipe) => {
    const key = identityScopeTupleKey(recipe, 'custom-recipe', recipe.id);
    const unique = counts.get(key) === 1;
    if (!unique) corrupt = true;
    return unique;
  });
  return { recipes, corrupt };
}

export function cloneCustomRecipe(recipe: CustomRecipe): CustomRecipe {
  const clone = decodeCustomRecipe(recipe);
  if (!clone) throw new Error('custom recipe is invalid');
  return clone;
}
