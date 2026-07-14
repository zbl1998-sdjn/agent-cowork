// 底部输入区停靠层(UI · 组件层 · components)
// ---------------------------------------------------------------------------
// 职责:把 Composer(输入框)连同停止生成条、统一模板导入和已选模板提示固定在底部,转发 App 传入的发送/精炼/搜文件等回调。
// 依赖:Composer 及其类型、Button。同文件导出 AppComposerDockStatus(停止/模板状态条)。
import { useRef, useState } from 'react';
import type { Command } from './CommandPalette';
import { Composer, type ComposerDraftPreview, type ComposerMeta, type FileHit, type HistoryRun, type Recipe } from './Composer';
import { Button } from './ui/Button';
import type { PromptRefineResult } from '../lib/api/prompt';
import type { ModelProviderOption } from '../lib/api/agentEngine';
import { Icon } from './ui/Icon';
import { useTemplateImportMenu } from '../hooks/useTemplateImportMenu';

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

interface TemplateUploadBarProps {
  onUploadTemplates: (files: File[]) => Promise<Recipe[]>;
  onUploadLayoutTemplates: (files: File[]) => void;
}

export function TemplateUploadBar({ onUploadTemplates, onUploadLayoutTemplates }: TemplateUploadBarProps) {
  const taskInputRef = useRef<HTMLInputElement | null>(null);
  const layoutInputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState<'task' | 'layout' | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const menu = useTemplateImportMenu(2);

  const handleTaskFiles = async (fileList: FileList | null) => {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    setBusy('task');
    setMessage('');
    setError('');
    try {
      const imported = await onUploadTemplates(files);
      setMessage(`已导入 ${imported.length} 个任务流程模板`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
      if (taskInputRef.current) taskInputRef.current.value = '';
    }
  };

  const handleLayoutFiles = (fileList: FileList | null) => {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    setBusy('layout');
    setMessage('');
    setError('');
    try {
      onUploadLayoutTemplates(files);
      setMessage(`已添加 ${files.length} 个版式模板，发送后将严格保留原结构与样式`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
      if (layoutInputRef.current) layoutInputRef.current.value = '';
    }
  };

  const openPicker = (kind: 'task' | 'layout') => {
    menu.closeMenu(false);
    if (kind === 'task') taskInputRef.current?.click();
    else layoutInputRef.current?.click();
  };

  return (
    <div className="template-upload-bar" ref={menu.rootRef}>
      <Button
        className="template-upload-button"
        disabled={busy !== null}
        aria-haspopup="menu"
        aria-expanded={menu.menuOpen}
        aria-controls="template-import-menu"
        onKeyDown={menu.onTriggerKeyDown}
        onClick={() => { if (menu.menuOpen) menu.closeMenu(false); else menu.openMenu(0); }}
      >
        {busy ? '导入中…' : '导入模板'}
        <Icon name="chevron-down" size={14} />
      </Button>
      <div id="template-import-menu" ref={menu.menuRef} className="template-import-menu" role="menu" aria-label="选择模板类型" hidden={!menu.menuOpen} onKeyDown={menu.onMenuKeyDown}>
        <Button role="menuitem" tabIndex={-1} className="template-import-option" onClick={() => openPicker('task')}>
          <Icon name="template" size={18} />
          <span><strong>任务流程模板</strong><small>导入别人分享的任务步骤，可一次选多个</small></span>
        </Button>
        <Button role="menuitem" tabIndex={-1} className="template-import-option" onClick={() => openPicker('layout')}>
          <Icon name="artifacts" size={18} />
          <span><strong>Office / 网页版式</strong><small>上传现有文件，让 Agent 保留结构与样式</small></span>
        </Button>
      </div>
      <span className={`template-upload-status${error ? ' is-error' : ''}`} aria-live="polite">
        {error || message || '可导入任务步骤，也可上传 Word / Excel / PPT / 网页模板'}
      </span>
      <input
        ref={taskInputRef}
        className="template-upload-input"
        type="file"
        accept=".json,application/json"
        multiple
        hidden
        aria-label="上传任务模板文件"
        onChange={(event) => void handleTaskFiles(event.currentTarget.files)}
      />
      <input
        ref={layoutInputRef}
        className="template-upload-input"
        type="file"
        accept=".docx,.xlsx,.pptx,.html,.htm"
        multiple
        hidden
        aria-label="上传版式模板文件"
        onChange={(event) => handleLayoutFiles(event.currentTarget.files)}
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
  const [importedTemplateFiles, setImportedTemplateFiles] = useState<File[]>([]);

  return (
    <footer className="composer-dock">
      <AppComposerDockStatus selectedRecipe={selectedRecipe} streamingId={streamingId} onClearRecipe={onClearRecipe} onStopStreaming={onStopStreaming} />
      <TemplateUploadBar onUploadTemplates={onUploadTemplates} onUploadLayoutTemplates={setImportedTemplateFiles} />
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
        importedTemplateFiles={importedTemplateFiles}
        onImportedTemplateFilesConsumed={() => setImportedTemplateFiles([])}
      />
    </footer>
  );
}
