export type ComposerTriggerMode = 'template' | 'mention' | 'history';

export interface ComposerTrigger {
  mode: ComposerTriggerMode;
  query: string;
  triggerStart: number;
}

export interface ComposerSuggestionLike {
  key: string;
  title: string;
  detail?: string;
  apply: () => void;
}

export interface SlashCommandLike {
  id: string;
  label: string;
  run: () => void;
}

export interface RecipeLike {
  id: string;
  name: string;
  summary?: string;
}

export interface HistoryRunLike {
  id: string;
  promptPreview?: string | null;
}

export interface FileHitLike {
  path: string;
  relativePath?: string;
}

export function findComposerTrigger(beforeCaret: string): ComposerTrigger | null {
  const slash = beforeCaret.match(/(?:^|\n)\/([^\s/]*)$/);
  if (slash) {
    return { mode: 'template', query: slash[1], triggerStart: beforeCaret.length - slash[1].length - 1 };
  }
  const hash = beforeCaret.match(/(?:^|\n)#([^\s#]*)$/);
  if (hash) {
    return { mode: 'history', query: hash[1], triggerStart: beforeCaret.length - hash[1].length - 1 };
  }
  const at = beforeCaret.match(/@([^\s@]*)$/);
  if (at) {
    return { mode: 'mention', query: at[1], triggerStart: beforeCaret.length - at[1].length - 1 };
  }
  return null;
}

export function buildTemplateSuggestionItems({
  slashCommands,
  recipes,
  query,
  onCommand,
  onRecipe,
}: {
  slashCommands: SlashCommandLike[];
  recipes: RecipeLike[];
  query: string;
  onCommand: (command: SlashCommandLike) => void;
  onRecipe: (recipe: RecipeLike) => void;
}): ComposerSuggestionLike[] {
  const q = query.toLowerCase();
  const commands = slashCommands
    .filter((command) => !q || command.label.toLowerCase().includes(q) || command.id.toLowerCase().includes(q))
    .slice(0, 6)
    .map((command) => ({
      key: `cmd:${command.id}`,
      title: command.label,
      detail: '命令',
      apply: () => onCommand(command),
    }));
  const templates = recipes
    .filter((recipe) => !q || `${recipe.name} ${recipe.id} ${recipe.summary ?? ''}`.toLowerCase().includes(q))
    .slice(0, 6)
    .map((recipe) => ({
      key: recipe.id,
      title: recipe.name,
      detail: recipe.summary || recipe.id,
      apply: () => onRecipe(recipe),
    }));
  return [...commands, ...templates];
}

export function buildHistorySuggestionItems({
  historyRuns,
  query,
  onPick,
}: {
  historyRuns: HistoryRunLike[];
  query: string;
  onPick: (run: HistoryRunLike) => void;
}): ComposerSuggestionLike[] {
  const q = query.toLowerCase();
  return historyRuns
    .filter((run) => !q || (run.promptPreview ?? '').toLowerCase().includes(q))
    .slice(0, 8)
    .map((run) => ({
      key: run.id,
      title: run.promptPreview || run.id,
      detail: run.id,
      apply: () => onPick(run),
    }));
}

export function buildMentionSuggestionItems(
  hits: FileHitLike[],
  onPick: (hit: FileHitLike) => void,
): ComposerSuggestionLike[] {
  return hits.slice(0, 8).map((hit) => ({
    key: hit.path,
    title: hit.relativePath || hit.path,
    detail: 'file',
    apply: () => onPick(hit),
  }));
}

export function mentionInsertText(hit: FileHitLike) {
  return `@${(hit.relativePath || hit.path).split(/[\\/]/).pop()} `;
}
