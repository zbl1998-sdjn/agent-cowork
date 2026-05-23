import { listRecipes } from '../recipes/registry.js';

// Skill registry: turns the recipe catalog into installable/toggleable "skills"
// with a manifest (trigger keywords, permissions, output types) and an
// enabled/disabled state. This is the seam toward a real skill/plugin system
// (the Claude Cowork skills + marketplace direction) without changing how
// recipes execute.

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

function manifestFor(recipe) {
  return MANIFEST[recipe.id] || {
    trigger: String(recipe.id || '').split('-').filter(Boolean),
    permissions: ['read-files', 'write-files'],
    outputs: ['plan'],
  };
}

export function createSkillRegistry({ recipes = listRecipes(), initialDisabled = [] } = {}) {
  const disabled = new Set(initialDisabled);

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
