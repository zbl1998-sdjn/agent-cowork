import fs from 'node:fs';
import path from 'node:path';

// @ts-check

const RECIPE_ID_RE = /^[a-z0-9_-]+$/i;

/**
 * @typedef {{ index?: unknown, tool?: unknown, status?: unknown, args?: unknown, result?: unknown, summary?: unknown }} CapturedStep
 * @typedef {{ path?: unknown, kind?: unknown, source?: unknown }} CapturedArtifact
 * @typedef {{ id: string, name: string, description: string, output: string, riskLevel: string, custom: true, tenantId: string, userId: string, sourceRunId: string | null, prompt: string, steps: CapturedStep[], artifacts: CapturedArtifact[], redacted: true, createdAt: string, updatedAt: string }} CustomRecipe
 * @typedef {{ tenantId?: unknown, userId?: unknown }} RecipeScope
 */

/** @param {unknown} value @param {number} max @returns {string} */
function cleanText(value, max) {
  return String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
}

/** @param {unknown} value @returns {string} */
function slug(value) {
  return cleanText(value, 80).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'captured';
}

/** @param {unknown} value @returns {CapturedStep[]} */
function cleanSteps(value) {
  return (Array.isArray(value) ? value : []).slice(0, 40).map((step, index) => {
    const record = /** @type {Record<string, unknown>} */ (step && typeof step === 'object' ? step : {});
    return {
      index,
      tool: cleanText(record.tool, 120),
      status: cleanText(record.status, 80) || undefined,
      args: record.args,
      result: record.result,
      summary: record.summary,
    };
  });
}

/** @param {unknown} value @returns {CapturedArtifact[]} */
function cleanArtifacts(value) {
  return (Array.isArray(value) ? value : []).slice(0, 80).map((artifact) => {
    const record = /** @type {Record<string, unknown>} */ (artifact && typeof artifact === 'object' ? artifact : {});
    return {
      path: cleanText(record.path, 500),
      kind: cleanText(record.kind, 80) || 'file',
      source: record.source,
    };
  }).filter((artifact) => artifact.path);
}

/** @param {unknown} error @returns {Error & { statusCode?: number }} */
function httpError(error) {
  const err = error instanceof Error ? error : new Error(String(error));
  return /** @type {Error & { statusCode?: number }} */ (err);
}

/** @param {{ storePath: string }} options */
export function createCustomRecipeStore({ storePath }) {
  const filePath = path.resolve(storePath);

  /** @returns {CustomRecipe[]} */
  function readAll() {
    try {
      if (!fs.existsSync(filePath)) return [];
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return Array.isArray(parsed?.recipes) ? parsed.recipes : [];
    } catch {
      return [];
    }
  }

  /** @param {CustomRecipe[]} recipes */
  function writeAll(recipes) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify({ recipes }, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, filePath);
  }

  /** @param {RecipeScope} [scope] @returns {CustomRecipe[]} */
  function list({ tenantId } = {}) {
    const tenant = cleanText(tenantId || 'tenant_local', 96);
    return readAll().filter((recipe) => recipe.tenantId === tenant).map((recipe) => ({ ...recipe }));
  }

  return {
    list,
    /** @param {string} id @param {RecipeScope} [scope] @returns {CustomRecipe | null} */
    get(id, scope = {}) {
      if (!RECIPE_ID_RE.test(id || '')) return null;
      return list(scope).find((recipe) => recipe.id === id) || null;
    },
    /** @param {Record<string, unknown>} input @param {RecipeScope} [scope] @returns {CustomRecipe} */
    save(input, { tenantId, userId } = {}) {
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
      /** @type {CustomRecipe} */
      const recipe = {
        ...(previous || {}),
        id: baseId,
        name,
        description: cleanText(input.description || input.prompt, 500),
        output: 'Markdown',
        riskLevel: 'safe-write',
        custom: /** @type {true} */ (true),
        tenantId: tenant,
        userId: user,
        sourceRunId: cleanText(input.sourceRunId, 120) || null,
        prompt: cleanText(input.prompt, 4000),
        steps: cleanSteps(input.steps),
        artifacts: cleanArtifacts(input.artifacts),
        redacted: /** @type {true} */ (true),
        createdAt: previous?.createdAt || now,
        updatedAt: now,
      };
      writeAll([...existing.filter((item) => !(item.id === recipe.id && item.tenantId === tenant)), recipe]);
      return { ...recipe };
    },
  };
}
