import { useCallback, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import { composerFileKey, mergeComposerFiles } from '../lib/composer-files';

export function useComposerTemplates(
  attachments: File[],
  setAttachments: Dispatch<SetStateAction<File[]>>,
  importedTemplateFiles: File[] = [],
  onImportedTemplateFilesConsumed?: () => void,
) {
  const [templateKeys, setTemplateKeys] = useState<Set<string>>(() => new Set());
  const templateFiles = useMemo(
    () => attachments.filter((file) => templateKeys.has(composerFileKey(file))),
    [attachments, templateKeys],
  );
  const isTemplate = (file: File) => templateKeys.has(composerFileKey(file));
  const addTemplateFiles = useCallback((list: FileList | readonly File[] | null) => {
    if (!list?.length) return;
    const files = Array.from(list);
    setAttachments((current) => mergeComposerFiles(current, files));
    setTemplateKeys((current) => new Set([...current, ...files.map(composerFileKey)]));
  }, [setAttachments]);
  useEffect(() => {
    if (!importedTemplateFiles.length) return;
    addTemplateFiles(importedTemplateFiles);
    onImportedTemplateFilesConsumed?.();
  }, [addTemplateFiles, importedTemplateFiles, onImportedTemplateFilesConsumed]);
  const removeAttachment = (index: number) => {
    const target = attachments[index];
    setAttachments((current) => current.filter((_, itemIndex) => itemIndex !== index));
    if (!target) return;
    setTemplateKeys((current) => {
      const next = new Set(current);
      next.delete(composerFileKey(target));
      return next;
    });
  };
  const toggleTemplate = (index: number) => {
    const target = attachments[index];
    if (!target) return;
    const key = composerFileKey(target);
    setTemplateKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };
  return {
    templateFiles,
    isTemplate,
    addTemplateFiles,
    removeAttachment,
    toggleTemplate,
    resetTemplates: () => setTemplateKeys(new Set()),
  };
}
