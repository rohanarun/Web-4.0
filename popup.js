const popupElements = {
  apiKey: document.getElementById("api-key"),
  model: document.getElementById("model"),
  defaultPrompt: document.getElementById("default-prompt"),
  remixPrompt: document.getElementById("remix-prompt"),
  save: document.getElementById("save-settings"),
  analyze: document.getElementById("analyze-tab"),
  remix: document.getElementById("remix-tab"),
  toggle: document.getElementById("toggle-overlay"),
  openStudio: document.getElementById("open-studio"),
  refresh: document.getElementById("refresh-state"),
  tabState: document.getElementById("tab-state"),
  status: document.getElementById("status-line")
};

bootstrapPopup().catch((error) => {
  setStatus(error.message);
});

async function bootstrapPopup() {
  const settings = await Web40UI.sendMessage("web40:getSettings");
  applySettings(settings);
  await refreshTabState();

  popupElements.save.addEventListener("click", async () => {
    try {
      await saveSettings("Settings saved locally in Chrome.");
    } catch (error) {
      setStatus(error.message);
    }
  });

  popupElements.analyze.addEventListener("click", async () => {
    try {
      await saveSettings();
      await runAction("Analyzing current tab...", "web40:analyzeActiveTab");
    } catch (error) {
      setStatus(error.message);
    }
  });

  popupElements.remix.addEventListener("click", async () => {
    try {
      await saveSettings();
      await runAction("Running remix prompt...", "web40:remixActiveTab");
    } catch (error) {
      setStatus(error.message);
    }
  });

  popupElements.toggle.addEventListener("click", async () => {
    try {
      const result = await Web40UI.sendMessage("web40:toggleOverlay");
      setStatus(result.visible ? "Dock shown." : "Dock hidden.");
    } catch (error) {
      setStatus(error.message);
    }
  });

  popupElements.openStudio.addEventListener("click", async () => {
    try {
      await Web40UI.sendMessage("web40:openStudio");
    } catch (error) {
      setStatus(error.message);
    }
  });

  popupElements.refresh.addEventListener("click", refreshTabState);
}

function applySettings(settings) {
  popupElements.apiKey.value = settings.apiKey || "";
  popupElements.model.value = settings.model || "";
  popupElements.defaultPrompt.value = settings.defaultPrompt || "";
  popupElements.remixPrompt.value = settings.remixPrompt || "";
}

async function saveSettings(successMessage) {
  const next = {
    apiKey: popupElements.apiKey.value,
    model: popupElements.model.value,
    defaultPrompt: popupElements.defaultPrompt.value,
    remixPrompt: popupElements.remixPrompt.value
  };

  await Web40UI.sendMessage("web40:saveSettings", { settings: next });
  if (successMessage) {
    setStatus(successMessage);
  }
}

async function runAction(startMessage, type) {
  setStatus(startMessage);
  const result = await Web40UI.sendMessage(type);
  renderTabState(result);
  setStatus(result.status === "ready" ? "Completed." : `Finished with status: ${result.status}`);
}

async function refreshTabState() {
  try {
    const state = await Web40UI.sendMessage("web40:getActiveTabState");
    renderTabState(state);
  } catch (error) {
    popupElements.tabState.innerHTML = `<div>${Web40UI.escapeHtml(error.message)}</div>`;
  }
}

function renderTabState(state) {
  const summary = state.artifactSummary
    ? `<div><strong>Generated UI:</strong> ${Web40UI.escapeHtml(state.artifactSummary.uiTitle || "Untitled remix")}</div>
       <div>${Web40UI.escapeHtml(state.artifactSummary.summary || "")}</div>`
    : `<div>No generated runtime yet.</div>`;

  popupElements.tabState.innerHTML = `
    <div><strong>Status:</strong> ${Web40UI.escapeHtml(state.status || "idle")}</div>
    <div><strong>Page:</strong> ${Web40UI.escapeHtml(Web40UI.clipText(state.title || state.url || "Current tab", 90))}</div>
    <div><strong>Captured requests:</strong> ${Number(state.networkCount || 0)}</div>
    <div><strong>API groups:</strong> ${Number(state.apiCount || 0)}</div>
    <div><strong>Last update:</strong> ${Web40UI.escapeHtml(Web40UI.formatTimestamp(state.updatedAt))}</div>
    ${summary}
    ${state.lastError ? `<div><strong>Error:</strong> ${Web40UI.escapeHtml(state.lastError)}</div>` : ""}
  `;
}

function setStatus(message) {
  popupElements.status.textContent = message || "";
}
