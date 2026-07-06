// 自定义配方存储(host · L1 领域层 · recipes)
// ---------------------------------------------------------------------------
// 职责:把用户从一次运行「捕获」出来的自定义配方,按租户/用户隔离地持久化(增删查)。
//       内容已脱敏(redacted)。供「把这次操作存成我的配方」能力使用。
// 依赖:node:fs/path。导出:createCustomRecipeStore。
import fs from 'node:fs';
import path from 'node:path';
import { omitUndefined } from '../util/object.js';

const RECIPE_ID_RE = /^[a-z0-9_-]+$/i;

type CapturedStep = {
  index: number;
  tool: string;
  status?: string;
  args?: unknown;
  result?: unknown;
  summary?: unknown;
};

type CapturedArtifact = {
  path: string;
  kind: string;
  source?: unknown;
};

export type CustomRecipeFormat = {
  kind: 'markdown';
  body: string;
};

export type CustomRecipe = {
  id: string;
  name: string;
  description: string;
  output: string;
  riskLevel: string;
  requiresSources?: boolean;
  format?: CustomRecipeFormat;
  custom: true;
  tenantId: string;
  userId: string;
  sourceRunId: string | null;
  prompt: string;
  steps: CapturedStep[];
  artifacts: CapturedArtifact[];
  redacted: true;
  createdAt: string;
  updatedAt: string;
};

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
    return {
      path: cleanText(record.path, 500),
      kind: cleanText(record.kind, 80) || 'file',
      source: record.source,
    };
  }).filter((artifact) => Boolean(artifact.path));
}

function httpError(error: unknown): Error & { statusCode?: number } {
  return error instanceof Error ? error : new Error(String(error));
}

/** 创建自定义配方存储(按 tenant/user 作用域增删查并持久化到 JSON)。 */
export function createCustomRecipeStore({ storePath }: { storePath: string }): CustomRecipeStore {
  const filePath = path.resolve(storePath);

  function readAll(): CustomRecipe[] {
    try {
      if (!fs.existsSync(filePath)) {
        return [];
      }
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as { recipes?: unknown };
      return Array.isArray(parsed.recipes) ? parsed.recipes as CustomRecipe[] : [];
    } catch {
      return [];
    }
  }

  function writeAll(recipes: CustomRecipe[]): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify({ recipes }, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, filePath);
  }

  function list({ tenantId }: RecipeScope = {}): CustomRecipe[] {
    const tenant = cleanText(tenantId || 'tenant_local', 96);
    return readAll().filter((recipe) => recipe.tenantId === tenant).map((recipe) => ({ ...recipe }));
  }

  return {
    list,
    get(id: string, scope: RecipeScope = {}): CustomRecipe | null {
      if (!RECIPE_ID_RE.test(id || '')) {
        return null;
      }
      return list(scope).find((recipe) => recipe.id === id) || null;
    },
    save(input: Record<string, unknown>, { tenantId, userId }: RecipeScope = {}): CustomRecipe {
      if (input.redacted !== true) {
        const err = httpError(new Error('Recipe draft must be redacted before saving'));
        err.statusCode = 400;
        throw err;
      }
      const tenant = cleanText(tenantId || 'tenant_local', 96);
      const user = cleanText(userId || 'user_local', 96);
      const now = new Date().toISOString();
      const name = cleanText(input.name, 120) || '自定义技能';
      const existing = readAll();
      const requestedId = cleanText(input.id, 120);
      const baseId = requestedId && RECIPE_ID_RE.test(requestedId) ? requestedId : `custom-${slug(name)}-${Date.now().toString(36)}`;
      const previous = existing.find((recipe) => recipe.id === baseId && recipe.tenantId === tenant);
      const recipe: CustomRecipe = omitUndefined({
        ...(previous || {}),
        id: baseId,
        name,
        description: cleanText(input.description || input.prompt, 500),
        output: cleanText(input.output, 120) || 'DOCX + TXT',
        riskLevel: cleanRiskLevel(input.riskLevel),
        requiresSources: typeof input.requiresSources === 'boolean' ? input.requiresSources : false,
        format: cleanFormat(input.format),
        custom: true as const,
        tenantId: tenant,
        userId: user,
        sourceRunId: cleanText(input.sourceRunId, 120) || null,
        prompt: cleanText(input.prompt, 4000),
        steps: cleanSteps(input.steps),
        artifacts: cleanArtifacts(input.artifacts),
        redacted: true as const,
        createdAt: previous?.createdAt || now,
        updatedAt: now,
      });
      writeAll([...existing.filter((item) => !(item.id === recipe.id && item.tenantId === tenant)), recipe]);
      return { ...recipe };
    },
  };
}
