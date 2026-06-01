// Classic-script Artifact controller. It keeps host-facing catalog reads behind
// one small factory so app.js can keep shrinking without changing load mode.
(function () {
  function normalizeArtifact(item) {
    if (!item || typeof item !== "object") {
      return { path: "", name: "", kind: "artifact", relativePath: "" };
    }
    return {
      path: typeof item.path === "string" ? item.path : "",
      name: typeof item.name === "string" ? item.name : "",
      kind: typeof item.kind === "string" ? item.kind : "artifact",
      relativePath: typeof item.relativePath === "string" ? item.relativePath : "",
    };
  }

  function createArtifactCatalog({ state, artifactText, artifactPath, artifactList, getJson, basename }) {
    function setArtifact(message, pathText = artifactPath?.textContent || "") {
      if (artifactText) {
        artifactText.textContent = message;
      }
      if (artifactPath) {
        artifactPath.textContent = pathText;
      }
    }

    function openArtifactView(item) {
      const artifact = normalizeArtifact(item);
      if (!state.hostApi || !artifact.path) {
        setArtifact("静态预览模式不能打开 Artifact 活页；请通过 localhost 启动本地 Host。");
        return;
      }
      const url = `/api/artifacts/view?path=${encodeURIComponent(artifact.path)}`;
      window.open(url, "_blank", "noopener,noreferrer");
      setArtifact(`已打开 Artifact 活页：${artifact.name || basename(artifact.path)}`, artifact.relativePath || artifact.path);
    }

    function renderArtifactCatalog(items) {
      if (!artifactList) {
        return;
      }
      artifactList.replaceChildren();
      const artifacts = Array.isArray(items) ? items.map(normalizeArtifact) : [];
      if (artifacts.length === 0) {
        const empty = document.createElement("button");
        empty.type = "button";
        empty.className = "artifact-empty";
        empty.innerHTML = "<strong>暂无活页产物</strong><span>审批执行后，这里会显示可打开的 HTML Artifact。</span>";
        artifactList.append(empty);
        return;
      }
      for (const item of artifacts.slice(0, 12)) {
        const button = document.createElement("button");
        button.type = "button";
        button.dataset.artifactPath = item.path;
        const title = document.createElement("strong");
        title.textContent = item.name || basename(item.path);
        const meta = document.createElement("span");
        meta.textContent = `${item.kind} · ${item.relativePath || item.path}`;
        button.append(title, meta);
        button.addEventListener("click", () => openArtifactView(item));
        artifactList.append(button);
      }
    }

    async function loadArtifactCatalog() {
      if (!state.hostApi || !artifactList) {
        return;
      }
      const payload = await getJson("/api/artifacts?limit=12");
      renderArtifactCatalog(payload && Array.isArray(payload.artifacts) ? payload.artifacts : []);
    }

    return {
      setArtifact,
      renderArtifactCatalog,
      loadArtifactCatalog,
    };
  }

  window.AgentCoworkArtifacts = {
    createArtifactCatalog,
  };
})();
