export type WebViewport = 'desktop' | 'tablet' | 'mobile';

export type WebComponentNode = Readonly<{
  id: string;
  parentId: string | null;
  tag: string;
  label: string;
  depth: number;
  childCount: number;
}>;

export type WebElementSelection = Readonly<{
  id: string;
  tag: string;
  label: string;
  text: string;
  canEditText: boolean;
  color: string;
  backgroundColor: string;
  fontSize: string;
  textAlign: string;
  width: string;
  height: string;
  padding: string;
  margin: string;
  borderRadius: string;
  border: string;
  display: string;
  flexDirection: string;
  justifyContent: string;
  alignItems: string;
  gap: string;
  href: string;
  src: string;
  alt: string;
  target: string;
  className: string;
}>;

export type WebStructureAction = 'duplicate' | 'delete' | 'move-up' | 'move-down';
export type WebInsertPreset = 'heading' | 'text' | 'button' | 'image' | 'section' | 'columns';
export type WebInsertPlacement = 'after' | 'inside';
export type WebSnapshotReason = 'mutation' | 'undo';

export type WebEditorCommand =
  | Readonly<{ id: number; type: 'select'; targetId: string }>
  | Readonly<{ id: number; type: 'update'; patch: Partial<WebElementSelection> }>
  | Readonly<{ id: number; type: 'action'; action: WebStructureAction }>
  | Readonly<{ id: number; type: 'insert'; preset: WebInsertPreset; placement: WebInsertPlacement }>
  | Readonly<{ id: number; type: 'undo' }>;

export type WebEditorCommandInput = WebEditorCommand extends infer Command
  ? Command extends Readonly<{ id: number }>
    ? Omit<Command, 'id'>
    : never
  : never;
