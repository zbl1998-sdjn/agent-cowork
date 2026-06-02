// Classic-script task context helpers. These functions keep prompt routing,
// recipe inference, and safe file-summary reads out of the app.js entrypoint.
(function () {
    function createTaskContext({ state, postJson, selectedRecipe, renderRecipes }) {
        function textCandidate(files) {
            return files.find((file) => /\.(md|txt|csv|docx|xlsx|pptx|pdf)$/i.test(file.path)) || files.find((file) => file.kind === "file");
        }
        function activeFiles() {
            return [...state.mentionedFiles, ...state.uploadedFiles, ...state.files];
        }
        function recipeFiles() {
            const seen = new Set();
            return activeFiles()
                .filter((file) => file.kind === "file")
                .filter((file) => /\.(md|txt|csv|docx|xlsx|pptx|pdf|json|log)$/i.test(file.path))
                .filter((file) => {
                const key = file.fullPath || file.path;
                if (seen.has(key)) {
                    return false;
                }
                seen.add(key);
                return true;
            })
                .slice(0, 6);
        }
        function inferRecipeId(prompt) {
            const text = String(prompt || "").toLowerCase();
            const pairs = [
                ["meeting-actions", /会议|纪要|行动项|待办|todo|meeting/],
                ["excel-cleaning", /表格|清洗|excel|xlsx|csv|数据/],
                ["reimbursement", /报销|发票|费用|invoice|金额/],
                ["contract-summary", /合同|条款|付款|续约|contract/],
                ["feedback-clusters", /反馈|评价|投诉|建议|聚类/],
                ["summary-report", /总结|周报|报告|汇总/],
                ["email-draft", /邮件|email|回复|发送/],
                ["folder-organize", /文件夹|整理|归档|分类/],
            ];
            return pairs.find(([, pattern]) => pattern.test(text))?.[0] || "";
        }
        function maybeSelectRecipe(prompt) {
            if (state.selectedRecipeId && state.selectedRecipeSource !== "auto") {
                return selectedRecipe();
            }
            const inferred = inferRecipeId(prompt);
            if (inferred) {
                state.selectedRecipeId = inferred;
                state.selectedRecipeSource = "auto";
                renderRecipes(state.recipes);
                return selectedRecipe();
            }
            if (state.selectedRecipeSource === "auto") {
                state.selectedRecipeId = "";
                state.selectedRecipeSource = "";
                renderRecipes(state.recipes);
            }
            return null;
        }
        function shouldClarify(prompt) {
            const text = String(prompt || "").trim();
            return !state.selectedRecipeId && text.length > 0 && text.length <= 12 && /整理|处理|看看|弄一下|做一下/.test(text);
        }
        function shouldUseCowork(prompt) {
            const text = String(prompt || "").trim();
            if (state.view === "cowork" || state.view === "code") {
                return true;
            }
            if (state.uploadedFiles.length > 0 || state.selectedRecipeId) {
                return true;
            }
            return /本地|工作区|文件|文件夹|目录|上传|读取|整理|归档|审批|执行|生成|写入|移动|重命名|合同|会议|纪要|行动项|报销|发票|表格|清洗|xlsx|csv|docx|pptx|pdf|代码|项目/i.test(text);
        }
        async function readCandidateSummary(candidate) {
            if (!candidate) {
                return "当前工作区没有可读取的文本文件，先生成一个本地审批产物。";
            }
            try {
                const read = await postJson("/api/files/extract", {
                    trustedRoot: state.workspace,
                    path: candidate.fullPath,
                    maxSize: 1024 * 1024,
                });
                return read.content.replace(/\s+/g, " ").slice(0, 180);
            }
            catch (error) {
                try {
                    const read = await postJson("/api/files/read", {
                        trustedRoot: state.workspace,
                        path: candidate.fullPath,
                        maxSize: 1600,
                    });
                    return read.content.replace(/\s+/g, " ").slice(0, 180);
                }
                catch {
                    return `文件 ${candidate.path} 暂不可直接读取：${error.message}`;
                }
            }
        }
        return {
            textCandidate,
            activeFiles,
            recipeFiles,
            maybeSelectRecipe,
            shouldClarify,
            shouldUseCowork,
            readCandidateSummary,
        };
    }
    window.AgentCoworkTaskContext = {
        createTaskContext,
    };
})();
