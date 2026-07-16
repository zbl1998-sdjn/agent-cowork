import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { SkillPacksPanelView } from './SkillPacksPanelView';

const noop = vi.fn();

describe('SkillPacksPanelView', () => {
  it('lists packs with their enabled state and toggle labels', () => {
    const html = renderToStaticMarkup(
      <SkillPacksPanelView
        status="ready"
        packs={[
          { name: 'pdf-processing', description: '处理 PDF。', enabled: true },
          { name: 'weekly-report', description: '写周报。', enabled: false },
        ]}
        warnings={[]}
        error=""
        busyName=""
        onToggle={noop}
        onRefresh={noop}
      />,
    );
    expect(html).toContain('pdf-processing');
    expect(html).toContain('weekly-report');
    expect(html).toContain('停用');
    expect(html).toContain('启用');
    expect(html).toContain('is-disabled');
    expect(html).toContain('.AgentCowork/skills/');
  });

  it('shows an empty hint, warnings, and errors', () => {
    const html = renderToStaticMarkup(
      <SkillPacksPanelView
        status="ready"
        packs={[]}
        warnings={['bad-pack: SKILL.md 缺少合法 YAML frontmatter']}
        error="读取技能包失败"
        busyName=""
        onToggle={noop}
        onRefresh={noop}
      />,
    );
    expect(html).toContain('还没有发现技能包');
    expect(html).toContain('已跳过的目录');
    expect(html).toContain('bad-pack');
    expect(html).toContain('读取技能包失败');
  });
});
