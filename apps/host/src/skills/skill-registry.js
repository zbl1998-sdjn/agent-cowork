// 技能注册表(host · L1 领域层 · skills)
// ---------------------------------------------------------------------------
// 职责:把配方目录包装成可安装/可开关的「技能」,带清单(触发词、权限、输出类型)与启用状态。
//       这是通向真正技能/插件系统(技能 + 市场方向)的接缝,而不改变配方的执行方式。
// 依赖:同层 recipes/registry。导出:createSkillRegistry。
import { listRecipes } from '../recipes/registry.js';

// Skill registry: turns the recipe catalog into installable/toggleable "skills"
// with a manifest (trigger keywords, permissions, output types) and an
// enabled/disabled state. This is the seam toward a real skill/plugin system
// (the Claude Cowork skills + marketplace direction) without changing how
// recipes execute.
// @ts-check

/**
 * @typedef {{ id: string, name: string, description?: string }} RecipeDescriptor
 * @typedef {{ trigger: string[], permissions: string[], outputs: string[] }} SkillManifest
 * @typedef {{ id: string, name: string, description: string, kind: 'recipe', trigger: string[], permissions: string[], outputs: string[], enabled: boolean }} SkillDescriptor
 * @typedef {{ recipes?: RecipeDescriptor[], initialDisabled?: Iterable<string> }} SkillRegistryOptions
 * @typedef {{ list(): SkillDescriptor[], get(id: string): SkillDescriptor | null, isEnabled(id: string): boolean, setEnabled(id: string, enabled: boolean): SkillDescriptor, enabledSkills(): SkillDescriptor[] }} SkillRegistry
 */

/** @type {Record<string, SkillManifest>} */
const MANIFEST = {
  'meeting-actions': { trigger: ['会议', '纪要', '行动项', 'meeting'], permissions: ['read-files', 'write-files'], outputs: ['xlsx', 'plan'] },
  'excel-cleaning': { trigger: ['表格', '清洗', 'excel', 'csv'], permissions: ['read-files', 'write-files'], outputs: ['xlsx'] },
  'reimbursement': { trigger: ['报销', '发票', '供应商'], permissions: ['read-files', 'write-files'], outputs: ['xlsx', 'plan'] },
  'folder-organize': { trigger: ['整理', '文件夹', '归类'], permissions: ['read-files'], outputs: ['plan'] },
  'contract-summary': { trigger: ['合同', '摘要', '风险'], permissions: ['read-files'], outputs: ['md'] },
  'feedback-clusters': { trigger: ['反馈', '聚类', '主题'], permissions: ['read-files'], outputs: ['md'] },
  'summary-report': { trigger: ['总结', '周报', '报告'], permissions: ['read-files', 'write-files'], outputs: ['md', 'docx'] },
  'email-draft': { trigger: ['邮件', '草稿', 'email'], permissions: ['read-files'], outputs: ['md'] },
};

/** @param {RecipeDescriptor} recipe @returns {SkillManifest} */
function manifestFor(recipe) {
  return MANIFEST[recipe.id] || {
    trigger: String(recipe.id || '').split('-').filter(Boolean),
    permissions: ['read-files', 'write-files'],
    outputs: ['plan'],
  };
}

/** @param {SkillRegistryOptions} [options] @returns {SkillRegistry} */
export function createSkillRegistry({ recipes = listRecipes(), initialDisabled = [] } = {}) {
  const disabled = new Set(initialDisabled);

  /** @param {RecipeDescriptor} recipe @returns {SkillDescriptor} */
  function toSkill(recipe) {
    const manifest = manifestFor(recipe);
    return {
      id: recipe.id,
      name: recipe.name,
      description: recipe.description || '',
      kind: 'recipe',
      trigger: manifest.trigger,
      permissions: manifest.permissions,
      outputs: manifest.outputs,
      enabled: !disabled.has(recipe.id),
    };
  }

  /** @param {string} id @returns {RecipeDescriptor | null} */
  function find(id) {
    return recipes.find((r) => r.id === id) || null;
  }

  return {
    list() {
      return recipes.map(toSkill);
    },
    get(id) {
      const recipe = find(id);
      return recipe ? toSkill(recipe) : null;
    },
    isEnabled(id) {
      return !disabled.has(id);
    },
    setEnabled(id, enabled) {
      const recipe = find(id);
      if (!recipe) {
        /** @type {Error & { statusCode?: number }} */
        const err = new Error(`skill not found: ${id}`);
        err.statusCode = 404;
        throw err;
      }
      if (enabled) {
        disabled.delete(id);
      } else {
        disabled.add(id);
      }
      return toSkill(recipe);
    },
    enabledSkills() {
      return this.list().filter((s) => s.enabled);
    },
  };
}
