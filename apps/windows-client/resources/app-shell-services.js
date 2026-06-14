// 资源版 UI 的共享服务工厂(resources · 组合边界)
// ---------------------------------------------------------------------------
// 职责:把 artifact、工作台渲染、任务上下文、Kimi 调用和消息渲染这些横切能力
//   合成为一个 services 对象。app.ts 仍保持真正的 composition root,本文件只负责
//   构造可复用服务,不绑定 DOM 事件、不发起启动流程。
(function () {
    function createShellServices({ state, elements, placeholders, utils, api }) {
        // artifact 目录是文件产物的单一读入口,后续工作台和上传流程都复用它。
        const artifactCatalog = window.AgentCoworkArtifacts.createArtifactCatalog({
            state,
            artifactText: elements.artifactText,
            artifactPath: elements.artifactPath,
            artifactList: elements.artifactList,
            getJson: api.getJson,
            basename: utils.basename,
        });
        // workbench 集中处理首屏状态、文件列表、操作列表、配方和 artifact 的展示。
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
        // taskContext 负责从当前 UI 状态提炼任务上下文,供计划/配方运行时复用。
        const taskContext = window.AgentCoworkTaskContext.createTaskContext({
            state,
            postJson: api.postJson,
            basename: utils.basename,
            selectedRecipe: workbench.selectedRecipe,
            renderRecipes: workbench.renderRecipes,
        });
        // kimiRunner 封装直接模型调用,这里只注入 UI 状态更新函数,避免反向依赖渲染模块。
        const kimiRunner = window.AgentCoworkKimiRunner.createKimiRunner({
            state,
            postJson: api.postJson,
            setRunChip: workbench.setRunChip,
            setStatus: workbench.setStatus,
            shortRunId: utils.shortRunId,
        });
        // messageRenderer 统一生成对话时间线节点,让聊天、计划和配方路径保持同一视觉语义。
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
        // 展开顺序也表达依赖优先级:底层目录/工作台能力在前,上层运行与消息能力在后。
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
