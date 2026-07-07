// 模型驱动 recipe 提取(AI 办公助手 slice 1)——纯解析逻辑单测 + 真实 Ollama e2e(可跳过)
import assert from 'node:assert/strict';
import test from 'node:test';
import { extractJson, normalizeActionItems, extractMeetingActions, normalizeSummary, normalizeContract } from '../src/recipes/model-recipe.js';

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
