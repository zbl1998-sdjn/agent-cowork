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
  assert.equal(recipes.length, 14);
  assert.deepEqual(recipes.map((recipe) => recipe.id), [
    'meeting-actions',
    'excel-cleaning',
    'reimbursement',
    'folder-organize',
    'contract-summary',
    'feedback-clusters',
    'summary-report',
    'email-draft',
    'boss-summary-onepager',
    'weekly-report-beginner',
    'excel-rescue-basic',
    'word-make-formal',
    'ppt-from-folder-beginner',
    'chat-to-action-list',
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

test('meeting-actions builds grounded text, document, and spreadsheet operations', () => {
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

  assert.equal(operations.length, 3);
  const text = textContent(operationWithExt(operations, '.txt'), 'meeting text');
  assert.match(text, /会议纪要行动项/);
  assert.match(text, /meeting\.md \(markdown\)/);
  assert.match(text, /负责人: 李雷/);
  assert.match(text, /2026-06-30/);

  assert.ok(decodedBase64(operationWithExt(operations, '.xlsx'), 'meeting workbook').length > 100);
  assert.ok(decodedBase64(operationWithExt(operations, '.docx'), 'meeting docx').toString('latin1').startsWith('PK'));
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
  assert.equal(excelOperations.length, 4);
  const excelText = textContent(operationWithExt(excelOperations, '.txt'), 'excel report');
  assert.match(excelText, /表格清洗结论/);
  assert.match(excelText, /用户指令: 清洗表格/);
  assert.match(excelText, /需人工确认: \d+/);
  assert.ok(decodedBase64(operationWithExt(excelOperations, '.xlsx'), 'cleaned workbook').length > 100);
  assert.match(textContent(operationWithExt(excelOperations, '.csv'), 'cleaned csv'), /^行号,name,amount,清洗状态/m);
  assert.ok(decodedBase64(operationWithExt(excelOperations, '.docx'), 'excel docx').toString('latin1').startsWith('PK'));

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
  assert.equal(reimbursementOperations.length, 4);
  const csv = textContent(operationWithExt(reimbursementOperations, '.csv'), 'reimbursement csv');
  assert.match(csv, /^序号,供应商\/项目,金额,状态,来源摘录/m);
  assert.match(csv, /ACME,123\.45,待核验发票/);
  assert.match(csv, /费用说明 invoice,,缺少金额/);

  assert.ok(decodedBase64(operationWithExt(reimbursementOperations, '.xlsx'), 'reimbursement workbook').length > 100);
  const text = textContent(operationWithExt(reimbursementOperations, '.txt'), 'reimbursement text');
  assert.match(text, /报销材料核验/);
  assert.match(text, /费用说明 invoice: 缺少金额/);
  assert.ok(decodedBase64(operationWithExt(reimbursementOperations, '.docx'), 'reimbursement docx').toString('latin1').startsWith('PK'));
});

test('summary-report emits text and Office/PDF artifacts with fallback content', () => {
  const operations = buildRecipeOperations({
    recipeId: 'summary-report',
    trustedRoot: root,
    prompt: '',
    sources: [],
  });

  assert.equal(operations.length, 4);
  const text = textContent(operationWithExt(operations, '.txt'), 'summary text');
  assert.match(text, /总结报告/);
  assert.match(text, /用户指令: 未填写/);
  assert.match(text, /暂无可读取正文/);

  assert.ok(decodedBase64(operationWithExt(operations, '.docx'), 'summary docx').toString('latin1').startsWith('PK'));
  assert.ok(decodedBase64(operationWithExt(operations, '.pptx'), 'summary pptx').toString('latin1').startsWith('PK'));
  assert.ok(decodedBase64(operationWithExt(operations, '.pdf'), 'summary pdf').toString('latin1').startsWith('%PDF-1.4'));
});

test('email-draft emits local-first subject suggestions and copyable draft', () => {
  const operations = buildRecipeOperations({
    recipeId: 'email-draft',
    trustedRoot: root,
    prompt: '跟进客户报价,语气礼貌简洁',
    sources: [{ relativePath: 'quote.txt', content: '客户上周询问 7 月交付报价,需要提醒对方确认预算。' }],
  });

  assert.equal(operations.length, 2);
  const text = textContent(operationWithExt(operations, '.txt'), 'email draft text');
  assert.match(text, /主题建议/);
  assert.match(text, /可复制邮件正文/);
  assert.match(text, /跟进/);
  assert.match(text, /系统只生成草稿,不会自动连接邮箱或发送/);
  assert.ok(decodedBase64(operationWithExt(operations, '.docx'), 'email docx').toString('latin1').startsWith('PK'));
});

test('beginner office recipes emit copy-first approval artifacts', () => {
  const weeklyOperations = buildRecipeOperations({
    recipeId: 'weekly-report-beginner',
    trustedRoot: root,
    prompt: '本周完成客户回访，下周准备复盘',
    sources: [],
  });
  assert.equal(weeklyOperations.length, 3);
  const weeklyText = textContent(operationWithExt(weeklyOperations, '.txt'), 'weekly report text');
  assert.match(weeklyText, /本周完成/);
  assert.match(weeklyText, /原文件没有被修改/);
  assert.ok(decodedBase64(operationWithExt(weeklyOperations, '.docx'), 'weekly docx').toString('latin1').startsWith('PK'));
  assert.ok(decodedBase64(operationWithExt(weeklyOperations, '.pdf'), 'weekly pdf').toString('latin1').startsWith('%PDF-1.4'));

  const bossOperations = buildRecipeOperations({
    recipeId: 'boss-summary-onepager',
    trustedRoot: root,
    prompt: '整理项目进展给老板',
    sources: [{ relativePath: 'progress.txt', content: '上线完成 80%\n风险是数据口径待确认' }],
  });
  const bossText = textContent(operationWithExt(bossOperations, '.txt'), 'boss onepager text');
  assert.match(bossText, /给老板看的一页总结/);
  assert.match(bossText, /下一步/);
  assert.ok(decodedBase64(operationWithExt(bossOperations, '.docx'), 'boss docx').toString('latin1').startsWith('PK'));

  const formalOperations = buildRecipeOperations({
    recipeId: 'word-make-formal',
    trustedRoot: root,
    prompt: '老板让大家赶紧弄完报销',
    sources: [],
  });
  const formalText = textContent(operationWithExt(formalOperations, '.txt'), 'formal text');
  assert.match(formalText, /领导/);
  assert.match(formalText, /请尽快/);
  assert.match(textContent(operationWithExt(formalOperations, '.md'), 'formal notes'), /修改说明/);

  const pptOperations = buildRecipeOperations({
    recipeId: 'ppt-from-folder-beginner',
    trustedRoot: root,
    prompt: '做一个项目复盘 PPT',
    sources: [{ relativePath: 'notes.md', content: '- 目标达成\n- 需要补充预算' }],
  });
  assert.equal(pptOperations.length, 3);
  assert.ok(decodedBase64(operationWithExt(pptOperations, '.pptx'), 'beginner pptx').toString('latin1').startsWith('PK'));
  assert.ok(decodedBase64(operationWithExt(pptOperations, '.docx'), 'beginner ppt notes').toString('latin1').startsWith('PK'));
  assert.match(textContent(operationWithExt(pptOperations, '.txt'), 'beginner ppt text'), /汇报讲稿草稿/);

  const chatOperations = buildRecipeOperations({
    recipeId: 'chat-to-action-list',
    trustedRoot: root,
    prompt: '整理群待办',
    sources: [{ relativePath: 'chat.txt', content: '待办：负责人:小王 2026-07-08 提交合同清单' }],
  });
  assert.equal(chatOperations.length, 2);
  assert.ok(decodedBase64(operationWithExt(chatOperations, '.xlsx'), 'chat action workbook').length > 100);
  assert.match(textContent(operationWithExt(chatOperations, '.txt'), 'chat action draft'), /群消息确认草稿/);
});

test('generic and unknown recipe paths fail closed without inventing source text', () => {
  const customRecipe: Recipe = {
    id: 'custom-brief',
    name: '自定义简报',
    description: '自定义模板',
    output: 'DOCX + TXT',
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

  assert.equal(operations.length, 3);
  const text = textContent(operationWithExt(operations, '.txt'), 'custom text');
  assert.match(text, /自定义简报/);
  assert.match(text, /用户指令: 未填写/);
  assert.match(text, /未提供可读取来源文件/);
  assert.match(text, /暂无可读取正文/);
  assert.ok(decodedBase64(operationWithExt(operations, '.docx'), 'custom docx').toString('latin1').startsWith('PK'));

  assert.throws(() => buildRecipeOperations(), /Unknown recipe: undefined/);
  assert.throws(() => buildRecipeOperations({ recipeId: 'does-not-exist', trustedRoot: root }), /Unknown recipe: does-not-exist/);
});
