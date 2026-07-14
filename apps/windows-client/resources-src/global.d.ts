// legacy classic-script 资源包的共享全局类型面。
// 本目录编译为全局浏览器脚本,在资源路径退役前跨文件契约有意挂在 window 上。
type AgentCoworkJson = Record<string, any>;

interface Error {
  payload?: AgentCoworkJson;
  status?: number;
}

interface Window {
  __KCW_HOST_BASE__?: string;
  __KCW_TOKEN__?: string;
  __TAURI__?: {
    core?: {
      invoke?: (command: string, args?: unknown) => Promise<unknown>;
    };
  };
  agentCowork?: AgentCoworkJson;
  scrollConversationToEnd?: () => void;
  AgentCoworkApi?: AgentCoworkJson;
  AgentCoworkApprovalRunner?: AgentCoworkJson;
  AgentCoworkAppDom?: AgentCoworkJson;
  AgentCoworkAppEvents?: AgentCoworkJson;
  AgentCoworkAppState?: AgentCoworkJson;
  AgentCoworkArtifacts?: AgentCoworkJson;
  AgentCoworkChatRunner?: AgentCoworkJson;
  AgentCoworkClarification?: AgentCoworkJson;
  AgentCoworkComposerPopover?: AgentCoworkJson;
  AgentCoworkComposerSources?: AgentCoworkJson;
  AgentCoworkControllerAssembly?: AgentCoworkJson;
  AgentCoworkFileUpload?: AgentCoworkJson;
  AgentCoworkAgentEngineRunner?: AgentCoworkJson;
  AgentCoworkMessageActions?: AgentCoworkJson;
  AgentCoworkMessageRenderer?: AgentCoworkJson;
  AgentCoworkPlanPreview?: AgentCoworkJson;
  AgentCoworkPlanRunner?: AgentCoworkJson;
  AgentCoworkRecipeRunner?: AgentCoworkJson;
  AgentCoworkRunEvents?: AgentCoworkJson;
  AgentCoworkRunHistory?: AgentCoworkJson;
  AgentCoworkShellServices?: AgentCoworkJson;
  AgentCoworkTaskContext?: AgentCoworkJson;
  AgentCoworkUtils?: AgentCoworkJson;
  AgentCoworkWorkbenchRenderer?: AgentCoworkJson;
  AgentCoworkWorkspaceLoader?: AgentCoworkJson;
}
