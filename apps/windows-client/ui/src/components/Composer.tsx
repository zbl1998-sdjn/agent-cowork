import { useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { ModelRunConfig } from '../lib/api/chat';
import type { PromptRefineResult } from '../lib/api/prompt';
import { buildSessionModelConfig, MENTION_SEARCH_DEBOUNCE_MS, resolveRefineSendDecision, shouldDebounceMentionSearch, shouldRefineBeforeSend } from '../lib/composer-logic';
import { ComposerSendAction, ComposerToolActions } from './ComposerActions';
import { ComposerAttachments } from './ComposerAttachments';
import { ComposerModelControls } from './ComposerModelControls';
import { RefinePreview } from './chat/RefinePreview';
import { ListboxOptionButton } from './ui/MenuItemButton';
export interface Recipe { id: string; name: string; summary?: string }
export interface FileHit { path: string; relativePath?: string }
export interface HistoryRun { id: string; promptPreview?: string | null }
export type ThinkingLevel = 'fast' | 'standard' | 'deep';
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
type Mode = 'template' | 'mention' | 'history';
interface Item { key: string; title: string; detail?: string; apply: () => void }
const THINKING_OPTIONS: Array<{ value: ThinkingLevel; label: string }> = [
  { value: 'fast', label: '快速' },
  { value: 'standard', label: '标准' },
  { value: 'deep', label: '深度' },
];
// Minimal shape of the Web Speech API recognizer (no @types dependency).
type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
};
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
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const [value, setValue] = useState('');
  const [mode, setMode] = useState<Mode | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [active, setActive] = useState(0);
  const [triggerStart, setTriggerStart] = useState(0);
  const [attachments, setAttachments] = useState<File[]>([]);
  const [model, setModel] = useState('');
  const [provider, setProvider] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [thinking, setThinking] = useState<ThinkingLevel>('standard');
  const [listening, setListening] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [refining, setRefining] = useState(false);
  const [refineOriginal, setRefineOriginal] = useState('');
  const [refineResult, setRefineResult] = useState<PromptRefineResult | null>(null);
  const [refineNotice, setRefineNotice] = useState('');
  const searchToken = useRef(0);
  const skipRefineFor = useRef('');
  const mentionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  function clearRefine() {
    setRefineOriginal('');
    setRefineResult(null);
  }

  async function fetchRefine(text: string, showError: boolean): Promise<PromptRefineResult | null> {
    if (!onRefinePrompt) return null;
    setRefining(true);
    if (showError) setRefineNotice('');
    try {
      return await onRefinePrompt(text);
    } catch {
      if (showError) setRefineNotice('提示优化暂不可用，请稍后重试');
      return null;
    } finally {
      setRefining(false);
    }
  }

  async function refineCurrent() {
    const text = value.trim();
    if (!text || !onRefinePrompt) return;
    const result = await fetchRefine(text, true);
    if (!result) return;
    if (result.changed || result.missing.length > 0) {
      setRefineOriginal(text);
      setRefineResult(result);
      setRefineNotice('');
      return;
    }
    clearRefine();
    setRefineNotice('当前提示已足够明确');
  }

  function resolvePreview(prompt: string) {
    const next = prompt.trim();
    setValue(next);
    skipRefineFor.current = next;
    clearRefine();
    setRefineNotice('');
    ref.current?.focus();
  }

  async function send() {
    const text = value.trim();
    if (!text && attachments.length === 0) return;
    let finalText = text;
    if (shouldRefineBeforeSend(autoClarify, text) && skipRefineFor.current !== text) {
      const result = await fetchRefine(text, false);
      if (result) {
        const decision = resolveRefineSendDecision(text, result);
        if (decision.action === 'preview') {
          setRefineOriginal(text);
          setRefineResult(decision.result);
          setRefineNotice('');
          return;
        }
        finalText = decision.text;
      }
    }
    const modelConfig = buildSessionModelConfig(
      { provider: currentProvider, model: currentModel, baseUrl, apiKey },
      { provider: defaultProvider, model: defaultModel, baseUrl: defaultBaseUrl },
    );
    onSend(finalText, { files: attachments, model: currentModel, ...(modelConfig ? { modelConfig } : {}), thinking });
    skipRefineFor.current = '';
    setValue('');
    setAttachments([]);
    clearRefine();
    setRefineNotice('');
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

  function templateItems(query: string): Item[] {
    const q = query.toLowerCase();
    // App commands first (new chat, settings, theme, panels…), then task templates.
    const cmds: Item[] = slashCommands
      .filter((c) => !q || c.label.toLowerCase().includes(q) || c.id.toLowerCase().includes(q))
      .slice(0, 6)
      .map((c) => ({
        key: `cmd:${c.id}`,
        title: c.label,
        detail: '命令',
        apply: () => { replaceToken(''); c.run(); },
      }));
    const tmpls: Item[] = recipes
      .filter((r) => !q || `${r.name} ${r.id} ${r.summary ?? ''}`.toLowerCase().includes(q))
      .slice(0, 6)
      .map((r) => ({
        key: r.id,
        title: r.name,
        detail: r.summary || r.id,
        apply: () => { onPickTemplate?.(r); setValue(`${r.name}：读取本地材料并生成可审批产物`); close(); },
      }));
    return [...cmds, ...tmpls];
  }

  function historyItems(query: string): Item[] {
    const q = query.toLowerCase();
    return historyRuns
      .filter((run) => !q || (run.promptPreview ?? '').toLowerCase().includes(q))
      .slice(0, 8)
      .map((run) => ({
        key: run.id,
        title: run.promptPreview || run.id,
        detail: run.id,
        apply: () => { onPickHistory?.(run); close(); },
      }));
  }

  async function refreshMentions(query: string) {
    const token = ++searchToken.current;
    let hits: FileHit[] = [];
    try { hits = await searchFiles(query); } catch { hits = []; }
    if (token !== searchToken.current) return;
    setItems(hits.slice(0, 8).map((f) => ({
      key: f.path,
      title: f.relativePath || f.path,
      detail: 'file',
      apply: () => replaceToken(`@${(f.relativePath || f.path).split(/[\\/]/).pop()} `),
    })));
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
    if (next.trim() !== skipRefineFor.current) skipRefineFor.current = '';
    if (refineResult) clearRefine();
    if (refineNotice) setRefineNotice('');
    const before = next.slice(0, caret);
    const slash = before.match(/(?:^|\n)\/([^\s/]*)$/);
    if (slash) {
      setMode('template');
      setTriggerStart(before.length - slash[1].length - 1);
      setItems(templateItems(slash[1]));
      setActive(0);
      return;
    }
    const hash = before.match(/(?:^|\n)#([^\s#]*)$/);
    if (hash) {
      setMode('history');
      setTriggerStart(before.length - hash[1].length - 1);
      setItems(historyItems(hash[1]));
      setActive(0);
      return;
    }
    const at = before.match(/@([^\s@]*)$/);
    if (at) {
      setMode('mention');
      setTriggerStart(before.length - at[1].length - 1);
      if (shouldDebounceMentionSearch(at[1])) scheduleMentions(at[1]); else close();
      return;
    }
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

  function toggleVoice() {
    const w = window as unknown as {
      SpeechRecognition?: new () => SpeechRecognitionLike;
      webkitSpeechRecognition?: new () => SpeechRecognitionLike;
    };
    const Ctor = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!Ctor) {
      setValue((v) => `${v}${v ? '\n' : ''}（此浏览器不支持语音输入）`);
      return;
    }
    if (listening) {
      recognitionRef.current?.stop();
      return;
    }
    const recognition = new Ctor();
    recognition.lang = 'zh-CN';
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.onresult = (event) => {
      let transcript = '';
      for (let i = 0; i < event.results.length; i += 1) {
        transcript += event.results[i][0].transcript;
      }
      setValue((v) => (v ? `${v} ${transcript}` : transcript));
    };
    recognition.onend = () => { setListening(false); recognitionRef.current = null; };
    recognition.onerror = () => { setListening(false); recognitionRef.current = null; };
    recognitionRef.current = recognition;
    setListening(true);
    recognition.start();
  }

  return (
    <div
      className={'composer' + (dragging ? ' is-dragging' : '')}
      onDragOver={(e) => { e.preventDefault(); if (!dragging) setDragging(true); }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDragging(false); }}
      onDrop={(e) => { e.preventDefault(); setDragging(false); addFiles(e.dataTransfer?.files ?? null); }}
    >
      {dragging && <div className="composer-drop-hint">松开以添加文件</div>}
      {mode && items.length > 0 && (
        <div className="composer-popover" role="listbox">
          <div className="popover-header">{mode === 'template' ? '命令 / 任务模板' : mode === 'history' ? '历史任务' : '引用本地文件'}</div>
          {items.map((item, index) => (
            <ListboxOptionButton
              key={item.key}
              className="popover-item"
              active={index === active}
              onMouseDown={(e) => { e.preventDefault(); item.apply(); }}
            >
              <strong>{item.title}</strong>
              {item.detail && <span>{item.detail}</span>}
            </ListboxOptionButton>
          ))}
        </div>
      )}

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
        placeholder="今天想让 Kimi 做什么？ / 模板 · @文件 · #历史"
        onChange={(e) => onChange(e.target.value, e.target.selectionStart ?? e.target.value.length)}
        onKeyDown={onKeyDown}
        onBlur={() => setTimeout(close, 120)}
      />

      <div className="composer-footer">
        <div className="composer-tools">
          <input ref={fileRef} type="file" multiple hidden onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
          <ComposerToolActions listening={listening} refining={refining} canRefine={Boolean(value.trim() && onRefinePrompt)} onUpload={() => fileRef.current?.click()} onToggleVoice={toggleVoice} onRefine={() => void refineCurrent()} />
          <ComposerModelControls model={model} modelOptions={modelOptions} provider={currentProvider} defaultModel={defaultModel} defaultBaseUrl={defaultBaseUrl} baseUrl={baseUrl} apiKey={apiKey} onProvider={setProvider} onModel={setModel} onBaseUrl={setBaseUrl} onApiKey={setApiKey} />
          <select className="thinking-select" value={thinking} onChange={(e) => setThinking(e.target.value as ThinkingLevel)} title="思考强度">
            {THINKING_OPTIONS.map((opt) => <option key={opt.value} value={opt.value}>思考·{opt.label}</option>)}
          </select>
        </div>
        <ComposerSendAction refining={refining} onSend={() => void send()} />
      </div>
    </div>
  );
}
