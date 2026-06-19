import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { buildRecipeOperations, getRecipe, listRecipes } from '../src/recipes/registry.js';
import type { Recipe } from '../src/recipes/registry.js';
import type { FileOperationInput } from '../src/workspace/file-operations.js';

const root = path.resolve('C:/workspace');

function operationWithExt(operations: readonly FileOperationInput[], ext: string): FileOperationInput {
  const operation = operations.find((item) => item.path?.endsWith(ext));
  assert.ok(operation, `${ext} operation should exist`);
  assert.equal(operation.type, 'write');
  return operation;
}

function textContent(operation: FileOperationInput, label: string): string {
  const content = operation.content;
  if (typeof content !== 'string') {
    throw new Error(`${label} should carry text content`);
  }
  return content;
}

function decodedBase64(operation: FileOperationInput, label: string): Buffer {
  assert.equal(operation.encoding, 'base64', `${label} should be base64 encoded`);
  const contentBase64 = operation.contentBase64;
  if (typeof contentBase64 !== 'string') {
    throw new Error(`${label} should carry contentBase64`);
  }
  return Buffer.from(contentBase64, 'base64');
}

test('recipe registry exposes a defensive catalog and nulls unknown recipes', () => {
  const recipes = listRecipes();
  assert.equal(recipes.length, 8);
  assert.deepEqual(recipes.map((recipe) => recipe.id), [
    'meeting-actions',
    'excel-cleaning',
    'reimbursement',
    'folder-organize',
    'contract-summary',
    'feedback-clusters',
    'summary-report',
    'email-draft',
  ]);

  const meeting = getRecipe('meeting-actions');
  assert.ok(meeting);
  assert.equal(meeting.requiresSources, true);
  assert.equal(getRecipe('does-not-exist'), null);

  const firstRecipe = recipes[0];
  assert.ok(firstRecipe);
  firstRecipe.name = 'mutated locally';
  assert.equal(listRecipes()[0]?.name, '会议纪要转行动项');
});

test('meeting-actions builds grounded markdown and spreadsheet operations', () => {
  const operations = buildRecipeOperations({
    recipeId: 'meeting-actions',
    trustedRoot: root,
    prompt: '提取负责人和日期',
    sources: [
      {
        relativePath: 'meeting.md',
        kind: 'markdown',
        content: '- 待办：负责人:李雷 2026-06-30 完成上线核对\n- 普通背景说明',
      },
    ],
  });

  assert.equal(operations.length, 2);
  const markdown = textContent(operationWithExt(operations, '.md'), 'meeting markdown');
  assert.match(markdown, /# 会议纪要行动项/);
  assert.match(markdown, /meeting\.md \(markdown\)/);
  assert.match(markdown, /负责人: 李雷/);
  assert.match(markdown, /2026-06-30/);

  assert.ok(decodedBase64(operationWithExt(operations, '.xlsx'), 'meeting workbook').length > 100);
});

test('excel-cleaning and reimbursement recipes preserve issue summaries and source evidence', () => {
  const excelOperations = buildRecipeOperations({
    recipeId: 'excel-cleaning',
    trustedRoot: root,
    prompt: '清洗表格',
    sources: [
      {
        relativePath: 'table.csv',
        kind: 'csv',
        content: 'name,amount\nAlice,10\nAlice,10\nBob,',
      },
    ],
  });
  assert.equal(excelOperations.length, 2);
  const excelMarkdown = textContent(operationWithExt(excelOperations, '.md'), 'excel report');
  assert.match(excelMarkdown, /# 表格清洗报告/);
  assert.match(excelMarkdown, /- 用户指令: 清洗表格/);
  assert.match(excelMarkdown, /- 需人工确认: \d+/);
  assert.match(excelMarkdown, /table\.csv \(csv\)/);
  assert.ok(decodedBase64(operationWithExt(excelOperations, '.xlsx'), 'cleaned workbook').length > 100);

  const reimbursementOperations = buildRecipeOperations({
    recipeId: 'reimbursement',
    trustedRoot: root,
    prompt: '核验报销材料',
    sources: [
      {
        relativePath: 'receipts.txt',
        content: 'ACME, 发票 金额 ¥123.45\n费用说明 invoice',
      },
    ],
  });
  assert.equal(reimbursementOperations.length, 2);
  const csv = textContent(operationWithExt(reimbursementOperations, '.csv'), 'reimbursement csv');
  assert.match(csv, /^序号,供应商\/项目,金额,状态,来源摘录/m);
  assert.match(csv, /ACME,123\.45,待核验发票/);
  assert.match(csv, /费用说明 invoice,,缺少金额/);

  const markdown = textContent(operationWithExt(reimbursementOperations, '.md'), 'reimbursement markdown');
  assert.match(markdown, /# 报销材料核验/);
  assert.match(markdown, /- 费用说明 invoice: 缺少金额/);
});

test('summary-report emits markdown and Office/PDF artifacts with fallback content', () => {
  const operations = buildRecipeOperations({
    recipeId: 'summary-report',
    trustedRoot: root,
    prompt: '',
    sources: [],
  });

  assert.equal(operations.length, 4);
  const markdown = textContent(operationWithExt(operations, '.md'), 'summary markdown');
  assert.match(markdown, /# 总结报告/);
  assert.match(markdown, /- 用户指令: 未填写/);
  assert.match(markdown, /暂无可读取正文/);

  assert.ok(decodedBase64(operationWithExt(operations, '.docx'), 'summary docx').toString('latin1').startsWith('PK'));
  assert.ok(decodedBase64(operationWithExt(operations, '.pptx'), 'summary pptx').toString('latin1').startsWith('PK'));
  assert.ok(decodedBase64(operationWithExt(operations, '.pdf'), 'summary pdf').toString('latin1').startsWith('%PDF-1.4'));
});

test('generic and unknown recipe paths fail closed without inventing source text', () => {
  const customRecipe: Recipe = {
    id: 'custom-brief',
    name: '自定义简报',
    description: '自定义模板',
    output: 'Markdown',
    riskLevel: 'safe-write',
    custom: true,
  };
  const operations = buildRecipeOperations({
    recipeId: 'ignored-by-provided-recipe',
    trustedRoot: root,
    prompt: '',
    sources: [],
    recipe: customRecipe,
  });

  assert.equal(operations.length, 1);
  const markdown = textContent(operationWithExt(operations, '.md'), 'custom markdown');
  assert.match(markdown, /# 自定义简报/);
  assert.match(markdown, /- 用户指令: 未填写/);
  assert.match(markdown, /- 未提供可读取来源文件/);
  assert.match(markdown, /暂无可读取正文/);

  assert.throws(() => buildRecipeOperations(), /Unknown recipe: undefined/);
  assert.throws(() => buildRecipeOperations({ recipeId: 'does-not-exist', trustedRoot: root }), /Unknown recipe: does-not-exist/);
});
