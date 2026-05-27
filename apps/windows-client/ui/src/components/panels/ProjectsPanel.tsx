import { useEffect, useMemo, useState } from 'react';
import {
  assignProjectArtifact,
  assignProjectConversation,
  createProject,
  deleteProject,
  listArtifacts,
  listProjects,
  listStoredConversations,
  updateProject,
  type ArtifactItem,
  type ProjectRecord,
  type StoredConversation,
} from '../../lib/api';
import { Button } from '../ui/Button';
import { Empty, ErrorState } from '../ui/StateViews';

interface ProjectsPanelProps { trustedRoot: string }

export function projectMeta(project: ProjectRecord): string {
  return `${project.stats.conversations} 对话 · ${project.stats.artifacts} 产物`;
}

export function ProjectsPanelStateViews({ error, onRetry }: { error: string; onRetry: () => void }) {
  if (error) {
    return <ErrorState title="项目加载失败" message={error} onRetry={onRetry} retryLabel="重新加载" />;
  }
  return <Empty title="还没有项目工作区" message="创建项目后可把对话、记忆和产物归到同一个上下文。" />;
}

export interface ProjectsPanelViewProps {
  projects: ProjectRecord[];
  selected: ProjectRecord | null;
  conversations: StoredConversation[];
  artifacts: ArtifactItem[];
  busy: boolean;
  error: string;
  name: string;
  color: string;
  conversationId: string;
  artifactId: string;
  onNameChange: (value: string) => void;
  onColorChange: (value: string) => void;
  onConversationChange: (value: string) => void;
  onArtifactChange: (value: string) => void;
  onCreate: () => void;
  onRefresh: () => void;
  onSelect: (id: string) => void;
  onArchive: (project: ProjectRecord) => void;
  onDelete: (project: ProjectRecord) => void;
  onAssignConversation: () => void;
  onAssignArtifact: () => void;
}

export function ProjectsPanelView({
  projects,
  selected,
  conversations,
  artifacts,
  busy,
  error,
  name,
  color,
  conversationId,
  artifactId,
  onNameChange,
  onColorChange,
  onConversationChange,
  onArtifactChange,
  onCreate,
  onRefresh,
  onSelect,
  onArchive,
  onDelete,
  onAssignConversation,
  onAssignArtifact,
}: ProjectsPanelViewProps) {
  return (
    <section className="side-panel projects-panel">
      <h2>项目</h2>
      <div className="panel-row">
        <input value={name} placeholder="新项目名称" onChange={(event) => onNameChange(event.target.value)} />
        <input value={color} placeholder="#2563eb" onChange={(event) => onColorChange(event.target.value)} />
        <Button variant="primary" disabled={busy || !name.trim()} onClick={onCreate}>{busy ? '处理中…' : '创建'}</Button>
      </div>
      <div className="panel-row">
        <Button variant="secondary" disabled={busy} onClick={onRefresh}>{busy ? '刷新中…' : '刷新'}</Button>
      </div>
      {error && <ProjectsPanelStateViews error={error} onRetry={onRefresh} />}
      <ul className="tool-list">
        {projects.map((project) => (
          <li key={project.id} className={selected?.id === project.id ? 'is-selected' : ''} onClick={() => onSelect(project.id)}>
            <code>{project.name}</code>
            <span className="tool-src">{project.archived ? '已归档' : '进行中'}</span>
            <p>{projectMeta(project)}</p>
            <div className="panel-row">
              <Button variant="secondary" disabled={busy} onClick={() => onArchive(project)}>{project.archived ? '恢复' : '归档'}</Button>
              <Button variant="danger" disabled={busy} onClick={() => onDelete(project)}>删除</Button>
            </div>
          </li>
        ))}
        {projects.length === 0 && !error && (
          <li className="panel-empty">
            <ProjectsPanelStateViews error="" onRetry={onRefresh} />
          </li>
        )}
      </ul>
      {selected && (
        <div className="panel-call">
          <label>当前项目</label>
          <code>{selected.name}</code>
          <p className="panel-note">{projectMeta(selected)}</p>
          <div className="panel-row">
            <select className="model-select" value={conversationId} onChange={(event) => onConversationChange(event.target.value)}>
              <option value="">选择对话</option>
              {conversations.map((item) => <option key={item.id} value={item.id}>{item.title || item.id}</option>)}
            </select>
            <Button disabled={busy || !conversationId} onClick={onAssignConversation}>加入对话</Button>
          </div>
          <div className="panel-row">
            <select className="model-select" value={artifactId} onChange={(event) => onArtifactChange(event.target.value)}>
              <option value="">选择产物</option>
              {artifacts.map((item) => <option key={item.path} value={item.path}>{item.name}</option>)}
            </select>
            <Button disabled={busy || !artifactId} onClick={onAssignArtifact}>加入产物</Button>
          </div>
        </div>
      )}
    </section>
  );
}

export function ProjectsPanel({ trustedRoot }: ProjectsPanelProps) {
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [conversations, setConversations] = useState<StoredConversation[]>([]);
  const [artifacts, setArtifacts] = useState<ArtifactItem[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [name, setName] = useState('');
  const [color, setColor] = useState('#2563eb');
  const [conversationId, setConversationId] = useState('');
  const [artifactId, setArtifactId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const selected = useMemo(() => projects.find((project) => project.id === selectedId) || projects[0] || null, [projects, selectedId]);

  const refresh = async () => {
    setBusy(true); setError('');
    try {
      const [projectRes, conversationRes, artifactRes] = await Promise.all([
        listProjects(trustedRoot, true),
        listStoredConversations(80),
        listArtifacts(trustedRoot, 80),
      ]);
      setProjects(projectRes.projects || []);
      setConversations(conversationRes);
      setArtifacts(artifactRes);
    } catch (err) {
      setError((err as Error).message || '项目读取失败');
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => { void refresh(); }, [trustedRoot]);

  const mutate = async (fn: () => Promise<ProjectRecord | null>) => {
    setBusy(true); setError('');
    try {
      const project = await fn();
      if (project) setSelectedId(project.id);
      await refresh();
    } catch (err) {
      setError((err as Error).message || '项目操作失败');
      setBusy(false);
    }
  };

  return (
    <ProjectsPanelView
      projects={projects}
      selected={selected}
      conversations={conversations}
      artifacts={artifacts}
      busy={busy}
      error={error}
      name={name}
      color={color}
      conversationId={conversationId}
      artifactId={artifactId}
      onNameChange={setName}
      onColorChange={setColor}
      onConversationChange={setConversationId}
      onArtifactChange={setArtifactId}
      onRefresh={() => void refresh()}
      onSelect={setSelectedId}
      onCreate={() => void mutate(async () => {
        const result = await createProject(name.trim(), color.trim() || null, trustedRoot);
        setName('');
        return result.project;
      })}
      onArchive={(project) => void mutate(async () => (await updateProject(project.id, { archived: !project.archived }, trustedRoot)).project)}
      onDelete={(project) => void mutate(async () => { await deleteProject(project.id, trustedRoot); return null; })}
      onAssignConversation={() => selected && void mutate(async () => (await assignProjectConversation(selected.id, conversationId, trustedRoot)).project)}
      onAssignArtifact={() => selected && void mutate(async () => (await assignProjectArtifact(selected.id, artifactId, trustedRoot)).project)}
    />
  );
}
