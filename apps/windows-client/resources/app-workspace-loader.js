// 工作区加载器负责 Host API 读取;具体渲染仍通过回调注入。
(function () {
    function createWorkspaceLoader({ state, getJson, postJson, renderRecipes, summarizeFiles, renderFiles, setStatus, setArtifact, setRunChip, workspacePath, refreshRunCards, loadArtifactCatalog, }) {
        async function loadRecipes() {
            if (!state.hostApi) {
                renderRecipes([]);
                return;
            }
            const payload = await getJson("/api/recipes");
            renderRecipes(payload.recipes || []);
        }
        async function searchLocalFiles(query) {
            if (!state.hostApi || !query.trim()) {
                return [];
            }
            const payload = await postJson("/api/files/search", {
                trustedRoot: state.workspace,
                query,
                includeContent: true,
                maxResults: 8,
            });
            return payload.results || [];
        }
        async function refreshWorkspaceTree() {
            const tree = await postJson("/api/files/tree", { root: state.workspace });
            state.files = tree.files;
            summarizeFiles(tree.files);
            renderFiles(tree.files);
        }
        async function loadHostWorkspace() {
            if (!state.hostApi) {
                setStatus("静态预览");
                return;
            }
            try {
                const workspace = await getJson("/api/workspace");
                state.workspace = workspace.trustedRoot;
                state.modelApiEnabled = workspace.modelApi?.planEnabled === true || workspace.modelApi?.chatEnabled === true;
                setRunChip(state.modelApiEnabled ? "模型 API 已接入" : "模型 API 未配置", state.modelApiEnabled ? "ready" : "muted");
                workspacePath.textContent = state.workspace;
                await refreshWorkspaceTree();
                await loadRecipes();
                await refreshRunCards();
                await loadArtifactCatalog();
                setStatus("本地 Agent 就绪");
            }
            catch (error) {
                setStatus("Host API 离线");
                setArtifact(`无法连接本地 Host API：${error.message}`);
            }
        }
        return {
            loadRecipes,
            searchLocalFiles,
            refreshWorkspaceTree,
            loadHostWorkspace,
        };
    }
    window.AgentCoworkWorkspaceLoader = {
        createWorkspaceLoader,
    };
})();
