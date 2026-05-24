import type { Command } from './CommandPalette';
import { Composer, type ComposerMeta, type FileHit, type HistoryRun, type Recipe } from './Composer';
import type { PromptRefineResult } from '../lib/api/prompt';

interface AppComposerDockProps {
  commands: Command[];
  defaultModel: string;
  history: HistoryRun[];
  models: string[];
  recipes: Recipe[];
  selectedRecipe: Recipe | null;
  streamingId: string | null;
  autoClarify: boolean;
  onClearRecipe: () => void;
  onPickTemplate: (recipe: Recipe) => void;
  onRefinePrompt: (text: string) => Promise<PromptRefineResult>;
  onSearchFiles: (query: string) => Promise<FileHit[]>;
  onSend: (text: string, meta: ComposerMeta) => void;
  onStopStreaming: () => void;
}

export function AppComposerDock({
  commands,
  defaultModel,
  history,
  models,
  recipes,
  selectedRecipe,
  streamingId,
  autoClarify,
  onClearRecipe,
  onPickTemplate,
  onRefinePrompt,
  onSearchFiles,
  onSend,
  onStopStreaming,
}: AppComposerDockProps) {
  return (
    <footer className="composer-dock">
      {streamingId && <div className="stop-bar"><button type="button" className="stop-btn" onClick={onStopStreaming}>■ 停止生成</button></div>}
      {selectedRecipe && <div className="recipe-chip">模板：{selectedRecipe.name} <button type="button" onClick={onClearRecipe}>清除</button></div>}
      <Composer
        recipes={recipes}
        historyRuns={history}
        searchFiles={onSearchFiles}
        models={models}
        defaultModel={defaultModel}
        autoClarify={autoClarify}
        slashCommands={commands}
        onSend={onSend}
        onRefinePrompt={onRefinePrompt}
        onPickTemplate={onPickTemplate}
      />
    </footer>
  );
}
