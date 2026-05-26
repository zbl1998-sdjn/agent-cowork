import type { Command } from './CommandPalette';
import { Composer, type ComposerMeta, type FileHit, type HistoryRun, type Recipe } from './Composer';
import { Button } from './ui/Button';
import type { PromptRefineResult } from '../lib/api/prompt';

interface AppComposerDockProps {
  commands: Command[];
  defaultBaseUrl?: string;
  defaultModel: string;
  defaultProvider?: string;
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

interface AppComposerDockStatusProps {
  selectedRecipe: Recipe | null;
  streamingId: string | null;
  onClearRecipe: () => void;
  onStopStreaming: () => void;
}

export function AppComposerDockStatus({ selectedRecipe, streamingId, onClearRecipe, onStopStreaming }: AppComposerDockStatusProps) {
  return (
    <>
      {streamingId && (
        <div className="stop-bar">
          <Button
            className="stop-btn"
            onClick={onStopStreaming}
            style={{ borderColor: '#c96442', background: '#fff', color: '#c96442', borderRadius: 18, padding: '6px 16px' }}
          >
            ■ 停止生成
          </Button>
        </div>
      )}
      {selectedRecipe && (
        <div className="recipe-chip">
          模板：{selectedRecipe.name}{' '}
          <Button size="sm" onClick={onClearRecipe}>
            清除
          </Button>
        </div>
      )}
    </>
  );
}

export function AppComposerDock({
  commands,
  defaultBaseUrl,
  defaultModel,
  defaultProvider,
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
      <AppComposerDockStatus selectedRecipe={selectedRecipe} streamingId={streamingId} onClearRecipe={onClearRecipe} onStopStreaming={onStopStreaming} />
      <Composer
        recipes={recipes}
        historyRuns={history}
        searchFiles={onSearchFiles}
        models={models}
        defaultModel={defaultModel}
        defaultProvider={defaultProvider}
        defaultBaseUrl={defaultBaseUrl}
        autoClarify={autoClarify}
        slashCommands={commands}
        onSend={onSend}
        onRefinePrompt={onRefinePrompt}
        onPickTemplate={onPickTemplate}
      />
    </footer>
  );
}
