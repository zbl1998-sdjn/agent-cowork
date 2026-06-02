// Shared ambient surface for the legacy classic-script resource bundle.
// The files in this folder compile to global browser scripts, so cross-file
// contracts intentionally live on window until this resource path is retired.
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
  AgentCoworkKimiRunner?: AgentCoworkJson;
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
