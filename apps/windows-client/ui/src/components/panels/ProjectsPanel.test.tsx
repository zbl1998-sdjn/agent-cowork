import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ProjectRecord } from '../../lib/api';
import { Button } from '../ui/Button';
import { projectMeta, ProjectsPanelStateViews, ProjectsPanelView } from './ProjectsPanel';

const project: ProjectRecord = {
  id: 'proj_1',
  name: '客户 A',
  color: '#2563eb',
  archived: false,
  createdAt: 1,
  updatedAt: 2,
  stats: { conversations: 2, artifacts: 1 },
  conversations: ['conv_1', 'conv_2'],
  artifacts: ['artifact_1'],
};

describe('ProjectsPanel', () => {
  it('formats project context counts', () => {
    expect(projectMeta(project)).toBe('2 对话 · 1 产物');
  });

  it('renders project workspace controls through Button primitives', () => {
    const html = renderToStaticMarkup(
      <ProjectsPanelView
        projects={[project]}
        selected={project}
        conversations={[{ id: 'conv_1', title: '需求讨论', messages: [] }]}
        artifacts={[{ path: 'C:/work/.AgentCowork/artifacts/a.html', name: 'a.html' }]}
        busy={false}
        error=""
        name="新项目"
        color="#2563eb"
        conversationId="conv_1"
        artifactId="C:/work/.AgentCowork/artifacts/a.html"
        onNameChange={vi.fn()}
        onColorChange={vi.fn()}
        onConversationChange={vi.fn()}
        onArtifactChange={vi.fn()}
        onCreate={vi.fn()}
        onRefresh={vi.fn()}
        onSelect={vi.fn()}
        onArchive={vi.fn()}
        onDelete={vi.fn()}
        onAssignConversation={vi.fn()}
        onAssignArtifact={vi.fn()}
      />,
    );

    expect(html).toContain('客户 A');
    expect(html).toContain('2 对话 · 1 产物');
    expect(html).toContain('需求讨论');
    expect(html).toContain('a.html');
    expect(html.match(/<button/g)?.length).toBe(6);
  });

  it('uses the shared error and empty states', () => {
    expect(renderToStaticMarkup(<ProjectsPanelStateViews error="" onRetry={vi.fn()} />)).toContain('还没有项目工作区');
    expect(renderToStaticMarkup(<ProjectsPanelStateViews error="offline" onRetry={vi.fn()} />)).toContain('项目加载失败');
  });

  it('keeps the create button disabled until a name exists', () => {
    const element = ProjectsPanelView({
      projects: [],
      selected: null,
      conversations: [],
      artifacts: [],
      busy: false,
      error: '',
      name: '',
      color: '',
      conversationId: '',
      artifactId: '',
      onNameChange: vi.fn(),
      onColorChange: vi.fn(),
      onConversationChange: vi.fn(),
      onArtifactChange: vi.fn(),
      onCreate: vi.fn(),
      onRefresh: vi.fn(),
      onSelect: vi.fn(),
      onArchive: vi.fn(),
      onDelete: vi.fn(),
      onAssignConversation: vi.fn(),
      onAssignArtifact: vi.fn(),
    }) as any;
    const createButton = element.props.children[1].props.children[2];
    expect(createButton.type).toBe(Button);
    expect(createButton.props.disabled).toBe(true);
  });
});
