// classic-script 消息渲染器:负责对话 DOM 写入;app.js 继续只管编排与 host 调用。
(function () {
    function createMessageRenderer({ state, composer, chatOutput, chatOutputText, conversationTimeline, conversationEmpty, messageStatusClass, basename, compactText, }) {
        function showChatResponse(message) {
            chatOutput.hidden = false;
            chatOutputText.textContent = message;
        }
        function syncConversationState() {
            const hasMessages = conversationTimeline?.querySelector(".message-bubble") !== null;
            document.body.classList.toggle("has-conversation", hasMessages);
            if (conversationEmpty) {
                conversationEmpty.classList.toggle("is-hidden", hasMessages);
            }
        }
        function scrollConversationToEnd() {
            syncConversationState();
            requestAnimationFrame(() => {
                const target = conversationTimeline?.lastElementChild || composer;
                target?.scrollIntoView({ block: "end", behavior: "smooth" });
            });
        }
        function setMessageStatus(message, status) {
            if (!message?.statusEl) {
                return;
            }
            message.statusEl.textContent = status;
            message.statusEl.className = `message-status ${messageStatusClass(status)}`.trim();
        }
        function appendMessage(role, text, { status = "", meta = "" } = {}) {
            if (!conversationTimeline) {
                return null;
            }
            const bubble = document.createElement("article");
            bubble.className = `message-bubble is-${role}`;
            const avatar = document.createElement("div");
            avatar.className = "message-avatar";
            avatar.textContent = role === "user" ? "D" : "K";
            const card = document.createElement("div");
            card.className = "message-card";
            const header = document.createElement("div");
            header.className = "message-header";
            const name = document.createElement("strong");
            name.textContent = role === "user" ? "Derrick" : "Kimi";
            const right = document.createElement("span");
            if (status) {
                right.className = `message-status ${messageStatusClass(status)}`.trim();
                right.textContent = status;
            }
            else {
                right.className = "message-meta";
                right.textContent = meta || new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
            }
            header.append(name, right);
            const body = document.createElement("div");
            body.className = "message-body";
            if (text) {
                const paragraph = document.createElement("p");
                paragraph.className = "message-text";
                paragraph.textContent = text;
                body.append(paragraph);
            }
            card.append(header, body);
            bubble.append(avatar, card);
            conversationTimeline.append(bubble);
            const message = { bubble, card, body, statusEl: status ? right : null };
            scrollConversationToEnd();
            return message;
        }
        function appendUserMessage(text) {
            return appendMessage("user", text);
        }
        function appendAssistantMessage(text, options = {}) {
            return appendMessage("assistant", text, options);
        }
        function appendMessageText(message, text) {
            if (!message?.body || !text) {
                return;
            }
            const paragraph = document.createElement("p");
            paragraph.className = "message-text";
            paragraph.textContent = text;
            message.body.append(paragraph);
            scrollConversationToEnd();
        }
        function addProgressLines(message, items) {
            if (!message?.body || !Array.isArray(items) || items.length === 0) {
                return;
            }
            const list = document.createElement("div");
            list.className = "message-progress";
            for (const item of items) {
                const row = document.createElement("div");
                row.className = `progress-line is-${item.state || "wait"}`;
                row.textContent = item.meta ? `${item.title} · ${item.meta}` : item.title;
                list.append(row);
            }
            message.body.append(list);
            scrollConversationToEnd();
        }
        function addPreviewCard(message, operations, summary = "等待审批") {
            if (!message?.body) {
                return;
            }
            const card = document.createElement("div");
            card.className = "inline-preview";
            const header = document.createElement("header");
            const title = document.createElement("strong");
            title.textContent = "操作预览";
            const badge = document.createElement("em");
            badge.textContent = summary;
            header.append(title, badge);
            card.append(header);
            for (const item of (operations || []).slice(0, 4)) {
                const row = document.createElement("div");
                row.className = "inline-op";
                const type = document.createElement("span");
                type.textContent = item.type;
                type.classList.toggle("is-write", item.type === "write");
                const detail = document.createElement("p");
                detail.textContent = (item.targetPath || item.path || "").replace(state.workspace, ".") || "待执行操作";
                row.append(type, detail);
                card.append(row);
            }
            if ((operations || []).length > 4) {
                const more = document.createElement("p");
                more.textContent = `另有 ${(operations || []).length - 4} 个操作会在审批后执行。`;
                card.append(more);
            }
            message.body.append(card);
            scrollConversationToEnd();
        }
        function markApprovalDone(message) {
            if (!message?.actionsEl) {
                return;
            }
            message.actionsEl.className = "approval-actions is-done";
            message.actionsEl.textContent = `已审批 · ${new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`;
        }
        function addArtifactCard(message, title, description, pathText) {
            if (!message?.body) {
                return;
            }
            const card = document.createElement("div");
            card.className = "inline-artifact";
            const header = document.createElement("header");
            const strong = document.createElement("strong");
            strong.textContent = title;
            const meta = document.createElement("em");
            meta.textContent = "本地产物";
            header.append(strong, meta);
            const copy = document.createElement("p");
            copy.textContent = description;
            const pathLine = document.createElement("p");
            pathLine.textContent = pathText || ".AgentCowork/artifacts";
            card.append(header, copy, pathLine);
            message.body.append(card);
            scrollConversationToEnd();
        }
        function addSourcesFooter(message, sources) {
            if (!message?.body || !Array.isArray(sources) || sources.length === 0) {
                return;
            }
            const card = document.createElement("div");
            card.className = "inline-sources";
            const header = document.createElement("header");
            const strong = document.createElement("strong");
            strong.textContent = `来源 (${sources.length})`;
            const meta = document.createElement("em");
            meta.textContent = "可信工作区";
            header.append(strong, meta);
            card.append(header);
            for (const source of sources.slice(0, 4)) {
                const row = document.createElement("p");
                const label = source.relativePath || basename(source.path);
                row.textContent = source.excerpt ? `${label}: ${compactText(source.excerpt, 110)}` : label;
                card.append(row);
            }
            message.body.append(card);
            scrollConversationToEnd();
        }
        function clearConversation() {
            conversationTimeline?.querySelectorAll(".message-bubble").forEach((node) => node.remove());
            state.activeTaskMessage = null;
            syncConversationState();
        }
        return {
            showChatResponse,
            syncConversationState,
            scrollConversationToEnd,
            setMessageStatus,
            appendMessage,
            appendUserMessage,
            appendAssistantMessage,
            appendMessageText,
            addProgressLines,
            addPreviewCard,
            markApprovalDone,
            addArtifactCard,
            addSourcesFooter,
            clearConversation,
        };
    }
    window.AgentCoworkMessageRenderer = {
        createMessageRenderer,
    };
})();
