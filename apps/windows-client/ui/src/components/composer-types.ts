// 输入框类型(UI · components):Composer 及其子组件共享的 props/状态类型,避免跨组件类型重复。
import type { ModelRunConfig } from '../lib/api/chat';
import type { ModelProviderOption } from '../lib/api/kimiConfig';
import type { PromptRefineResult } from '../lib/api/prompt';
import type { ThinkingLevel } from './ComposerFooter';

// 从 Composer.tsx 拆出类型,让 App/Timeline/hooks 引用类型时不把整个组件模块拖进 bundle,
// 同时保持 Composer.tsx 不越过文件体量软门限。

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
  mode: 'plan' | 'execute' | 'yolo';
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
