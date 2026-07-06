import { describe, expect, it } from 'vitest';
import { MODEL_HIGHLIGHTS, highlightsForProvider, type ModelTag } from './model-highlights';

const VALID_TAGS = new Set<ModelTag>([
  '旗舰', '平衡', '轻量', '免费', '推理', '代码', '多模态', '视觉',
  '长上下文', '高速', 'Agent', '联网搜索', '创意', '聚合', '本地',
]);

const VALID_MODALITIES = new Set(['语言', '多模态']);

const STALE_HIGHLIGHT_IDS = new Set([
  'kimi-k2-thinking',
  'kimi-k2-turbo-preview',
  'deepseek-r1',
  'deepseek-r1:7b',
  'deepseek-ai/DeepSeek-R1',
  'deepseek-chat',
  'deepseek-reasoner',
  'gemini-3-pro-preview',
  'grok-4.20-0309-reasoning',
  'grok-4.20-0309-non-reasoning',
  'gpt-5.2',
  'gpt-5.2-codex',
  'gpt-5-pro',
  'gpt-image-1',
  'doubao-1.5-thinking-pro',
  'doubao-1.5-vision-pro',
  'generalv3.5',
  'anthropic/claude-sonnet-4.5',
  'openai/gpt-5.2',
  'deepseek/deepseek-chat',
]);

describe('model-highlights', () => {
  it('covers the 22 catalog providers with 1–8 curated models each', () => {
    const providers = Object.keys(MODEL_HIGHLIGHTS);
    expect(providers.length).toBe(22);
    for (const [id, models] of Object.entries(MODEL_HIGHLIGHTS)) {
      expect(models.length, `${id} 模型数`).toBeGreaterThanOrEqual(1);
      expect(models.length, `${id} 模型数`).toBeLessThanOrEqual(8);
    }
  });

  it('每个精选模型都有 id、合法标签、特点说明', () => {
    for (const [providerId, models] of Object.entries(MODEL_HIGHLIGHTS)) {
      for (const m of models) {
        expect(m.id, `${providerId} 模型 id`).toBeTruthy();
        expect(m.note, `${providerId}/${m.id} 特点`).toBeTruthy();
        expect(VALID_MODALITIES.has(m.modality), `${providerId}/${m.id} 模态缺失`).toBe(true);
        expect(m.context, `${providerId}/${m.id} 上下文窗口`).toBeTruthy();
        expect(m.context, `${providerId}/${m.id} 上下文窗口`).not.toBe('待确认');
        for (const tag of m.tags) {
          expect(VALID_TAGS.has(tag), `${providerId}/${m.id} 非法标签 ${tag}`).toBe(true);
        }
      }
    }
  });

  it('主流厂商精选含旗舰模型', () => {
    for (const p of ['openai', 'anthropic', 'google', 'kimi-api', 'deepseek']) {
      const hasFlagship = MODEL_HIGHLIGHTS[p]!.some((m) => m.tags.includes('旗舰'));
      expect(hasFlagship, `${p} 缺旗舰标注`).toBe(true);
    }
  });

  it('highlightsForProvider 命中精选;未知 provider 回退到全量前 8 且无标签', () => {
    expect(highlightsForProvider('openai').length).toBeGreaterThan(0);
    const fallback = highlightsForProvider('unknown-x', ['a', 'b', 'c']);
    expect(fallback.map((m) => m.id)).toEqual(['a', 'b', 'c']);
    expect(fallback[0]!.tags).toEqual([]);
    expect(fallback[0]!.modality).toBe('语言');
    expect(fallback[0]!.context).toBe('自定义');
  });

  it('关键厂商旗舰模型展示上下文与模态', () => {
    expect(MODEL_HIGHLIGHTS.openai![0]).toMatchObject({ modality: '多模态', context: '400K' });
    expect(MODEL_HIGHLIGHTS['kimi-api']![0]).toMatchObject({ modality: '多模态', context: '256K' });
    expect(MODEL_HIGHLIGHTS.deepseek![0]).toMatchObject({ modality: '语言', context: '1M' });
  });

  it('精选菜单不重新引入已核验过时或高风险模型 ID', () => {
    const ids = Object.values(MODEL_HIGHLIGHTS).flat().map((m) => m.id);
    for (const staleId of STALE_HIGHLIGHT_IDS) {
      expect(ids, staleId).not.toContain(staleId);
    }
  });
});
