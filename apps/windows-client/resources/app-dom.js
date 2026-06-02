// DOM lookup is intentionally centralized: selector drift should fail at boot.
(function () {
    function requiredElement(selector) {
        const element = document.querySelector(selector);
        if (!element) {
            throw new Error(`Missing required UI element: ${selector}`);
        }
        return element;
    }
    function collectAppDom() {
        return {
            composer: requiredElement(".composer textarea"),
            composerPopover: requiredElement(".composer-popover"),
            uploadInput: requiredElement(".upload-input"),
            folderInput: requiredElement(".folder-input"),
            approveButton: requiredElement(".approve-button"),
            sendButton: requiredElement(".send-button"),
            artifactText: requiredElement(".artifact-preview p"),
            artifactPath: requiredElement(".artifact-preview code"),
            statusText: requiredElement(".status-text"),
            runChip: requiredElement(".run-chip"),
            runSummary: requiredElement(".run-summary"),
            runList: requiredElement(".run-list"),
            runRefreshButton: requiredElement('[data-action="refresh-runs"]'),
            artifactList: requiredElement("[data-artifact-list]"),
            artifactRefreshButton: requiredElement('[data-action="refresh-artifacts"]'),
            workspacePath: requiredElement(".workspace-card > strong"),
            workspaceMeta: requiredElement(".workspace-card > p"),
            fileList: requiredElement(".file-list"),
            operationList: requiredElement(".operation-list"),
            chatOutput: requiredElement(".chat-output"),
            chatOutputText: requiredElement(".chat-output p"),
            conversationTimeline: requiredElement(".conversation-timeline"),
            conversationEmpty: requiredElement(".conversation-empty"),
            workbenchTitle: requiredElement(".workbench-title"),
            workbenchCopy: requiredElement(".workbench-copy"),
            interactionSubtitle: requiredElement(".interaction-subtitle"),
            interactionItems: requiredElement(".interaction-items"),
            recipeSummary: requiredElement(".recipe-summary"),
            recipeList: requiredElement(".recipe-list"),
            recipeClearButton: requiredElement('[data-action="clear-recipe"]'),
            clarifyPanel: requiredElement(".clarify-panel"),
            clarifyOptions: requiredElement(".clarify-options"),
        };
    }
    window.AgentCoworkAppDom = {
        collectAppDom,
    };
})();
