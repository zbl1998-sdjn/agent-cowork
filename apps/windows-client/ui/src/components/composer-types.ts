import type { ModelRunConfig } from '../lib/api/chat';
import type { PromptRefineResult } from '../lib/api/prompt';
import type { ThinkingLevel } from './ComposerFooter';

// Exported separately from Composer so App / Timeline / hooks can import the
// types without dragging the whole Composer component module into their bundle,
// and so Composer.tsx itself stays under the file-size soft limit.

export interface Recipe {
  id: string;
  name: string;
  summary?: string;
}

export interface FileHit {
  path: string;
  relativePath?: string;
}

export interface HistoryRun {
  id: string;
  promptPreview?: string | null;
}

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
