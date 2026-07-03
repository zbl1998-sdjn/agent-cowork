// 底部输入区停靠层(UI · 组件层 · components)
// ---------------------------------------------------------------------------
// 职责:把 Composer(输入框)连同停止生成条、已选模板提示固定在底部,转发 App 传入的发送/精炼/搜文件等回调。
// 依赖:Composer 及其类型、Button。同文件导出 AppComposerDockStatus(停止/模板状态条)。
import { useRef, useState } from 'react';
import type { Command } from './CommandPalette';
import { Composer, type ComposerDraftPreview, type ComposerMeta, type FileHit, type HistoryRun, type Recipe } from './Composer';
import { Button } from './ui/Button';
import type { PromptRefineResult } from '../lib/api/prompt';
import type { ModelProviderOption } from '../lib/api/kimiConfig';

interface AppComposerDockProps {
  commands: Command[];
  defaultBaseUrl?: string;
  defaultModel: string;
  defaultProvider?: string;
  history: HistoryRun[];
  models: string[];
  modelProviders: ModelProviderOption[];
  recipes: Recipe[];
  selectedRecipe: Recipe | null;
  streamingId: string | null;
  autoClarify: boolean;
  onClearRecipe: () => void;
  onDraftChange?: ((draft: ComposerDraftPreview) => void) | undefined;
  onPickTemplate: (recipe: Recipe) => void;
  onRefinePrompt: (text: string) => Promise<PromptRefineResult>;
  onSearchFiles: (query: string) => Promise<FileHit[]>;
  onSend: (text: string, meta: ComposerMeta) => void;
  onStopStreaming: () => void;
  onUploadTemplates: (files: File[]) => Promise<Recipe[]>;
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

export function TemplateUploadBar({ onUploadTemplates }: { onUploadTemplates: (files: File[]) => Promise<Recipe[]> }) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const handleFiles = async (fileList: FileList | null) => {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    setBusy(true);
    setMessage('');
    setError('');
    try {
      const imported = await onUploadTemplates(files);
      setMessage(`已导入 ${imported.length} 个模板`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  return (
    <div className="template-upload-bar">
      <Button className="template-upload-button" disabled={busy} onClick={() => inputRef.current?.click()}>
        {busy ? '导入中…' : '导入任务模板'}
      </Button>
      <span className={`template-upload-status${error ? ' is-error' : ''}`} aria-live="polite">
        {error || message || '支持批量任务模板文件'}
      </span>
      <input
        ref={inputRef}
        className="template-upload-input"
        type="file"
        accept=".json,application/json"
        multiple
        hidden
        aria-label="上传任务模板文件"
        onChange={(event) => void handleFiles(event.currentTarget.files)}
      />
    </div>
  );
}

export function AppComposerDock({
  commands,
  defaultBaseUrl,
  defaultModel,
  defaultProvider,
  history,
  models,
  modelProviders,
  recipes,
  selectedRecipe,
  streamingId,
  autoClarify,
  onClearRecipe,
  onDraftChange,
  onPickTemplate,
  onRefinePrompt,
  onSearchFiles,
  onSend,
  onStopStreaming,
  onUploadTemplates,
}: AppComposerDockProps) {
  return (
    <footer className="composer-dock">
      <AppComposerDockStatus selectedRecipe={selectedRecipe} streamingId={streamingId} onClearRecipe={onClearRecipe} onStopStreaming={onStopStreaming} />
      <details className="template-upload-details">
        <summary>任务模板</summary>
        <TemplateUploadBar onUploadTemplates={onUploadTemplates} />
      </details>
      <Composer
        recipes={recipes}
        historyRuns={history}
        searchFiles={onSearchFiles}
        models={models}
        modelProviders={modelProviders}
        defaultModel={defaultModel}
        defaultProvider={defaultProvider}
        defaultBaseUrl={defaultBaseUrl}
        autoClarify={autoClarify}
        slashCommands={commands}
        onSend={onSend}
        onDraftChange={onDraftChange}
        onRefinePrompt={onRefinePrompt}
        onPickTemplate={onPickTemplate}
      />
    </footer>
  );
}
