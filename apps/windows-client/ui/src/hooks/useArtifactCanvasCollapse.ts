// useArtifactCanvasCollapse(UI · hooks 层)
// ---------------------------------------------------------------------------
// 职责:成果画布的收起/展开状态——默认收起,新成果出现时自动展开一次,
//       之后尊重用户手动收起,不再强行弹开。
import { useState } from 'react';

export function useArtifactCanvasCollapse(artifactMessageId: string | null): [boolean, (collapsed: boolean) => void] {
  const [collapsed, setCollapsed] = useState(true);
  const [autoOpenedFor, setAutoOpenedFor] = useState<string | null>(null);
  if (artifactMessageId && artifactMessageId !== autoOpenedFor) {
    setAutoOpenedFor(artifactMessageId);
    setCollapsed(false);
  }
  return [collapsed, setCollapsed];
}
