// 输入框类型(UI · components):Composer 及其子组件共享的 props/状态类型,避免跨组件类型重复。
import type { ModelRunConfig } from '../lib/api/chat';
import type { PromptRefineResult } from '../lib/api/prompt';
import type { ThinkingLevel } from './ComposerFooter';

// Exported separately from Composer so App / Timeline / hooks can import the
// types without dragging the whole Composer component module into their bundle,
// and so Composer.tsx itself stays under the file-size soft limit.

export interface Recipe {
  id: string;
  name: string;
  summary?: string | undefined;
}

export interface FileHit {
  path: string;
  relativePath?: string | undefined;
}

export interface HistoryRun {
  id: string;
  promptPreview?: string | null | undefined;
}

export interface ComposerMeta {
  files: File[];
  model: string;
  modelConfig?: ModelRunConfig | undefined;
  thinking: ThinkingLevel;
}

export interface ComposerProps {
  recipes: Recipe[];
  historyRuns: HistoryRun[];
  searchFiles: (query: string) => Promise<FileHit[]>;
  onSend: (text: string, meta: ComposerMeta) => void;
  onPickTemplate?: ((recipe: Recipe) => void) | undefined;
  onPickHistory?: ((run: HistoryRun) => void) | undefined;
  slashCommands?: Array<{ id: string; label: string; run: () => void }> | undefined;
  models?: string[] | undefined;
  defaultModel?: string | undefined;
  defaultProvider?: string | undefined;
  defaultBaseUrl?: string | undefined;
  autoClarify?: boolean | undefined;
  onRefinePrompt?: ((text: string) => Promise<PromptRefineResult>) | undefined;
}
