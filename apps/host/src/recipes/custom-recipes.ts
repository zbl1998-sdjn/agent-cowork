// 自定义配方存储(host · L1 领域层 · recipes)
// ---------------------------------------------------------------------------
// 职责:把用户从一次运行「捕获」出来的自定义配方,按租户/用户隔离地持久化(增删查)。
//       内容已脱敏(redacted)。供「把这次操作存成我的配方」能力使用。
// 依赖:node:fs/path + L0 security。导出:createCustomRecipeStore。
import path from 'node:path';
import {
  requireIdentityScopeFrom,
  type IdentityScope,
} from '../security/identity-scope.js';
import {
  createManagedSingleFileOperation,
  type ManagedSingleFileOperation,
} from '../security/managed-single-file.js';
import { omitUndefined } from '../util/object.js';
import {
  cloneCustomRecipe,
  decodeCustomRecipeSnapshot,
  type DecodedCustomRecipeSnapshot,
} from './custom-recipe-persistence.js';
import { createCustomRecipeJsonCloner } from './custom-recipe-json.js';
import type {
  CapturedArtifact,
  CapturedStep,
  CustomRecipe,
  CustomRecipeFormat,
} from './custom-recipe-types.js';

export type { CustomRecipe, CustomRecipeFormat } from './custom-recipe-types.js';

const RECIPE_ID_RE = /^[a-z0-9_-]+$/i;
const STORE_BYTE_LIMIT = 1_048_576;

export type RecipeScope = {
  tenantId?: unknown;
  userId?: unknown;
};

export type CustomRecipeStore = {
  list(scope?: RecipeScope): CustomRecipe[];
  get(id: string, scope?: RecipeScope): CustomRecipe | null;
  save(input: Record<string, unknown>, scope?: RecipeScope): CustomRecipe;
};

function cleanText(value: unknown, max: number): string {
  return String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
}

function cleanTemplateBody(value: unknown, max: number): string {
  return String(value ?? '').slice(0, max);
}

function slug(value: unknown): string {
  return cleanText(value, 80).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'captured';
}

function cleanRiskLevel(value: unknown): string {
  const text = cleanText(value, 80);
  return ['safe-write', 'preview-only', 'requires-approval'].includes(text) ? text : 'safe-write';
}

function cleanFormat(value: unknown): CustomRecipeFormat | undefined {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  if (!record || record.kind !== 'markdown') {
    return undefined;
  }
  const body = cleanTemplateBody(record.body, 12000);
  return body.trim() ? { kind: 'markdown', body } : undefined;
}

function cleanSteps(value: unknown): CapturedStep[] {
  return (Array.isArray(value) ? value : []).slice(0, 40).map((step, index) => {
    const record = step && typeof step === 'object' ? step as Record<string, unknown> : {};
    return omitUndefined({
      index,
      tool: cleanText(record.tool, 120),
      status: cleanText(record.status, 80) || undefined,
      args: record.args,
      result: record.result,
      summary: record.summary,
    });
  });
}

function cleanArtifacts(value: unknown): CapturedArtifact[] {
  return (Array.isArray(value) ? value : []).slice(0, 80).map((artifact) => {
    const record = artifact && typeof artifact === 'object' ? artifact as Record<string, unknown> : {};
    return omitUndefined({
      path: cleanText(record.path, 500),
      kind: cleanText(record.kind, 80) || 'file',
      source: record.source,
    }) as CapturedArtifact;
  }).filter((artifact) => Boolean(artifact.path));
}

function httpError(error: unknown): Error & { statusCode?: number } {
  return error instanceof Error ? error : new Error(String(error));
}

function sanitizedRecipeInput(input: unknown): Record<string, unknown> {
  try {
    const value = createCustomRecipeJsonCloner('sanitize')(input);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    const error = httpError(new Error('Recipe draft must be bounded plain JSON'));
    error.statusCode = 400;
    throw error;
  }
}

function recipeOwner(scope: RecipeScope | undefined): IdentityScope {
  return requireIdentityScopeFrom(scope, {
    allowLocalDefault: true,
    label: 'custom recipe identity',
  });
}

function isSameRecipe(value: CustomRecipe, id: string, owner: IdentityScope): boolean {
  return value.tenantId === owner.tenantId && value.userId === owner.userId && value.id === id;
}

function assertWithinStoreByteLimit(size: number): void {
  if (size > STORE_BYTE_LIMIT) {
    throw new Error(`custom recipe store exceeds byte limit of ${STORE_BYTE_LIMIT}`);
  }
}

/** 创建自定义配方存储(按 tenant/user 作用域增删查并持久化到 JSON)。 */
export function createCustomRecipeStore({ storePath }: { storePath: string }): CustomRecipeStore {
  const filePath = path.resolve(storePath);

  function readAll(operation: ManagedSingleFileOperation): DecodedCustomRecipeSnapshot {
    try {
      const content = operation.readText({ maxBytes: STORE_BYTE_LIMIT });
      if (content === null) return { recipes: [], corrupt: false };
      assertWithinStoreByteLimit(Buffer.byteLength(content, 'utf8'));
      const parsed = JSON.parse(content) as unknown;
      return decodeCustomRecipeSnapshot(parsed);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`custom recipe store is corrupt or unreadable: ${detail}`);
    }
  }

  function writeAll(recipes: CustomRecipe[], operation: ManagedSingleFileOperation): void {
    const content = `${JSON.stringify({ recipes }, null, 2)}\n`;
    assertWithinStoreByteLimit(Buffer.byteLength(content, 'utf8'));
    operation.writeText(content);
  }

  function list(scope?: RecipeScope): CustomRecipe[] {
    const owner = recipeOwner(scope);
    const operation = createManagedSingleFileOperation(filePath, 'Custom recipe store directory');
    return readAll(operation).recipes
      .filter((recipe) => recipe.tenantId === owner.tenantId && recipe.userId === owner.userId)
      .map(cloneCustomRecipe);
  }

  return {
    list,
    get(id: string, scope?: RecipeScope): CustomRecipe | null {
      if (!RECIPE_ID_RE.test(id || '')) {
        return null;
      }
      return list(scope).find((recipe) => recipe.id === id) || null;
    },
    save(input: Record<string, unknown>, scope?: RecipeScope): CustomRecipe {
      const safeInput = sanitizedRecipeInput(input);
      if (safeInput.redacted !== true) {
        const err = httpError(new Error('Recipe draft must be redacted before saving'));
        err.statusCode = 400;
        throw err;
      }
      const owner = recipeOwner(scope);
      const operation = createManagedSingleFileOperation(filePath, 'Custom recipe store directory');
      const now = new Date().toISOString();
      const name = cleanText(safeInput.name, 120) || '自定义技能';
      const snapshot = readAll(operation);
      if (snapshot.corrupt) {
        throw new Error('custom recipe store is corrupt; refusing to overwrite invalid or duplicate records');
      }
      const existing = snapshot.recipes;
      const requestedId = cleanText(safeInput.id, 120);
      const baseId = requestedId && RECIPE_ID_RE.test(requestedId) ? requestedId : `custom-${slug(name)}-${Date.now().toString(36)}`;
      const previous = existing.find((recipe) => isSameRecipe(recipe, baseId, owner));
      const recipe: CustomRecipe = omitUndefined({
        ...(previous || {}),
        id: baseId,
        name,
        description: cleanText(safeInput.description || safeInput.prompt, 500),
        output: cleanText(safeInput.output, 120) || 'DOCX + TXT',
        riskLevel: cleanRiskLevel(safeInput.riskLevel),
        requiresSources: typeof safeInput.requiresSources === 'boolean' ? safeInput.requiresSources : false,
        format: cleanFormat(safeInput.format),
        custom: true as const,
        tenantId: owner.tenantId,
        userId: owner.userId,
        sourceRunId: cleanText(safeInput.sourceRunId, 120) || null,
        prompt: cleanText(safeInput.prompt, 4000),
        steps: cleanSteps(safeInput.steps),
        artifacts: cleanArtifacts(safeInput.artifacts),
        redacted: true as const,
        createdAt: previous?.createdAt || now,
        updatedAt: now,
      });
      const validatedRecipe = cloneCustomRecipe(recipe);
      writeAll([
        ...existing.filter((item) => !isSameRecipe(item, recipe.id, owner)),
        validatedRecipe,
      ], operation);
      return cloneCustomRecipe(validatedRecipe);
    },
  };
}
