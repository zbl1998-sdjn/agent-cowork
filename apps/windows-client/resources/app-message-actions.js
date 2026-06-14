// classic-script 消息动作:把审批/澄清控件接到 app.js 注入的编排回调。
(function () {
    function createMessageActions({ state, composer, renderRecipes, hideClarification, generatePlan, approvePlan, setStatus, setArtifact, setView, setMessageStatus, appendUserMessage, scrollConversationToEnd, }) {
        function addClarificationCard(message, prompt, options) {
            if (!message?.body) {
                return;
            }
            const card = document.createElement("div");
            card.className = "clarification-card";
            const header = document.createElement("header");
            const title = document.createElement("strong");
            title.textContent = "需要确认执行方向";
            header.append(title);
            const copy = document.createElement("p");
            copy.className = "message-text";
            copy.textContent = "这条指令比较宽泛，先选一个方向，我再生成可审批的本地操作。";
            const choices = document.createElement("div");
            choices.className = "clarification-options";
            for (const option of options) {
                const button = document.createElement("button");
                button.type = "button";
                const choiceTitle = document.createElement("strong");
                choiceTitle.textContent = option.title;
                const detail = document.createElement("span");
                detail.textContent = option.detail;
                button.append(choiceTitle, detail);
                button.addEventListener("click", () => {
                    choices.querySelectorAll("button").forEach((node) => {
                        node.disabled = true;
                    });
                    state.selectedRecipeId = option.recipeId;
                    state.selectedRecipeSource = "clarify";
                    hideClarification();
                    renderRecipes(state.recipes);
                    composer.value = `${prompt}，按“${option.title}”执行`;
                    appendUserMessage(`我选择：${option.title}`);
                    setMessageStatus(message, "协作 · 已澄清");
                    generatePlan({ appendUser: false }).catch((error) => {
                        setStatus("计划失败");
                        setArtifact(error.message);
                    });
                });
                choices.append(button);
            }
            card.append(header, copy, choices);
            message.body.append(card);
            scrollConversationToEnd();
        }
        function addApprovalActions(message) {
            if (!message?.body) {
                return;
            }
            message.actionsEl?.remove();
            const actions = document.createElement("div");
            actions.className = "approval-actions";
            const approve = document.createElement("button");
            approve.type = "button";
            approve.className = "primary";
            approve.textContent = "审批执行";
            approve.addEventListener("click", () => {
                approvePlan().catch((error) => {
                    setStatus("执行受阻");
                    setArtifact(error.message);
                    setMessageStatus(message, "协作 · 执行受阻");
                });
            });
            const diff = document.createElement("button");
            diff.type = "button";
            diff.textContent = "查看预览";
            diff.addEventListener("click", () => {
                setView("cowork");
                document.querySelector(".operations-card")?.scrollIntoView({ block: "center", behavior: "smooth" });
            });
            const reject = document.createElement("button");
            reject.type = "button";
            reject.textContent = "拒绝";
            reject.addEventListener("click", () => {
                actions.className = "approval-actions is-done";
                actions.textContent = "已拒绝，本次不会写入本机。";
                setMessageStatus(message, "协作 · 已拒绝");
                setStatus("已拒绝");
            });
            actions.append(approve, diff, reject);
            message.actionsEl = actions;
            message.body.append(actions);
            scrollConversationToEnd();
        }
        return {
            addClarificationCard,
            addApprovalActions,
        };
    }
    window.AgentCoworkMessageActions = {
        createMessageActions,
    };
})();
