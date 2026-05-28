import { useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { buildSessionModelConfig } from '../lib/composer-logic';
import { useComposerRefine } from '../hooks/useComposerRefine';
import { useComposerSuggestions } from '../hooks/useComposerSuggestions';
import { ComposerAttachments } from './ComposerAttachments';
import { ComposerFooter, type ThinkingLevel } from './ComposerFooter';
import { ComposerSuggestions } from './ComposerSuggestions';
import { RefinePreview } from './chat/RefinePreview';
import { useComposerVoice } from '../hooks/useComposerVoice';
import { ComposerTriggers } from './ComposerTriggers';
import type { ComposerProps } from './composer-types';
// AppComposerDock + Composer.test import ComposerMeta from this module; the
// types live in composer-types but we re-export them here so import paths stay stable.
export type { ComposerMeta, ComposerProps, FileHit, HistoryRun, Recipe } from './composer-types';
export type { ThinkingLevel } from './ComposerFooter';

export function Composer({
  recipes,
  historyRuns,
  searchFiles,
  onSend,
  onPickTemplate,
  onPickHistory,
  slashCommands = [],
  models = [],
  defaultModel = '',
  defaultProvider = 'kimi-api',
  defaultBaseUrl = '',
  autoClarify = false,
  onRefinePrompt,
}: ComposerProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
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

  const modelOptions = models.length ? models : (defaultModel ? [defaultModel] : []);
  const currentModel = model.trim() || defaultModel;
  const currentProvider = provider || defaultProvider || 'kimi-api';

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
    setAttachments((prev) => [...prev, ...Array.from(list)]);
  }

  return (
    <div
      className={'composer' + (dragging ? ' is-dragging' : '')}
      onDragOver={(e) => { e.preventDefault(); if (!dragging) setDragging(true); }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDragging(false); }}
      onDrop={(e) => { e.preventDefault(); setDragging(false); addFiles(e.dataTransfer?.files ?? null); }}
    >
      {dragging && <div className="composer-drop-hint">松开以添加文件</div>}
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

      <ComposerTriggers onTrigger={insertTrigger} />

      <textarea
        ref={ref}
        value={value}
        placeholder="今天想让 Kimi 做什么?"
        onChange={(e) => onChange(e.target.value, e.target.selectionStart ?? e.target.value.length)}
        onKeyDown={onKeyDown}
        onBlur={() => setTimeout(close, 120)}
      />

      <input ref={fileRef} type="file" multiple hidden onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
      <ComposerFooter
        listening={listening} refining={refining}
        canRefine={canRefine}
        model={model} modelOptions={modelOptions} provider={currentProvider}
        defaultModel={defaultModel} thinking={thinking}
        onUpload={() => fileRef.current?.click()}
        onToggleVoice={toggleVoice} onRefine={() => void refineCurrent(value)}
        onProvider={setProvider} onModel={setModel}
        onThinking={setThinking} onSend={() => void send()}
      />
    </div>
  );
}
