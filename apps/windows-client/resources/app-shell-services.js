// Shared service construction keeps app.js as the composition root, not a factory pile.
(function () {
    function createShellServices({ state, elements, placeholders, utils, api }) {
        const artifactCatalog = window.AgentCoworkArtifacts.createArtifactCatalog({
            state,
            artifactText: elements.artifactText,
            artifactPath: elements.artifactPath,
            artifactList: elements.artifactList,
            getJson: api.getJson,
            basename: utils.basename,
        });
        const workbench = window.AgentCoworkWorkbenchRenderer.createWorkbenchRenderer({
            state,
            composer: elements.composer,
            placeholders,
            statusText: elements.statusText,
            runChip: elements.runChip,
            workbenchTitle: elements.workbenchTitle,
            workbenchCopy: elements.workbenchCopy,
            interactionSubtitle: elements.interactionSubtitle,
            interactionItems: elements.interactionItems,
            workspaceMeta: elements.workspaceMeta,
            fileList: elements.fileList,
            operationList: elements.operationList,
            recipeSummary: elements.recipeSummary,
            recipeList: elements.recipeList,
            basename: utils.basename,
            setArtifact: artifactCatalog.setArtifact,
            loadArtifactCatalog: artifactCatalog.loadArtifactCatalog,
        });
        const taskContext = window.AgentCoworkTaskContext.createTaskContext({
            state,
            postJson: api.postJson,
            basename: utils.basename,
            selectedRecipe: workbench.selectedRecipe,
            renderRecipes: workbench.renderRecipes,
        });
        const kimiRunner = window.AgentCoworkKimiRunner.createKimiRunner({
            state,
            postJson: api.postJson,
            setRunChip: workbench.setRunChip,
            setStatus: workbench.setStatus,
            shortRunId: utils.shortRunId,
        });
        const messageRenderer = window.AgentCoworkMessageRenderer.createMessageRenderer({
            state,
            composer: elements.composer,
            chatOutput: elements.chatOutput,
            chatOutputText: elements.chatOutputText,
            conversationTimeline: elements.conversationTimeline,
            conversationEmpty: elements.conversationEmpty,
            messageStatusClass: utils.messageStatusClass,
            basename: utils.basename,
            compactText: utils.compactText,
        });
        return {
            ...artifactCatalog,
            ...workbench,
            ...taskContext,
            ...kimiRunner,
            ...messageRenderer,
        };
    }
    window.AgentCoworkShellServices = {
        createShellServices,
    };
})();
