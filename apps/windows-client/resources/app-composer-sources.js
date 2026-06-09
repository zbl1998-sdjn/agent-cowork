// classic-script 输入框弹窗数据源:把搜索与候选映射逻辑从弹窗 UI 控制器中拆出。
(function () {
    function createComposerSources({ state, searchLocalFiles, getJson, compactText, runStatusText, runTypeText, shortRunId, }) {
        function templateItems(query) {
            const q = String(query || "").toLowerCase();
            return state.recipes
                .filter((recipe) => !q || `${recipe.name} ${recipe.id} ${recipe.summary || ""}`.toLowerCase().includes(q))
                .slice(0, 6)
                .map((recipe) => ({ kind: "template", id: recipe.id, title: recipe.name, detail: recipe.summary || recipe.id, recipe }));
        }
        async function mentionItems(query) {
            const results = await searchLocalFiles(query);
            return results.slice(0, 8).map((file) => ({
                kind: "mention",
                title: file.path,
                detail: file.excerpt ? compactText(file.excerpt, 60) : (file.extension || "file"),
                file: { path: file.path, fullPath: file.fullPath, kind: "file", size: file.size },
            }));
        }
        async function historyRunItems(query) {
            if (!state.hostApi) {
                return [];
            }
            const payload = await getJson("/api/runs/index?limit=20");
            const q = String(query || "").toLowerCase();
            return (payload.runs || [])
                .filter((run) => {
                if (!q) {
                    return true;
                }
                return [
                    run.id,
                    run.promptPreview,
                    run.recipeId,
                    run.status,
                    run.type,
                    run.mode,
                ].filter(Boolean).join(" ").toLowerCase().includes(q);
            })
                .slice(0, 8)
                .map((run) => ({
                kind: "history",
                id: run.id,
                title: `${runTypeText(run)} · ${runStatusText(run.status)} · ${shortRunId(run.id)}`,
                detail: compactText(run.promptPreview || run.recipeId || run.type || "历史任务", 80),
                run,
            }));
        }
        return {
            templateItems,
            mentionItems,
            historyRunItems,
        };
    }
    window.AgentCoworkComposerSources = {
        createComposerSources,
    };
})();
