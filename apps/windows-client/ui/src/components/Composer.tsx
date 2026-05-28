import { useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { ModelRunConfig } from '../lib/api/chat';
import type { PromptRefineResult } from '../lib/api/prompt';
import { buildSessionModelConfig, MENTION_SEARCH_DEBOUNCE_MS, shouldDebounceMentionSearch } from '../lib/composer-logic';
import { buildHistorySuggestionItems, buildMentionSuggestionItems, buildTemplateSuggestionItems, findComposerTrigger, mentionInsertText } from '../lib/composer-trigger';
import { useComposerRefine } from '../hooks/useComposerRefine';
import { ComposerAttachments } from './ComposerAttachments';
import { ComposerFooter, type ThinkingLevel } from './ComposerFooter';
import { ComposerSuggestions, type ComposerSuggestionItem, type ComposerSuggestionMode } from './ComposerSuggestions';
import { RefinePreview } from './chat/RefinePreview';
import { useComposerVoice } from '../hooks/useComposerVoice';
import { Button } from './ui/Button';
export interface Recipe { id: string; name: string; summary?: string }
export interface FileHit { path: string; relativePath?: string }
export interface HistoryRun { id: string; promptPreview?: string | null }
export type { ThinkingLevel } from './ComposerFooter';
export interface ComposerMeta {
  files: File[];
  model: string;
  modelConfig?: ModelRunConfig;
  thinking: ThinkingLevel;
}

export interface ComposerProps {
  recipes: Recipe[];
  historyRuns: HistoryRun[];
  searchFiles: (query: string) => Promise<FileHit[]>;
  onSend: (text: string, meta: ComposerMeta) => void;
  onPickTemplate?: (recipe: Recipe) => void;
  onPickHistory?: (run: HistoryRun) => void;
  slashCommands?: Array<{ id: string; label: string; run: () => void }>;
  models?: string[];
  defaultModel?: string;
  defaultProvider?: string;
  defaultBaseUrl?: string;
  autoClarify?: boolean;
  onRefinePrompt?: (text: string) => Promise<PromptRefineResult>;
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
  defaultModel = '',
  defaultProvider = 'kimi-api',
  defaultBaseUrl = '',
  autoClarify = false,
  onRefinePrompt,
}: ComposerProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState('');
  const [mode, setMode] = useState<ComposerSuggestionMode | null>(null);
  const [items, setItems] = useState<ComposerSuggestionItem[]>([]);
  const [active, setActive] = useState(0);
  const [triggerStart, setTriggerStart] = useState(0);
  const [attachments, setAttachments] = useState<File[]>([]);
  const [model, setModel] = useState('');
  const [provider, setProvider] = useState('');
  const [thinking, setThinking] = useState<ThinkingLevel>('standard');
  const [dragging, setDragging] = useState(false);
  const searchToken = useRef(0);
  const mentionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { listening, toggleVoice } = useComposerVoice({
    onTranscript: (transcript) => setValue((v) => (v ? `${v} ${transcript}` : transcript)),
    onUnsupported: () => setValue((v) => `${v}${v ? '\n' : ''}（此浏览器不支持语音输入）`),
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

  const modelOptions = models.length ? models : (defaultModel ? [defaultModel] : []);
  const currentModel = model.trim() || defaultModel;
  const currentProvider = provider || defaultProvider || 'kimi-api';

  function close() {
    if (mentionTimer.current) clearTimeout(mentionTimer.current);
    mentionTimer.current = null;
    setMode(null);
    setItems([]);
    setActive(0);
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

  function replaceToken(insert: string) {
    const el = ref.current;
    const caret = el?.selectionStart ?? value.length;
    const next = value.slice(0, triggerStart) + insert + value.slice(caret);
    setValue(next);
    close();
    el?.focus();
  }

  async function refreshMentions(query: string) {
    const token = ++searchToken.current;
    let hits: FileHit[] = [];
    try { hits = await searchFiles(query); } catch { hits = []; }
    if (token !== searchToken.current) return;
    setItems(buildMentionSuggestionItems(hits, (hit) => replaceToken(mentionInsertText(hit))));
    setActive(0);
  }

  function scheduleMentions(query: string) {
    if (mentionTimer.current) clearTimeout(mentionTimer.current);
    mentionTimer.current = setTimeout(() => {
      mentionTimer.current = null;
      void refreshMentions(query);
    }, MENTION_SEARCH_DEBOUNCE_MS);
  }

  function onChange(next: string, caret: number) {
    setValue(next);
    markChanged(next);
    const trigger = findComposerTrigger(next.slice(0, caret));
    if (trigger?.mode === 'template') {
      setMode('template');
      setTriggerStart(trigger.triggerStart);
      setItems(buildTemplateSuggestionItems({
        slashCommands,
        recipes,
        query: trigger.query,
        onCommand: (command) => { replaceToken(''); command.run(); },
        onRecipe: (recipe) => { onPickTemplate?.(recipe); setValue(`${recipe.name}：读取本地材料并生成可审批产物`); close(); },
      }));
      setActive(0);
      return;
    }
    if (trigger?.mode === 'history') {
      setMode('history');
      setTriggerStart(trigger.triggerStart);
      setItems(buildHistorySuggestionItems({
        historyRuns,
        query: trigger.query,
        onPick: (run) => { onPickHistory?.(run); close(); },
      }));
      setActive(0);
      return;
    }
    if (trigger?.mode === 'mention') {
      setMode('mention');
      setTriggerStart(trigger.triggerStart);
      if (shouldDebounceMentionSearch(trigger.query)) scheduleMentions(trigger.query); else close();
      return;
    }
    close();
  }

  // Visual replacements for the cryptic /-@-# slash triggers. The user clicks
  // a button and we insert the trigger character (with a leading space if the
  // caret isn't already at a word boundary), refocus, then call onChange so the
  // existing trigger-detection logic surfaces the right suggestion popup.
  function insertTrigger(char: '/' | '@' | '#') {
    const el = ref.current;
    const caret = el?.selectionStart ?? value.length;
    const head = value.slice(0, caret);
    const tail = value.slice(caret);
    const needsSpace = head.length > 0 && !/\s$/.test(head);
    const insertion = needsSpace ? ` ${char}` : char;
    const next = head + insertion + tail;
    setValue(next);
    setTimeout(() => {
      const node = ref.current;
      if (!node) return;
      node.focus();
      const pos = caret + insertion.length;
      node.setSelectionRange(pos, pos);
      onChange(next, pos);
    }, 0);
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

      <div className="composer-triggers" role="group" aria-label="快捷插入">
        <Button variant="secondary" className="composer-trigger-btn" onClick={() => insertTrigger('/')} title="插入「/」从模板或命令里挑一个">📝 模板</Button>
        <Button variant="secondary" className="composer-trigger-btn" onClick={() => insertTrigger('@')} title="插入「@」搜索并引用工作区里的文件">📎 引用文件</Button>
        <Button variant="secondary" className="composer-trigger-btn" onClick={() => insertTrigger('#')} title="插入「#」翻最近的对话">🕘 历史</Button>
      </div>

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
