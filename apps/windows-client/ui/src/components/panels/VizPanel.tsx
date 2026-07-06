// Agent Cowork 项目可视化 / 活页面板(UI · 组件层 · components/panels)
// ---------------------------------------------------------------------------
// 职责:默认展示当前 Agent Cowork 工作区的运行/产物/模型态势,并可渲染为可刷新的活页制品;
//       高级区仍保留 JSON 模板/填表入口。只渲染+触发回调。
// 依赖:lib/api(renderViz/listRunRecords/listArtifacts/getKimiInfo)+ LiveArtifactView、ui/Button、ui/StateViews。导出:VizPanel 等。
import { useCallback, useEffect, useMemo, useState } from 'react';
import { renderViz, liveArtifactUrl, fetchArtifactHtml, listArtifacts, listRunRecords, getKimiInfo } from '../../lib/api';
import { joinWorkspacePath } from '../../lib/app-logic';
import { humanizeError } from '../../lib/friendly-error';
import { LiveArtifactView } from '../LiveArtifactView';
import { Button } from '../ui/Button';
import { ErrorState } from '../ui/StateViews';
import type { WorkbenchPreviewState } from '../composer-types';
import {
  ProjectVizOverview,
  projectVizEmptySnapshot,
  projectVizSpecFromSnapshot,
  snapshotFromApis,
  type ProjectVizSnapshot,
} from './project-viz';
import { WorkbenchLivePreview, emptyWorkbenchPreview } from './workbench-preview';

interface VizPanelProps {
  trustedRoot: string;
  workbenchPreview?: WorkbenchPreviewState | undefined;
}

// 具体 viz 模板:用户可点击、微调、渲染,不用面对单一 JSON 示例再凭空猜 schema。
export const VIZ_SAMPLES = {
  bar: JSON.stringify({ title: '季度收入', kind: 'bar', data: { labels: ['Q1', 'Q2', 'Q3', 'Q4'], values: [12, 19, 8, 15] } }, null, 2),
  line: JSON.stringify({ title: '月度访问', kind: 'line', data: { labels: ['1月', '2月', '3月', '4月', '5月', '6月'], values: [320, 480, 510, 620, 580, 700] } }, null, 2),
  pie: JSON.stringify({ title: '渠道占比', kind: 'pie', data: { labels: ['搜索', '直接', '社交', '邮件'], values: [42, 30, 18, 10] } }, null, 2),
  table: JSON.stringify({ title: '团队季度', kind: 'table', data: { columns: ['部门', 'Q3', 'Q4', '环比'], rows: [['销售', 180, 210, '+17%'], ['市场', 120, 140, '+17%'], ['研发', 95, 98, '+3%']] } }, null, 2),
  metric: JSON.stringify({ title: '关键指标', kind: 'metric', data: { value: 1247, label: '本月新签订单', delta: '+8.3%' } }, null, 2),
} satisfies Record<string, string>;

const TEMPLATE_OPTIONS: Array<{ key: keyof typeof VIZ_SAMPLES; label: string }> = [
  { key: 'bar', label: '柱状' },
  { key: 'line', label: '折线' },
  { key: 'pie', label: '饼图' },
  { key: 'table', label: '表格' },
  { key: 'metric', label: '指标卡' },
];

export interface JsonValidation {
  ok: boolean;
  message?: string | undefined;
  position?: number | undefined;
  line?: number | undefined;
  column?: number | undefined;
}

// 纯校验函数:返回 {ok} 或带行列号的友好错误。JSON.parse 只给 "position N",
// 这里把字符偏移反算成行/列,让行内提示能显示"第 3 行第 12 列"。
export function validateJsonSpec(text: string): JsonValidation {
  if (!text.trim()) return { ok: false, message: '请粘贴 JSON 或选择一个模板' };
  try {
    JSON.parse(text);
    return { ok: true };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const match = /position\s+(\d+)/.exec(message);
    if (match) {
      const position = Number(match[1]);
      const head = text.slice(0, position);
      const line = head.split('\n').length;
      const column = position - head.lastIndexOf('\n');
      return { ok: false, message, position, line, column };
    }
    return { ok: false, message };
  }
}

export function VizPanelErrorState({ error }: { error: string }) {
  if (!error) return null;
  return <ErrorState title="活页渲染失败" message={error} />;
}

export function VizTemplateButtons({ onPick }: { onPick: (key: keyof typeof VIZ_SAMPLES) => void }) {
  return (
    <div className="viz-templates">
      <span className="viz-templates-label">模板:</span>
      {TEMPLATE_OPTIONS.map((opt) => (
        <Button key={opt.key} variant="secondary" onClick={() => onPick(opt.key)}>{opt.label}</Button>
      ))}
    </div>
  );
}

// 从普通表单字段生成 viz spec;覆盖 5 类模板,不会写 JSON 的用户也能填标题/标签/数值出图。
export function specFromForm(args: {
  kind: keyof typeof VIZ_SAMPLES;
  title: string;
  labels: string;
  values: string;
}): string {
  const splitTokens = (text: string) => text.split(/[,，\s]+/).map((token) => token.trim()).filter(Boolean);
  const labels = splitTokens(args.labels);
  const numeric = splitTokens(args.values).map((token) => Number(token)).filter((n) => Number.isFinite(n));
  let spec: Record<string, unknown>;
  if (args.kind === 'metric') {
    spec = { title: args.title || '关键指标', kind: 'metric', data: { value: numeric[0] ?? 0, label: labels[0] || '' } };
  } else if (args.kind === 'table') {
    spec = { title: args.title || '表格', kind: 'table', data: { columns: labels, rows: [numeric] } };
  } else {
    spec = { title: args.title || '图表', kind: args.kind, data: { labels, values: numeric } };
  }
  return JSON.stringify(spec, null, 2);
}

export function VizFormBuilder({ onGenerate }: { onGenerate: (spec: string) => void }) {
  const [kind, setKind] = useState<keyof typeof VIZ_SAMPLES>('bar');
  const [title, setTitle] = useState('');
  const [labels, setLabels] = useState('');
  const [values, setValues] = useState('');
  return (
    <details className="viz-form-builder">
      <summary>不会写 JSON?用填表方式生成 ▾</summary>
      <div className="viz-form-grid">
        <label>
          <span>类型</span>
          <select value={kind} onChange={(e) => setKind(e.target.value as keyof typeof VIZ_SAMPLES)}>
            {TEMPLATE_OPTIONS.map((opt) => <option key={opt.key} value={opt.key}>{opt.label}</option>)}
          </select>
        </label>
        <label>
          <span>标题</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="如:季度收入" />
        </label>
        <label>
          <span>{kind === 'table' ? '列名(逗号分隔)' : kind === 'metric' ? '指标名' : '横轴标签(逗号分隔)'}</span>
          <input value={labels} onChange={(e) => setLabels(e.target.value)} placeholder={kind === 'metric' ? '本月新签订单' : 'Q1, Q2, Q3, Q4'} />
        </label>
        <label>
          <span>{kind === 'metric' ? '数值' : '数据(逗号分隔)'}</span>
          <input value={values} onChange={(e) => setValues(e.target.value)} placeholder={kind === 'metric' ? '1247' : '12, 19, 8, 15'} />
        </label>
      </div>
      <Button
        variant="primary"
        className="viz-form-submit"
        onClick={() => onGenerate(specFromForm({ kind, title, labels, values }))}
        disabled={!labels.trim() && !values.trim() && !title.trim()}
      >
        生成 JSON 并填入下方
      </Button>
    </details>
  );
}

export function VizPanelActions({
  busy,
  viewUrl,
  onRender,
  onReopen,
  disabled,
}: {
  busy: boolean;
  viewUrl: string;
  onRender: () => void;
  onReopen: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="panel-row">
      <Button variant="secondary" disabled={busy || disabled} onClick={onRender}>{busy ? '渲染中…' : '渲染活页'}</Button>
      {viewUrl && <Button variant="secondary" onClick={onReopen}>重开活页</Button>}
    </div>
  );
}

// 将 viz spec 渲染成可刷新的活页制品,并在面板内联预览。
export function VizPanel({ trustedRoot, workbenchPreview }: VizPanelProps) {
  const [specText, setSpecText] = useState(VIZ_SAMPLES.bar);
  const [projectSnapshot, setProjectSnapshot] = useState<ProjectVizSnapshot>(() => projectVizEmptySnapshot(trustedRoot));
  const [projectBusy, setProjectBusy] = useState(false);
  const [projectError, setProjectError] = useState('');
  const [srcDoc, setSrcDoc] = useState('');
  const [filePath, setFilePath] = useState('');
  const [dataUrl, setDataUrl] = useState('');
  const [viewUrl, setViewUrl] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const validation = useMemo(() => validateJsonSpec(specText), [specText]);
  const liveWorkbenchPreview = useMemo(() => workbenchPreview || emptyWorkbenchPreview(trustedRoot), [trustedRoot, workbenchPreview]);

  const refreshProject = useCallback(async () => {
    setProjectBusy(true);
    setProjectError('');
    const [runsResult, artifactsResult, infoResult] = await Promise.allSettled([
      listRunRecords(20),
      listArtifacts(trustedRoot, 20),
      getKimiInfo(),
    ]);
    const failures = [runsResult, artifactsResult, infoResult].filter((item) => item.status === 'rejected');
    const runs = runsResult.status === 'fulfilled' ? runsResult.value : [];
    const artifacts = artifactsResult.status === 'fulfilled' ? artifactsResult.value : [];
    const info = infoResult.status === 'fulfilled' ? infoResult.value : null;
    setProjectSnapshot(snapshotFromApis(trustedRoot, runs, artifacts, info));
    if (failures.length) {
      setProjectError(humanizeError((failures[0] as PromiseRejectedResult).reason, { action: '刷新项目视图' }));
    }
    setProjectBusy(false);
  }, [trustedRoot]);

  useEffect(() => {
    void refreshProject();
  }, [refreshProject]);

  const renderSpecText = async (nextSpecText = specText) => {
    const nextValidation = validateJsonSpec(nextSpecText);
    if (!nextValidation.ok) {
      setError(nextValidation.message || 'JSON 不合法');
      return;
    }
    setBusy(true);
    setError('');
    setSrcDoc('');
    try {
      const spec = JSON.parse(nextSpecText);
      const res = await renderViz(spec, true, trustedRoot);
      if (res.viewUrl) {
        const resolvedViewUrl = liveArtifactUrl(res.viewUrl);
        setViewUrl(resolvedViewUrl);
        setSrcDoc(await fetchArtifactHtml(resolvedViewUrl));
      } else {
        setViewUrl('');
      }
      setDataUrl(res.dataUrl || '');
      setFilePath(res.relativePath ? joinWorkspacePath(trustedRoot, res.relativePath) : '');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const renderCurrentProject = () => {
    const nextSpecText = projectVizSpecFromSnapshot(projectSnapshot);
    setSpecText(nextSpecText);
    void renderSpecText(nextSpecText);
  };

  return (
    <section className="side-panel viz-panel">
      <h2>实时工作台</h2>
      <WorkbenchLivePreview preview={liveWorkbenchPreview} />
      <ProjectVizOverview
        snapshot={projectSnapshot}
        busy={projectBusy}
        error={projectError}
        onRefresh={() => void refreshProject()}
        onRenderProject={renderCurrentProject}
      />

      <details className="viz-manual-builder">
        <summary>手动 JSON 活页</summary>
        <VizTemplateButtons onPick={(key) => setSpecText(VIZ_SAMPLES[key])} />
        <VizFormBuilder onGenerate={(spec) => setSpecText(spec)} />
        <textarea value={specText} rows={8} spellCheck={false} onChange={(e) => setSpecText(e.target.value)} />
        {!validation.ok && (
          <p className="viz-json-error" role="alert">
            JSON 解析失败{validation.line ? `(第 ${validation.line} 行第 ${validation.column} 列)` : ''}:{validation.message}
          </p>
        )}
        <VizPanelActions
          busy={busy}
          viewUrl={viewUrl}
          disabled={!validation.ok}
          onRender={() => void renderSpecText()}
          onReopen={() => void fetchArtifactHtml(viewUrl).then(setSrcDoc).catch((e) => setError((e as Error).message))}
        />
      </details>
      <VizPanelErrorState error={error} />
      <LiveArtifactView title="项目活页 Artifact" srcDoc={srcDoc} dataUrl={dataUrl} filePath={filePath} viewUrl={viewUrl} busy={busy} />
    </section>
  );
}
