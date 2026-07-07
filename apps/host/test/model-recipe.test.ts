// 模型驱动 recipe 提取(AI 办公助手 slice 1)——纯解析逻辑单测 + 真实 Ollama e2e(可跳过)
import assert from 'node:assert/strict';
import test from 'node:test';
import { extractJson, normalizeActionItems, extractMeetingActions, normalizeSummary, normalizeContract, normalizeClusters, normalizeWeekly, normalizeTable } from '../src/recipes/model-recipe.js';

test('extractJson: 容忍 ```json 包裹、前后噪声、括号配平', () => {
  assert.deepEqual(extractJson('```json\n[{"a":1}]\n```'), [{ a: 1 }]);
  assert.deepEqual(extractJson('好的,结果如下:[{"task":"x"}] 完毕'), [{ task: 'x' }]);
  assert.deepEqual(extractJson('{"items":[{"task":"a"}]}'), { items: [{ task: 'a' }] });
  assert.equal(extractJson('没有 json'), null);
  assert.equal(extractJson('[坏的 json'), null); // 不配平 → null
});

test('normalizeActionItems: 字段别名归一 + 过滤空 task + 容忍非数组', () => {
  const items = normalizeActionItems([
    { 负责人: '张三', 待办: '联调', 截止: '周三' },
    { owner: '李四', task: '提交审批' },       // due 缺 → 未定
    { owner: '王五', task: '' },               // 空 task → 过滤
  ]);
  assert.equal(items.length, 2);
  assert.deepEqual(items[0], { owner: '张三', task: '联调', due: '周三' });
  assert.equal(items[1]?.due, '未定');
  // {items:[...]} 包裹也认
  assert.equal(normalizeActionItems({ items: [{ task: 'x' }] }).length, 1);
  assert.equal(normalizeActionItems('乱七八糟').length, 0);
});

test('extractMeetingActions: 空源直接返回 null(不调模型)', async () => {
  const r = await extractMeetingActions({ source: '   ', modelConfig: { provider: 'ollama', model: 'x', baseUrl: 'http://127.0.0.1:1/v1' } });
  assert.equal(r, null);
});

test('extractMeetingActions: 注入的 modelCall 返回 JSON → 结构化行动项', async () => {
  const fakeCall = async () => ({ content: '[{"owner":"张三","task":"联调登录","due":"周三"}]' });
  const r = await extractMeetingActions({ source: '会议记录...', modelConfig: { provider: 'x', model: 'y', baseUrl: 'z' }, modelCall: fakeCall as never });
  assert.equal(r?.length, 1);
  assert.equal(r?.[0]?.owner, '张三');
});

test('extractMeetingActions: modelCall 抛错 → null(调用方回退模板)', async () => {
  const boom = async () => { throw new Error('model down'); };
  const r = await extractMeetingActions({ source: '会议记录...', modelConfig: { provider: 'x', model: 'y', baseUrl: 'z' }, modelCall: boom as never });
  assert.equal(r, null);
});

test('normalizeSummary: 字段别名归一 + 全空返回 null', () => {
  const s = normalizeSummary({ 标题: '周报', 要点: ['完成登录'], 风险: ['验收待补'], 下一步: ['联调'] });
  assert.equal(s?.title, '周报');
  assert.deepEqual(s?.keyPoints, ['完成登录']);
  assert.deepEqual(s?.risks, ['验收待补']);
  assert.equal(normalizeSummary({ title: '空的' }), null); // 三段全空 → null(回退模板)
  assert.equal(normalizeSummary('乱码'), null);
});

test('normalizeContract: 关键字段全空返回 null,有内容则归一', () => {
  const c = normalizeContract({ 主体: '甲乙双方', 金额: '100万', 义务: ['按期交付'], 风险: ['违约金过高'] });
  assert.equal(c?.parties, '甲乙双方');
  assert.equal(c?.amount, '100万');
  assert.deepEqual(c?.obligations, ['按期交付']);
  assert.equal(normalizeContract({}), null);       // 全空 → null
  assert.equal(normalizeContract(null), null);
});

test('normalizeClusters: 主题聚类归一 + 数量兜底 + 空返回 null', () => {
  const c = normalizeClusters([
    { 主题: '登录慢', 严重度: '高', 数量: 5, 建议: '优化查询' },
    { theme: '界面卡', count: 0 },                  // count 非法 → 兜底 1;severity/suggestion 缺 → 默认
    { severity: '低' },                             // 无 theme → 过滤
  ]);
  assert.equal(c?.length, 2);
  assert.deepEqual(c?.[0], { theme: '登录慢', severity: '高', count: 5, suggestion: '优化查询' });
  assert.equal(c?.[1]?.count, 1);
  assert.equal(c?.[1]?.severity, '中');
  assert.equal(normalizeClusters({ clusters: [{ theme: 'x' }] })?.length, 1); // {clusters:[...]} 包裹
  assert.equal(normalizeClusters([]), null);
  assert.equal(normalizeClusters('乱码'), null);
});

test('normalizeWeekly: 四段别名归一 + 全空返回 null', () => {
  const w = normalizeWeekly({ 标题: '周报', 本周完成: ['登录上线'], 进行中: ['联调'], 下周计划: ['压测'], 风险: ['人手不足'] });
  assert.equal(w?.title, '周报');
  assert.deepEqual(w?.done, ['登录上线']);
  assert.deepEqual(w?.next, ['压测']);
  assert.equal(normalizeWeekly({ title: '空周报' }), null); // 四段全空 → null
  assert.equal(normalizeWeekly(null), null);
});

test('normalizeTable: 列/行归一 + 按列数补齐截断 + 过滤空行', () => {
  const t = normalizeTable({
    columns: ['姓名', '部门', '金额'],
    rows: [
      ['张三', '研发', '1000'],
      ['李四', '市场'],              // 缺 1 列 → 补齐为 ''
      ['王五', '销售', '2000', '多余'], // 多 1 列 → 截断
      ['', '', ''],                   // 全空 → 过滤
    ],
    issues: ['第2行金额缺失'],
  });
  assert.deepEqual(t?.columns, ['姓名', '部门', '金额']);
  assert.equal(t?.rows.length, 3);
  assert.deepEqual(t?.rows[1], ['李四', '市场', '']);       // 补齐
  assert.deepEqual(t?.rows[2], ['王五', '销售', '2000']);   // 截断
  assert.deepEqual(t?.issues, ['第2行金额缺失']);
  assert.equal(normalizeTable({ columns: [] }), null);       // 无列 → null
  assert.equal(normalizeTable({ columns: ['a'], rows: [] }), null); // 无有效行 → null
  assert.equal(normalizeTable('乱码'), null);
});
