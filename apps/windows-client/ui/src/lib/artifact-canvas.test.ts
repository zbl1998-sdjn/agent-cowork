import { describe, expect, it } from 'vitest';
import { buildArtifactRevisionPrompt, latestArtifactMessage, parseArtifactBlocks, replaceArtifactBlock } from './artifact-canvas';
import type { Message } from './app-types';

describe('artifact canvas logic', () => {
  const artifact = '# 销售复盘\n\n本月收入增长 18%。\n\n- 华东增长最快\n- 华南需要跟进\n\n```text\n下一步：复盘渠道\n```';

  it('parses the generated artifact into selectable semantic blocks', () => {
    expect(parseArtifactBlocks(artifact).map(({ kind, text }) => ({ kind, text }))).toEqual([
      { kind: 'heading', text: '# 销售复盘' },
      { kind: 'paragraph', text: '本月收入增长 18%。' },
      { kind: 'list', text: '- 华东增长最快\n- 华南需要跟进' },
      { kind: 'code', text: '```text\n下一步：复盘渠道\n```' },
    ]);
  });

  it('replaces only the selected block and preserves the surrounding artifact', () => {
    const block = parseArtifactBlocks(artifact)[1];
    expect(block).toBeDefined();
    expect(replaceArtifactBlock(artifact, block!, '本月收入增长 21%。')).toBe(
      artifact.replace('本月收入增长 18%。', '本月收入增长 21%。'),
    );
  });

  it('builds a selection-scoped request with annotation context', () => {
    const block = parseArtifactBlocks(artifact)[2];
    expect(block).toBeDefined();
    const prompt = buildArtifactRevisionPrompt(block!, '改成更简洁的行动项', '华南负责人是林晓');
    expect(prompt).toContain('只修改下面选中的成果片段');
    expect(prompt).toContain('- 华东增长最快');
    expect(prompt).toContain('改成更简洁的行动项');
    expect(prompt).toContain('华南负责人是林晓');
  });

  it('keeps failures out of the artifact canvas', () => {
    const messages = [
      { id: 'ok', role: 'assistant', status: 'done', text: '真实成果', progress: [], operations: [], sources: [], approvalState: 'idle' },
      { id: 'failed', role: 'assistant', status: 'failed', text: '请先配置模型', progress: [], operations: [], sources: [], approvalState: 'idle' },
    ] as Message[];
    expect(latestArtifactMessage(messages)?.id).toBe('ok');
  });
});
