// Agent Cowork 项目态势视图(UI · panels 子组件)
// ---------------------------------------------------------------------------
// 职责:把 runs/artifacts/model info 归并为当前项目快照,并渲染项目概览与可视化 spec。
import type { ArtifactItem, KimiInfo } from '../../lib/api';
import type { RunRecord } from '../../lib/types';
import { Button } from '../ui/Button';

export interface ProjectVizSnapshot {
  trustedRoot: string;
  runs: RunRecord[];
  artifacts: ArtifactItem[];
  providerCount: number;
  localProviderCount: number;
  activeProvider: string;
  activeModel: string;
  chatEnabled: boolean;
  loadedAt: string;
}

type ProviderSignal = { id: string; region?: string };

export function projectVizEmptySnapshot(trustedRoot: string): ProjectVizSnapshot {
  return {
    trustedRoot,
    runs: [],
    artifacts: [],
    providerCount: 0,
    localProviderCount: 0,
    activeProvider: '未配置',
    activeModel: '未配置',
    chatEnabled: false,
    loadedAt: new Date().toISOString(),
  };
}

function shortPath(value: string): string {
  if (!value) return '未选择';
  const parts = value.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.length > 2 ? `${parts.at(-2)}/${parts.at(-1)}` : value;
}

// 成功状态同义词(与 host runtime/run-metrics 的 SUCCESS_STATUSES 对齐)。run 实际写
// 'succeeded',此前显示只读 acc.done → 恒 0(dogfood 实测"0 成功"的根因)。
const SUCCESS_STATUSES = ['succeeded', 'success', 'ok', 'completed', 'done'];

export function runStatusCounts(runs: RunRecord[]): Record<string, number> {
  const acc = runs.reduce<Record<string, number>>((counts, run) => {
    const key = String(run.status || 'unknown');
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});
  // 合成 done = 全部成功态之和,让"成功"计数不再漏掉 'succeeded'。
  acc.done = SUCCESS_STATUSES.reduce((sum, status) => sum + (acc[status] || 0), 0);
  return acc;
}

function compactDate(value?: string | null): string {
  if (!value) return '';
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return value;
  return new Date(time).toLocaleString();
}

export function snapshotFromApis(
  trustedRoot: string,
  runs: RunRecord[],
  artifacts: ArtifactItem[],
  info: Partial<KimiInfo> | null | undefined,
): ProjectVizSnapshot {
  const providers: ProviderSignal[] = info?.providers || Object.values(info?.catalog?.all || {}).map((item) => ({
    id: item.id,
    region: item.id === 'ollama' || item.id === 'lmstudio' || item.id.includes('local') ? 'local' : 'cn',
  }));
  return {
    trustedRoot,
    runs,
    artifacts,
    providerCount: providers.length,
    localProviderCount: providers.filter((item) => item.region === 'local' || item.id === 'ollama' || item.id === 'lmstudio').length,
    activeProvider: info?.provider || '未配置',
    activeModel: info?.model || info?.catalog?.default?.[info?.provider || ''] || '未配置',
    chatEnabled: Boolean(info?.chatEnabled),
    loadedAt: new Date().toISOString(),
  };
}

export function projectVizSpecFromSnapshot(snapshot: ProjectVizSnapshot): string {
  const status = runStatusCounts(snapshot.runs);
  return JSON.stringify({
    title: 'Agent Cowork 项目态势',
    kind: 'table',
    data: {
      columns: ['信号', '当前值'],
      rows: [
        ['工作区', snapshot.trustedRoot || '未选择'],
        ['运行记录', String(snapshot.runs.length)],
        ['成功运行', String(status.done || 0)],
        ['失败运行', String(status.failed || 0)],
        ['产物数量', String(snapshot.artifacts.length)],
        ['模型提供商', String(snapshot.providerCount)],
        ['本地模型提供商', String(snapshot.localProviderCount)],
        ['当前模型', `${snapshot.activeProvider} / ${snapshot.activeModel}`],
        ['聊天启用', snapshot.chatEnabled ? '是' : '否'],
        ['刷新时间', compactDate(snapshot.loadedAt)],
      ],
    },
  }, null, 2);
}

export function ProjectVizOverview({
  snapshot,
  busy,
  error,
  onRefresh,
  onRenderProject,
}: {
  snapshot: ProjectVizSnapshot;
  busy: boolean;
  error: string;
  onRefresh: () => void;
  onRenderProject: () => void;
}) {
  const status = runStatusCounts(snapshot.runs);
  const latestRuns = snapshot.runs.slice(0, 4);
  const latestArtifacts = snapshot.artifacts.slice(0, 4);
  return (
    <div className="project-viz-overview">
      <div className="project-viz-head">
        <div>
          <h3>Agent Cowork 项目视图</h3>
          <p>{shortPath(snapshot.trustedRoot)} · {snapshot.activeProvider} / {snapshot.activeModel}</p>
        </div>
        <div className="project-viz-actions">
          <Button variant="secondary" disabled={busy} onClick={onRefresh}>{busy ? '刷新中…' : '刷新项目视图'}</Button>
          <Button variant="primary" disabled={busy} onClick={onRenderProject}>渲染当前项目活页</Button>
        </div>
      </div>

      {error && <p className="project-viz-error" role="alert">{error}</p>}

      <div className="project-viz-grid">
        <span><strong>{snapshot.runs.length}</strong><em>运行记录</em></span>
        <span><strong>{status.done || 0}</strong><em>成功</em></span>
        <span><strong>{status.failed || 0}</strong><em>失败</em></span>
        <span><strong>{snapshot.artifacts.length}</strong><em>产物</em></span>
        <span><strong>{snapshot.localProviderCount}</strong><em>本地模型</em></span>
        <span><strong>{snapshot.chatEnabled ? 'ON' : 'OFF'}</strong><em>聊天</em></span>
      </div>

      <div className="project-viz-flow" aria-label="Agent Cowork 项目流程">
        <span><strong>输入</strong><em>聊天 / 配方 / 文件</em></span>
        <i aria-hidden="true" />
        <span><strong>模型</strong><em>{snapshot.activeProvider}</em></span>
        <i aria-hidden="true" />
        <span><strong>工具</strong><em>运行 / 文件 / 产物</em></span>
        <i aria-hidden="true" />
        <span><strong>输出</strong><em>{snapshot.artifacts.length} 个产物</em></span>
      </div>

      <div className="project-viz-lists">
        <div className="project-viz-list">
          <h4>最近运行</h4>
          {latestRuns.length ? latestRuns.map((run) => (
            <div key={run.id} className="project-viz-row">
              <strong>{run.promptPreview || run.id}</strong>
              <span>{run.status || 'unknown'} · {compactDate(run.startedAt)}</span>
            </div>
          )) : <p>暂无运行记录</p>}
        </div>
        <div className="project-viz-list">
          <h4>最近产物</h4>
          {latestArtifacts.length ? latestArtifacts.map((artifact) => (
            <div key={artifact.path} className="project-viz-row">
              <strong>{artifact.relativePath || artifact.name || artifact.path}</strong>
              <span>{artifact.kind || 'file'} · {compactDate(artifact.modifiedAt || artifact.mtime)}</span>
            </div>
          )) : <p>暂无产物</p>}
        </div>
      </div>
    </div>
  );
}
