// classic-script 文件上传流程:负责浏览器 File 处理与 Host import 调用;app.js 只保留用户事件绑定。
(function () {
    function createFileUploadController({ state, composer, postJson, arrayBufferToBase64, setView, setStatus, setArtifact, refreshWorkspaceTree, appendAssistantMessage, addArtifactCard, renderInteraction, }) {
        async function uploadSelectedFiles(fileList, sourceLabel) {
            const selected = Array.from(fileList || []);
            if (selected.length === 0) {
                return;
            }
            if (!state.hostApi) {
                setArtifact("静态预览模式不能上传文件；请通过 localhost 启动本地 Host。");
                return;
            }
            if (selected.length > 80) {
                setArtifact("一次最多上传 80 个文件。");
                return;
            }
            const totalBytes = selected.reduce((sum, file) => sum + file.size, 0);
            if (totalBytes > 12 * 1024 * 1024) {
                setArtifact("当前 MVP 一次最多导入 12MB 文件；大文件后续走本地授权目录读取。");
                return;
            }
            setView("cowork");
            setStatus("正在导入文件");
            const files = [];
            for (const file of selected) {
                files.push({
                    name: file.name,
                    relativePath: file.webkitRelativePath || file.name,
                    size: file.size,
                    type: file.type,
                    contentBase64: arrayBufferToBase64(await file.arrayBuffer()),
                });
            }
            const imported = await postJson("/api/uploads/import", {
                trustedRoot: state.workspace,
                files,
            });
            state.uploadedFiles = imported.imported.map((file) => ({
                path: file.path.replace(state.workspace, "").replace(/^[\\/]/, "").replace(/\\/g, "/"),
                fullPath: file.path,
                kind: "file",
                size: file.size,
            }));
            await refreshWorkspaceTree();
            const rootLabel = imported.uploadRoot.replace(state.workspace, ".");
            setArtifact(`已${sourceLabel} ${imported.imported.length} 个文件，合计 ${imported.totalBytes} 字节。现在可以直接发送任务让 Kimi 基于摘要生成计划。`, rootLabel);
            const message = appendAssistantMessage(`已${sourceLabel} ${imported.imported.length} 个文件。你现在可以直接发送整理、提取、总结或生成表格任务。`, { status: "协作 · 文件已就绪" });
            addArtifactCard(message, "已授权本地文件", `${imported.imported.length} 个文件，合计 ${imported.totalBytes} 字节`, rootLabel);
            renderInteraction([
                {
                    state: "done",
                    title: "已导入本地文件",
                    detail: `${sourceLabel} ${imported.imported.length} 个文件，合计 ${imported.totalBytes} 字节。`,
                    meta: rootLabel,
                },
                {
                    state: "active",
                    title: "等待用户任务",
                    detail: "下一次发送会优先读取刚导入的文件，并在这里展示 Kimi 的计划过程。",
                },
            ], "文件已就绪");
            setStatus("文件已导入");
            composer.value = composer.value || `读取刚上传的 ${imported.imported.length} 个文件，生成整理计划`;
            composer.focus();
        }
        return { uploadSelectedFiles };
    }
    window.AgentCoworkFileUpload = {
        createFileUploadController,
    };
})();
