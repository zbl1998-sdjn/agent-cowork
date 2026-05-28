import { useRef, useState } from 'react';
import type { RefObject } from 'react';
import { MENTION_SEARCH_DEBOUNCE_MS, shouldDebounceMentionSearch } from '../lib/composer-logic';
import {
  buildHistorySuggestionItems,
  buildMentionSuggestionItems,
  buildTemplateSuggestionItems,
  findComposerTrigger,
  mentionInsertText,
} from '../lib/composer-trigger';
import type { ComposerSuggestionItem, ComposerSuggestionMode } from '../components/ComposerSuggestions';
import type { ComposerTriggerChar } from '../components/ComposerTriggers';
import type { FileHit, HistoryRun, Recipe } from '../components/composer-types';

export interface UseComposerSuggestionsOptions {
  /** Current textarea value (controlled). */
  value: string;
  /** Controlled setter for the textarea value. */
  setValue: (next: string) => void;
  /** Reference to the underlying textarea — needed to read caret + focus. */
  textareaRef: RefObject<HTMLTextAreaElement>;
  /** Async search for @-mentions; returns up to N file hits. */
  searchFiles: (query: string) => Promise<FileHit[]>;
  /** Recipes catalogue for /-template suggestions. */
  recipes: Recipe[];
  /** Previous runs catalogue for #-history suggestions. */
  historyRuns: HistoryRun[];
  /** Slash-commands surfaced alongside templates. */
  slashCommands: Array<{ id: string; label: string; run: () => void }>;
  /** Notified when the user picks a template recipe. */
  onPickTemplate?: (recipe: Recipe) => void;
  /** Notified when the user picks a previous run. */
  onPickHistory?: (run: HistoryRun) => void;
  /** From useComposerRefine — lets it reset its "the prompt changed" flag. */
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

// Owns the textarea-suggestion state machine (mode / items / active / trigger
// position) plus the imperative onChange/insertTrigger/close glue. Extracted
// from Composer.tsx so the parent file stays under the file-size soft limit
// and so the suggestion logic can be exercised independently.
export function useComposerSuggestions(opts: UseComposerSuggestionsOptions): UseComposerSuggestionsResult {
  const {
    value, setValue, textareaRef,
    searchFiles, recipes, historyRuns, slashCommands,
    onPickTemplate, onPickHistory, markChanged,
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
      if (shouldDebounceMentionSearch(trigger.query)) scheduleMentions(trigger.query); else close();
      return;
    }
    close();
  }

  // Visual replacement for the cryptic /-@-# slash triggers. The user clicks
  // a button and we insert the trigger character (with a leading space if the
  // caret isn't already at a word boundary), refocus, then call onChange so the
  // existing trigger-detection logic surfaces the right suggestion popup.
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
