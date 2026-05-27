import { describe, expect, it } from 'vitest';
import { buildContextualStarters } from './starter-suggestions';

describe('buildContextualStarters', () => {
  it('prioritizes recent run and recipe context before generic starters', () => {
    const starters = buildContextualStarters({
      base: ['整理工作区里的文档并列出清单', '把一个 CSV 文件做成图表'],
      recipes: [
        { name: '会议行动项', summary: '从会议纪要生成负责人和截止时间' },
      ],
      historyRuns: [
        { promptPreview: '继续 FE 验收并整理剩余风险' },
      ],
    });

    expect(starters).toEqual([
      '继续：继续 FE 验收并整理剩余风险',
      '用「会议行动项」处理：从会议纪要生成负责人和截止时间',
      '整理工作区里的文档并列出清单',
      '把一个 CSV 文件做成图表',
    ]);
  });

  it('deduplicates blank and repeated suggestions while respecting the cap', () => {
    const starters = buildContextualStarters({
      base: ['整理日报', '整理日报', '生成图表'],
      recipes: [{ name: '  ' }],
      historyRuns: [{ promptPreview: '' }],
      max: 2,
    });

    expect(starters).toEqual(['整理日报', '生成图表']);
  });
});
