// 工作台实时预览(UI · panels 子组件)
// ---------------------------------------------------------------------------
// 职责:把 Composer 草稿快照转成可视化预览模型,并在侧边面板内实时展示输出形态。纯展示,不发请求。
import type { WorkbenchPreviewState } from '../composer-types';
import { buildWorkbenchGenerationModel, type WorkbenchGenerationModel } from './workbench-generation';

export type WorkbenchPreviewKind = 'document' | 'spreadsheet' | 'deck' | 'page' | 'code' | 'office';

export interface WorkbenchLivePreviewModel {
  kind: WorkbenchPreviewKind;
  kindLabel: string;
  title: string;
  subtitle: string;
  formats: string[];
  sections: Array<{ label: string; value: string }>;
  lines: string[];
  fileLabels: string[];
  isEmpty: boolean;
  generation?: WorkbenchGenerationModel | undefined;
}

type PreviewProfile = {
  kind: WorkbenchPreviewKind;
  label: string;
  formats: string[];
  pattern: RegExp;
};

const PREVIEW_PROFILES: PreviewProfile[] = [
  { kind: 'spreadsheet', label: '表格 / 数据', formats: ['XLSX', 'CSV', 'PDF'], pattern: /(xlsx|xls|csv|excel|表格|数据|汇总|统计|透视|报表|清洗)/i },
  { kind: 'deck', label: '演示文稿', formats: ['PPTX', 'PDF'], pattern: /(ppt|pptx|演示|幻灯|汇报|路演|presentation)/i },
  { kind: 'page', label: '页面 / 看板', formats: ['HTML', 'PNG', 'PDF'], pattern: /(html|网页|页面|界面|可视化|看板|dashboard|design|ui)/i },
  { kind: 'code', label: '代码改动', formats: ['Diff', 'Patch', '测试报告'], pattern: /(代码|修复|脚本|函数|接口|测试|refactor|typescript|python|rust|tsx|jsx|\.ts|\.py|\.rs)/i },
  { kind: 'document', label: '办公文档', formats: ['DOCX', 'PDF', 'HTML'], pattern: /(docx|doc|word|pdf|文档|报告|日报|周报|总结|方案|合同|邮件|纪要)/i },
];

const DEFAULT_PROFILE: PreviewProfile = {
  kind: 'office',
  label: '办公协作',
  formats: ['DOCX', 'XLSX', 'PPTX', 'PDF'],
  pattern: /./,
};

export function emptyWorkbenchPreview(workspace: string): WorkbenchPreviewState {
  return {
    text: '',
    files: [],
    provider: '未配置',
    model: '未选择',
    thinking: 'standard',
    updatedAt: new Date().toISOString(),
    mode: 'execute',
    workspace,
    recipe: null,
    streaming: false,
  };
}

function compactPath(value: string): string {
  if (!value) return '未选择工作区';
  const parts = value.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.length > 2 ? `${parts.at(-2)}/${parts.at(-1)}` : value;
}

function formatFileSize(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return '0 B';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 102.4) / 10} KB`;
  return `${Math.round(size / 1024 / 102.4) / 10} MB`;
}

function modeLabel(mode: WorkbenchPreviewState['mode']): string {
  if (mode === 'plan') return '计划';
  if (mode === 'auto') return '安全自动';
  return '执行';
}

function chooseProfile(preview: WorkbenchPreviewState): PreviewProfile {
  const haystack = `${preview.generation?.text || preview.text} ${preview.files.map((file) => file.name).join(' ')}`;
  return PREVIEW_PROFILES.find((profile) => profile.pattern.test(haystack)) || DEFAULT_PROFILE;
}

function previewLines(text: string): string[] {
  const normalized = text.trim();
  if (!normalized) return ['等待输入工作内容', '当前没有附件或模板'];
  return normalized
    .split(/[\n。；;]+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 3);
}

function previewTitle(text: string, profile: PreviewProfile): string {
  const firstLine = text.trim().split(/\n+/).map((line) => line.trim()).find(Boolean);
  if (!firstLine) return `${profile.label}草稿`;
  return firstLine.length > 42 ? `${firstLine.slice(0, 42)}...` : firstLine;
}

export function buildWorkbenchLivePreviewModel(preview: WorkbenchPreviewState): WorkbenchLivePreviewModel {
  const profile = chooseProfile(preview);
  const generationText = preview.generation?.text?.trim() || '';
  const text = generationText || preview.text.trim();
  const fileLabels = preview.files.slice(0, 4).map((file) => `${file.name} · ${formatFileSize(file.size)}`);
  const provider = preview.provider || '未配置';
  const model = preview.model || '未选择';
  const recipe = preview.recipe?.name || '无模板';
  const outputState = preview.streaming ? '生成中' : (generationText ? '已生成' : (text || preview.files.length ? '待发送' : '草稿'));
  return {
    kind: profile.kind,
    kindLabel: profile.label,
    title: previewTitle(text, profile),
    subtitle: `${compactPath(preview.workspace)} · ${modeLabel(preview.mode)} · ${outputState}`,
    formats: profile.formats,
    sections: [
      { label: '材料', value: preview.files.length ? `${preview.files.length} 个附件` : '无附件' },
      { label: '模板', value: recipe },
      { label: '模型', value: `${provider} / ${model}` },
      { label: '思考', value: preview.thinking },
    ],
    lines: previewLines(text),
    fileLabels,
    isEmpty: !text && preview.files.length === 0,
    generation: buildWorkbenchGenerationModel(preview),
  };
}

function DocumentPreview({ model }: { model: WorkbenchLivePreviewModel }) {
  return (
    <div className="workbench-doc-page">
      <strong>{model.title}</strong>
      {model.lines.map((line, index) => <span key={index}>{line}</span>)}
      <i aria-hidden="true" />
      <i aria-hidden="true" />
    </div>
  );
}

function SpreadsheetPreview({ model }: { model: WorkbenchLivePreviewModel }) {
  const rows = model.lines.length ? model.lines : ['任务', '材料', '输出'];
  return (
    <table className="workbench-sheet" aria-label="表格预览">
      <thead><tr><th>项目</th><th>状态</th><th>输出</th></tr></thead>
      <tbody>
        {rows.slice(0, 3).map((line, index) => (
          <tr key={index}><td>{line}</td><td>待处理</td><td>{model.formats[0]}</td></tr>
        ))}
      </tbody>
    </table>
  );
}

function DeckPreview({ model }: { model: WorkbenchLivePreviewModel }) {
  return (
    <div className="workbench-slide-deck" aria-label="演示预览">
      {[0, 1, 2].map((index) => (
        <section key={index}>
          <strong>{index === 0 ? model.title : model.lines[index] || `页面 ${index + 1}`}</strong>
          <span />
          <span />
        </section>
      ))}
    </div>
  );
}

function PagePreview({ model }: { model: WorkbenchLivePreviewModel }) {
  return (
    <div className="workbench-page-mock" aria-label="页面预览">
      <header><strong>{model.title}</strong><span /></header>
      <main>
        <span />
        <span />
        <span />
      </main>
    </div>
  );
}

function CodePreview({ model }: { model: WorkbenchLivePreviewModel }) {
  return (
    <pre className="workbench-code-mock" aria-label="代码预览">
      {model.lines.slice(0, 4).map((line, index) => `${index === 0 ? '+ ' : '  '}${line}`).join('\n')}
    </pre>
  );
}

function OfficePreview({ model }: { model: WorkbenchLivePreviewModel }) {
  return (
    <div className="workbench-office-flow" aria-label="办公协作预览">
      <span>输入</span><i aria-hidden="true" /><span>整理</span><i aria-hidden="true" /><span>{model.formats.join(' / ')}</span>
    </div>
  );
}

function WorkbenchPreviewCanvas({ model }: { model: WorkbenchLivePreviewModel }) {
  if (model.kind === 'spreadsheet') return <SpreadsheetPreview model={model} />;
  if (model.kind === 'deck') return <DeckPreview model={model} />;
  if (model.kind === 'page') return <PagePreview model={model} />;
  if (model.kind === 'code') return <CodePreview model={model} />;
  if (model.kind === 'office') return <OfficePreview model={model} />;
  return <DocumentPreview model={model} />;
}

export function WorkbenchLivePreview({ preview }: { preview: WorkbenchPreviewState }) {
  const model = buildWorkbenchLivePreviewModel(preview);
  return (
    <section className={`workbench-live-preview is-${model.kind}`} aria-label="工作台实时预览">
      <div className="workbench-live-head">
        <div>
          <span>工作台预览</span>
          <strong>{model.title}</strong>
          <em>{model.subtitle}</em>
        </div>
        <div className="workbench-live-badges">
          {model.generation && <mark className={model.generation.active ? 'is-live' : ''}>{model.generation.active ? `实时 · ${model.generation.phase}` : model.generation.phase}</mark>}
          <mark>{model.kindLabel}</mark>
        </div>
      </div>
      {model.generation && (
        <div className="workbench-generation-strip" role="status" aria-live="polite">
          <span className="workbench-generation-pulse" aria-hidden="true" />
          <span>{model.generation.active ? '正在接收真实生成片段' : '本轮生成已收束'}</span>
          <em>{model.generation.latestActivity}</em>
          <small>更新 {model.generation.updateCount} 次</small>
        </div>
      )}
      <div className="workbench-preview-stage">
        <WorkbenchPreviewCanvas model={model} />
      </div>
      <div className="workbench-preview-formats" aria-label="预计输出格式">
        {model.formats.map((format) => <span key={format}>{format}</span>)}
      </div>
      <dl className="workbench-preview-facts">
        {model.sections.map((item) => (
          <div key={item.label}>
            <dt>{item.label}</dt>
            <dd>{item.value}</dd>
          </div>
        ))}
      </dl>
      {model.fileLabels.length > 0 && (
        <div className="workbench-preview-files" aria-label="附件预览">
          {model.fileLabels.map((label) => <span key={label}>{label}</span>)}
        </div>
      )}
    </section>
  );
}
