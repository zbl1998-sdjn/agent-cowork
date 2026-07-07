// 输入框触发器(UI · lib):解析输入框里的触发语法——模板(/)、@提及、历史(↑)——并算出弹窗候选项与
// 替换区间。是智能输入体验的纯逻辑核心。依赖:无。
export type ComposerTriggerMode = 'template' | 'mention' | 'history';

export interface ComposerTrigger {
  mode: ComposerTriggerMode;
  query: string;
  triggerStart: number;
}

export interface ComposerSuggestionLike {
  key: string;
  title: string;
  detail?: string | undefined;
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
  summary?: string | undefined;
}

export interface HistoryRunLike {
  id: string;
  promptPreview?: string | null | undefined;
}

export interface FileHitLike {
  path: string;
  relativePath?: string | undefined;
}

export function findComposerTrigger(beforeCaret: string): ComposerTrigger | null {
  const slash = beforeCaret.match(/(?:^|\n)\/([^\s/]*)$/);
  const slashQuery = slash?.[1];
  if (slashQuery !== undefined) {
    return { mode: 'template', query: slashQuery, triggerStart: beforeCaret.length - slashQuery.length - 1 };
  }
  const hash = beforeCaret.match(/(?:^|\n)#([^\s#]*)$/);
  const hashQuery = hash?.[1];
  if (hashQuery !== undefined) {
    return { mode: 'history', query: hashQuery, triggerStart: beforeCaret.length - hashQuery.length - 1 };
  }
  const at = beforeCaret.match(/@([^\s@]*)$/);
  const atQuery = at?.[1];
  if (atQuery !== undefined) {
    return { mode: 'mention', query: atQuery, triggerStart: beforeCaret.length - atQuery.length - 1 };
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

/** @ 提及选中文件的 basename→path 记录里,挑出仍以 `@basename` 出现在文本中的文件路径(去重)。
 * 用户删掉 @ 文本即视为取消引用。用于把「引用本地文件」选中的源带进 recipe files。 */
export function referencedFilePaths(mentioned: ReadonlyMap<string, string>, text: string): string[] {
  const out: string[] = [];
  for (const [base, path] of mentioned) {
    if (base && text.includes(`@${base}`)) out.push(path);
  }
  return [...new Set(out)];
}
