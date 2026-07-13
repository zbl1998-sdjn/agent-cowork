// Office/Web 可视化编辑协议(host · L1 领域层 · artifacts)
// ---------------------------------------------------------------------------
// 职责:定义跨 DOCX/XLSX/PPTX/HTML 的统一可选择节点、分区、会话和修改协议。
export type EditableArtifactKind = 'docx' | 'xlsx' | 'pptx' | 'html';

export type EditableArtifactNode = Readonly<{
  id: string;
  type: 'paragraph' | 'cell' | 'shape';
  text: string;
  address?: string;
  readOnly?: boolean;
}>;

export type EditableArtifactSection = Readonly<{
  id: string;
  label: string;
  nodes: EditableArtifactNode[];
}>;

export type EditableArtifactSession = Readonly<{
  kind: EditableArtifactKind;
  name: string;
  revisionSha256: string;
  sections: EditableArtifactSection[];
  htmlSource?: string;
}>;

export type EditableArtifactChange = Readonly<{
  targetId: string;
  text: string;
}>;
