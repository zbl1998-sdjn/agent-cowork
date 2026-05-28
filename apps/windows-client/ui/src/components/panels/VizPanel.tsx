import { useMemo, useState } from 'react';
import { renderViz, liveArtifactUrl, fetchArtifactHtml } from '../../lib/api';
import { LiveArtifactView } from '../LiveArtifactView';
import { Button } from '../ui/Button';
import { ErrorState } from '../ui/StateViews';

interface VizPanelProps {
  trustedRoot: string;
}

// Concrete spec templates so users can click → tweak → render, instead of staring
// at a single JSON example and having to invent the schema.
export const VIZ_SAMPLES: Record<string, string> = {
  bar: JSON.stringify({ title: '季度收入', kind: 'bar', data: { labels: ['Q1', 'Q2', 'Q3', 'Q4'], values: [12, 19, 8, 15] } }, null, 2),
  line: JSON.stringify({ title: '月度访问', kind: 'line', data: { labels: ['1月', '2月', '3月', '4月', '5月', '6月'], values: [320, 480, 510, 620, 580, 700] } }, null, 2),
  pie: JSON.stringify({ title: '渠道占比', kind: 'pie', data: { labels: ['搜索', '直接', '社交', '邮件'], values: [42, 30, 18, 10] } }, null, 2),
  table: JSON.stringify({ title: '团队季度', kind: 'table', data: { columns: ['部门', 'Q3', 'Q4', '环比'], rows: [['销售', 180, 210, '+17%'], ['市场', 120, 140, '+17%'], ['研发', 95, 98, '+3%']] } }, null, 2),
  metric: JSON.stringify({ title: '关键指标', kind: 'metric', data: { value: 1247, label: '本月新签订单', delta: '+8.3%' } }, null, 2),
};

const TEMPLATE_OPTIONS: Array<{ key: keyof typeof VIZ_SAMPLES; label: string }> = [
  { key: 'bar', label: '柱状' },
  { key: 'line', label: '折线' },
  { key: 'pie', label: '饼图' },
  { key: 'table', label: '表格' },
  { key: 'metric', label: '指标卡' },
];

export interface JsonValidation {
  ok: boolean;
  message?: string;
  position?: number;
  line?: number;
  column?: number;
}

// Pure helper: returns {ok} or a friendly error with line/column when possible.
// JSON.parse only gives `at position N`; we map that back to line/column ourselves
// so the inline hint can say "第 3 行第 12 列" instead of a raw char offset.
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

// Build a viz spec from plain form fields. Supports the 5 templates so a user
// who can't write JSON can still get a chart by filling Title + Labels + Values.
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

// Render a viz spec to a live, refreshable artifact and preview it inline.
export function VizPanel({ trustedRoot }: VizPanelProps) {
  const [specText, setSpecText] = useState(VIZ_SAMPLES.bar);
  const [srcDoc, setSrcDoc] = useState('');
  const [filePath, setFilePath] = useState('');
  const [dataUrl, setDataUrl] = useState('');
  const [viewUrl, setViewUrl] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const validation = useMemo(() => validateJsonSpec(specText), [specText]);

  const onRender = async () => {
    if (!validation.ok) {
      setError(validation.message || 'JSON 不合法');
      return;
    }
    setBusy(true);
    setError('');
    setSrcDoc('');
    try {
      const spec = JSON.parse(specText);
      const res = await renderViz(spec, true, trustedRoot);
      if (res.viewUrl) {
        const resolvedViewUrl = liveArtifactUrl(res.viewUrl);
        setViewUrl(resolvedViewUrl);
        setSrcDoc(await fetchArtifactHtml(resolvedViewUrl));
      } else {
        setViewUrl('');
      }
      setDataUrl(res.dataUrl || '');
      setFilePath(res.relativePath ? `${trustedRoot}/${res.relativePath}` : '');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="side-panel">
      <h2>可视化 / 活页</h2>
      <VizTemplateButtons onPick={(key) => setSpecText(VIZ_SAMPLES[key])} />
      <VizFormBuilder onGenerate={(spec) => setSpecText(spec)} />
      <textarea value={specText} rows={8} spellCheck={false} onChange={(e) => setSpecText(e.target.value)} />
      {!validation.ok && (
        <p className="viz-json-error" role="alert">
          ⚠ JSON 解析失败{validation.line ? `(第 ${validation.line} 行第 ${validation.column} 列)` : ''}:{validation.message}
        </p>
      )}
      <VizPanelActions
        busy={busy}
        viewUrl={viewUrl}
        disabled={!validation.ok}
        onRender={() => void onRender()}
        onReopen={() => void fetchArtifactHtml(viewUrl).then(setSrcDoc).catch((e) => setError((e as Error).message))}
      />
      <VizPanelErrorState error={error} />
      <LiveArtifactView srcDoc={srcDoc} dataUrl={dataUrl} filePath={filePath} viewUrl={viewUrl} busy={busy} />
    </section>
  );
}
