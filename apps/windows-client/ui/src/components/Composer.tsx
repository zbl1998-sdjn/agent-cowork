// Composer(UI · components):聊天输入框主组件——文本输入、附件、模型控制、发送/停止,组合各 Composer* 子件与建议/触发弹窗。
import { useEffect, useRef, useState } from 'react';
import type { DragEvent, KeyboardEvent } from 'react';
import { buildSessionModelConfig } from '../lib/composer-logic';
import { useComposerRefine } from '../hooks/useComposerRefine';
import { useComposerSuggestions } from '../hooks/useComposerSuggestions';
import { ComposerAttachments } from './ComposerAttachments';
import { ComposerFooter, type ThinkingLevel } from './ComposerFooter';
import { ComposerSuggestions } from './ComposerSuggestions';
import { RefinePreview } from './chat/RefinePreview';
import { useComposerVoice } from '../hooks/useComposerVoice';
import type { ComposerProps } from './composer-types';
// AppComposerDock 与 Composer.test 仍从本模块导入 ComposerMeta;类型实际在 composer-types,
// 这里再导出以保持旧 import path 稳定。
export type { ComposerDraftPreview, ComposerMeta, ComposerProps, FileHit, HistoryRun, Recipe, WorkbenchPreviewState } from './composer-types';
export type { ThinkingLevel } from './ComposerFooter';

const FALLBACK_PROVIDER_MODELS: Record<string, string[]> = {
  ollama: ['qwen3', 'qwen3-coder', 'qwen2.5:7b', 'qwen2.5:3b', 'qwen2.5:1.5b', 'qwen2.5:0.5b', 'deepseek-r1:7b', 'ibm/granite3.3:2b', 'lfm2.5-thinking:1.2b', 'qwen2.5vl:7b', 'minicpm-v4.5:latest', 'bge-m3:latest'],
  'openai/local': ['qwen3', 'qwen3-coder', 'qwen2.5:7b', 'qwen2.5:3b', 'qwen2.5:1.5b', 'qwen2.5:0.5b', 'deepseek-r1:7b', 'local-model'],
  lmstudio: ['local-model', 'qwen3', 'qwen3-coder', 'deepseek-r1', 'llama-3.1-8b-instruct', 'gpt-oss-20b'],
};

function composerFileKey(file: File): string {
  return `${file.name}\u0000${file.size}\u0000${file.lastModified}`;
}

export function mergeComposerFiles(current: File[], incoming: File[]): File[] {
  const seen = new Set(current.map(composerFileKey));
  const next = [...current];
  for (const file of incoming) {
    const key = composerFileKey(file);
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(file);
  }
  return next;
}

function dragContainsFiles(event: DragEvent<HTMLDivElement>): boolean {
  return Array.from(event.dataTransfer?.types || []).includes('Files');
}

export function Composer({
  recipes,
  historyRuns,
  searchFiles,
  onSend,
  onPickTemplate,
  onPickHistory,
  slashCommands = [],
  models = [],
  modelProviders = [],
  defaultModel = '',
  defaultProvider = 'kimi-api',
  defaultBaseUrl = '',
  autoClarify = false,
  onDraftChange,
  onRefinePrompt,
}: ComposerProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const dragDepthRef = useRef(0);
  const [value, setValue] = useState('');
  const [attachments, setAttachments] = useState<File[]>([]);
  const [model, setModel] = useState('');
  const [provider, setProvider] = useState('');
  const [thinking, setThinking] = useState<ThinkingLevel>('standard');
  const [dragging, setDragging] = useState(false);
  const { listening, toggleVoice } = useComposerVoice({
    onTranscript: (transcript) => setValue((v) => (v ? `${v} ${transcript}` : transcript)),
    onUnsupported: () => setValue((v) => `${v}${v ? '\n' : ''}(此浏览器不支持语音输入)`),
  });
  const {
    refining,
    refineOriginal,
    refineResult,
    refineNotice,
    canRefine,
    markChanged,
    prepareSend,
    refineCurrent,
    resetRefineAfterSend,
    resolvePreview,
  } = useComposerRefine({
    autoClarify,
    onRefinePrompt,
    onPreviewResolved: (next) => {
      setValue(next);
      ref.current?.focus();
    },
  });

  const {
    mode, items, active, setActive,
    onChange, close, insertTrigger,
  } = useComposerSuggestions({
    value, setValue, textareaRef: ref,
    searchFiles, recipes, historyRuns, slashCommands,
    onPickTemplate, onPickHistory, markChanged,
  });

  const currentProvider = provider || defaultProvider || 'kimi-api';
  const selectedProvider = modelProviders.find((item) => item.id === currentProvider);
  const fallbackModelOptions = FALLBACK_PROVIDER_MODELS[currentProvider] || [];
  const modelOptions = selectedProvider
    ? [...new Set([selectedProvider.defaultModel, ...selectedProvider.models, model, defaultModel].filter(Boolean))]
    : fallbackModelOptions.length ? [...new Set([...fallbackModelOptions, model, defaultModel].filter(Boolean))]
      : models.length ? models : (defaultModel ? [defaultModel] : []);
  // 当前 provider 就是已配置的默认 provider 时,优先用用户配置的 defaultModel(如 Ollama 的
  // qwen3:14b),而不是 catalog 的裸默认名(如 "qwen3",真实 Ollama 里常不存在 → 404)。
  const providerDefaultModel = currentProvider === defaultProvider && defaultModel
    ? defaultModel
    : (selectedProvider?.defaultModel || fallbackModelOptions[0] || defaultModel);
  const currentModel = model.trim() || providerDefaultModel;

  useEffect(() => {
    onDraftChange?.({
      text: value,
      files: attachments.map((file) => ({
        name: file.name,
        size: file.size,
        type: file.type || undefined,
        lastModified: file.lastModified,
      })),
      provider: currentProvider,
      model: currentModel || '',
      thinking,
      updatedAt: new Date().toISOString(),
    });
  }, [attachments, currentModel, currentProvider, onDraftChange, thinking, value]);

  function updateProvider(nextProvider: string) {
    setProvider(nextProvider);
    // 切回已配置的默认 provider 时,用配置的模型;否则用该 provider 的 catalog 默认。
    if (nextProvider === defaultProvider && defaultModel) { setModel(defaultModel); return; }
    const next = modelProviders.find((item) => item.id === nextProvider);
    if (next?.defaultModel) setModel(next.defaultModel);
    else setModel(FALLBACK_PROVIDER_MODELS[nextProvider]?.[0] || '');
  }

  async function send() {
    const text = value.trim();
    if (!text && attachments.length === 0) return;
    const refineDecision = await prepareSend(text);
    if (refineDecision.action === 'preview') return;
    const finalText = refineDecision.text;
    const modelConfig = buildSessionModelConfig(
      { provider: currentProvider, model: currentModel, baseUrl: '', apiKey: '' },
      { provider: defaultProvider, model: defaultModel, baseUrl: defaultBaseUrl },
    );
    onSend(finalText, { files: attachments, model: currentModel, ...(modelConfig ? { modelConfig } : {}), thinking });
    setValue('');
    setAttachments([]);
    resetRefineAfterSend();
    close();
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (mode && items.length) {
      if (event.key === 'Escape') { event.preventDefault(); close(); return; }
      if (event.key === 'ArrowDown') { event.preventDefault(); setActive((a) => (a + 1) % items.length); return; }
      if (event.key === 'ArrowUp') { event.preventDefault(); setActive((a) => (a - 1 + items.length) % items.length); return; }
      if (event.key === 'Enter') { event.preventDefault(); items[active]?.apply(); return; }
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  }

  function addFiles(list: FileList | null) {
    if (!list || list.length === 0) return;
    setAttachments((prev) => mergeComposerFiles(prev, Array.from(list)));
  }

  function onDragEnter(event: DragEvent<HTMLDivElement>) {
    if (!dragContainsFiles(event)) return;
    event.preventDefault();
    dragDepthRef.current += 1;
    setDragging(true);
  }

  function onDragOver(event: DragEvent<HTMLDivElement>) {
    if (!dragContainsFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    if (!dragging) setDragging(true);
  }

  function onDragLeave(event: DragEvent<HTMLDivElement>) {
    if (!dragContainsFiles(event)) return;
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0 || event.currentTarget === event.target) setDragging(false);
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    if (!dragContainsFiles(event)) return;
    event.preventDefault();
    dragDepthRef.current = 0;
    setDragging(false);
    addFiles(event.dataTransfer?.files ?? null);
  }

  return (
    <div
      className={'composer' + (dragging ? ' is-dragging' : '')}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {dragging && <div className="composer-drop-hint"><strong>松开添加文件</strong><span>支持一次拖入多个文件</span></div>}
      {mode && items.length > 0 && <ComposerSuggestions mode={mode} items={items} active={active} />}

      <ComposerAttachments attachments={attachments} onRemove={(index) => setAttachments((prev) => prev.filter((_, i) => i !== index))} />

      {refineResult && (
        <RefinePreview
          original={refineOriginal}
          result={refineResult}
          onResolve={(_action, prompt) => resolvePreview(prompt)}
        />
      )}
      {refineNotice && <div className="composer-refine-notice">{refineNotice}</div>}

      <textarea
        ref={ref}
        value={value}
        placeholder="今天想完成什么？例如：帮我把这些表格合并成一个总表"
        onChange={(e) => onChange(e.target.value, e.target.selectionStart ?? e.target.value.length)}
        onKeyDown={onKeyDown}
        onBlur={() => setTimeout(close, 120)}
      />

      <input ref={fileRef} type="file" multiple hidden aria-label="选择附件文件" data-testid="composer-file-input" onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
      <ComposerFooter
        listening={listening} refining={refining}
        canRefine={canRefine}
        model={model} modelOptions={modelOptions} provider={currentProvider}
        modelProviders={modelProviders}
        defaultModel={defaultModel} thinking={thinking}
        onUpload={() => fileRef.current?.click()}
        onToggleVoice={toggleVoice} onRefine={() => void refineCurrent(value)}
        onProvider={updateProvider} onModel={setModel}
        onThinking={setThinking} onSend={() => void send()}
        onInsertTrigger={insertTrigger}
      />
    </div>
  );
}
