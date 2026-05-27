export interface StarterRecipe {
  name?: string | null;
  summary?: string | null;
}

export interface StarterHistoryRun {
  promptPreview?: string | null;
}

interface StarterOptions {
  base: string[];
  recipes?: StarterRecipe[];
  historyRuns?: StarterHistoryRun[];
  max?: number;
}

const DEFAULT_MAX_STARTERS = 4;

function cleanText(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function clipText(value: string, maxChars: number): string {
  return value.length > maxChars ? `${value.slice(0, maxChars - 1)}…` : value;
}

function addUnique(target: string[], seen: Set<string>, value: string, max: number): void {
  const text = cleanText(value);
  if (!text || seen.has(text) || target.length >= max) return;
  seen.add(text);
  target.push(text);
}

export function buildContextualStarters({ base, recipes = [], historyRuns = [], max = DEFAULT_MAX_STARTERS }: StarterOptions): string[] {
  const starters: string[] = [];
  const seen = new Set<string>();
  const limit = Math.max(1, max);
  const recent = historyRuns.map((run) => cleanText(run.promptPreview)).find(Boolean);
  if (recent) addUnique(starters, seen, `继续：${clipText(recent, 30)}`, limit);

  for (const recipe of recipes) {
    const name = cleanText(recipe.name);
    if (!name) continue;
    const summary = cleanText(recipe.summary);
    const task = summary ? `用「${clipText(name, 12)}」处理：${clipText(summary, 18)}` : `用「${clipText(name, 16)}」处理当前资料`;
    addUnique(starters, seen, task, limit);
  }

  for (const starter of base) addUnique(starters, seen, starter, limit);
  return starters;
}
