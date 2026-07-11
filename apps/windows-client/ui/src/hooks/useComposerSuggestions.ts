// useComposerSuggestions(UI · hooks 层)
// ---------------------------------------------------------------------------
// 职责:驱动输入框的智能建议弹窗——监听触发(/模板、@提及、↑历史)、维护候选列表与高亮项、处理键盘选择/插入。
//       依赖:lib/composer-trigger 纯逻辑 + 起步建议数据源。
import { useRef, useState } from 'react';
import type { RefObject } from 'react';
import { MENTION_SEARCH_DEBOUNCE_MS } from '../lib/composer-logic';
import {
  buildHistorySuggestionItems,
  buildMentionSuggestionItems,
  buildTemplateSuggestionItems,
  findComposerTrigger,
  mentionInsertText,
} from '../lib/composer-trigger';
import type {
  ComposerSuggestionItem,
  ComposerSuggestionMode,
  ComposerTriggerChar,
  FileHit,
  HistoryRun,
  Recipe,
} from '../lib/types/composer';

export interface UseComposerSuggestionsOptions {
  /** 当前受控 textarea 值。 */
  value: string;
  /** textarea 的受控 setter。 */
  setValue: (next: string) => void;
  /** 底层 textarea 引用,用于读取光标与恢复焦点。 */
  textareaRef: RefObject<HTMLTextAreaElement>;
  /** @ 提及的异步搜索,返回最多 N 个文件命中。 */
  searchFiles: (query: string) => Promise<FileHit[]>;
  /** / 模板建议使用的配方目录。 */
  recipes: Recipe[];
  /** # 历史建议使用的历史运行目录。 */
  historyRuns: HistoryRun[];
  /** 与模板一起展示的斜杠命令。 */
  slashCommands: Array<{ id: string; label: string; run: () => void }>;
  /** 用户选择模板配方时通知父层。 */
  onPickTemplate?: ((recipe: Recipe) => void) | undefined;
  /** 用户选择历史运行时通知父层。 */
  onPickHistory?: ((run: HistoryRun) => void) | undefined;
  /** 用户从 @ 提及里选中一个工作区文件时通知父层(用于把该文件作为 recipe 来源引用)。 */
  onPickMention?: ((hit: FileHit) => void) | undefined;
  /** 来自 useComposerRefine,用于重置「提示词已变化」标记。 */
  markChanged: (next: string) => void;
}

export interface UseComposerSuggestionsResult {
  mode: ComposerSuggestionMode | null;
  items: ComposerSuggestionItem[];
  active: number;
  setActive: (next: number | ((prev: number) => number)) => void;
  onChange: (next: string, caret: number) => void;
  close: () => void;
  insertTrigger: (char: ComposerTriggerChar) => void;
}

// 管理 textarea 建议弹窗状态机(mode/items/active/triggerStart)与 onChange/insertTrigger/close 胶水。
// 从 Composer.tsx 拆出后,父文件保持在体量门限内,建议逻辑也能独立测试。
export function useComposerSuggestions(opts: UseComposerSuggestionsOptions): UseComposerSuggestionsResult {
  const {
    value, setValue, textareaRef,
    searchFiles, recipes, historyRuns, slashCommands,
    onPickTemplate, onPickHistory, onPickMention, markChanged,
  } = opts;

  const [mode, setMode] = useState<ComposerSuggestionMode | null>(null);
  const [items, setItems] = useState<ComposerSuggestionItem[]>([]);
  const [active, setActive] = useState(0);
  const [triggerStart, setTriggerStart] = useState(0);
  const searchToken = useRef(0);
  const mentionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function close() {
    if (mentionTimer.current) clearTimeout(mentionTimer.current);
    mentionTimer.current = null;
    setMode(null);
    setItems([]);
    setActive(0);
  }

  function replaceToken(insert: string) {
    const el = textareaRef.current;
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
    setItems(buildMentionSuggestionItems(hits, (hit) => { replaceToken(mentionInsertText(hit)); onPickMention?.(hit); }));
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
        onRecipe: (recipe) => { onPickTemplate?.(recipe); setValue(`${recipe.name}:读取本地材料并生成可审批产物`); close(); },
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
      // 空 query(刚点「引用文件」插入裸 @)也要弹菜单并列出最近文件,而不是 close()。
      scheduleMentions(trigger.query);
      return;
    }
    close();
  }

  // 给 /、@、# 触发符提供可视化按钮:插入触发字符、恢复焦点,再复用 onChange 的检测逻辑弹出建议。
  function insertTrigger(char: ComposerTriggerChar) {
    const el = textareaRef.current;
    const caret = el?.selectionStart ?? value.length;
    const head = value.slice(0, caret);
    const tail = value.slice(caret);
    const needsSpace = head.length > 0 && !/\s$/.test(head);
    const insertion = needsSpace ? ` ${char}` : char;
    const next = head + insertion + tail;
    setValue(next);
    setTimeout(() => {
      const node = textareaRef.current;
      if (!node) return;
      node.focus();
      const pos = caret + insertion.length;
      node.setSelectionRange(pos, pos);
      onChange(next, pos);
    }, 0);
  }

  return { mode, items, active, setActive, onChange, close, insertTrigger };
}
