// 输入框共享类型(UI · lib/types):Composer、hooks 与展示组件的单一类型事实来源。
import type { ModelRunConfig } from '../api/chat';
import type { ModelProviderOption } from '../api/kimiConfig';
import type { PromptRefineResult } from '../api/prompt';

export type ThinkingLevel = 'fast' | 'standard' | 'deep';
export type ComposerTriggerChar = '/' | '@' | '#';
export type ComposerSuggestionMode = 'template' | 'mention' | 'history';

export interface ComposerSuggestionItem {
  key: string;
  title: string;
  detail?: string | undefined;
  apply: () => void;
}

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
  // 经 @ 提及引用的工作区文件绝对路径(用于 recipe 来源);不经上传,直接引用磁盘文件。
  referencedFiles?: string[] | undefined;
  model: string;
  modelConfig?: ModelRunConfig | undefined;
  thinking: ThinkingLevel;
}

export interface ComposerDraftFile {
  name: string;
  size: number;
  type?: string | undefined;
  lastModified?: number | undefined;
}

export interface ComposerDraftPreview {
  text: string;
  files: ComposerDraftFile[];
  provider: string;
  model: string;
  thinking: ThinkingLevel;
  updatedAt: string;
}

export interface WorkbenchPreviewState extends ComposerDraftPreview {
  mode: 'plan' | 'execute' | 'auto';
  workspace: string;
  recipe: Recipe | null;
  streaming: boolean;
}

export interface ComposerProps {
  recipes: Recipe[];
  historyRuns: HistoryRun[];
  searchFiles: (query: string) => Promise<FileHit[]>;
  onSend: (text: string, meta: ComposerMeta) => void;
  onDraftChange?: ((draft: ComposerDraftPreview) => void) | undefined;
  onPickTemplate?: ((recipe: Recipe) => void) | undefined;
  onPickHistory?: ((run: HistoryRun) => void) | undefined;
  slashCommands?: Array<{ id: string; label: string; run: () => void }> | undefined;
  models?: string[] | undefined;
  modelProviders?: ModelProviderOption[] | undefined;
  defaultModel?: string | undefined;
  defaultProvider?: string | undefined;
  defaultBaseUrl?: string | undefined;
  autoClarify?: boolean | undefined;
  onRefinePrompt?: ((text: string) => Promise<PromptRefineResult>) | undefined;
}
