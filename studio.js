const studioElements = {
  apiKey: document.getElementById("api-key"),
  model: document.getElementById("model"),
  defaultPrompt: document.getElementById("default-prompt"),
  remixPrompt: document.getElementById("remix-prompt"),
  tabState: document.getElementById("tab-state"),
  status: document.getElementById("studio-status"),
  heroModel: document.getElementById("hero-model"),
  heroNetworkCount: document.getElementById("hero-network-count")
};

let stateRefreshInterval = null;

bootstrapStudio().catch((error) => {
  setStudioStatus(error.message);
});

async function bootstrapStudio() {
  const settings = await Web40UI.sendMessage("web40:getSettings");
  applySettings(settings);
  await refreshStudioState();
  attachStudioActions();
  initializeMotion();
  stateRefreshInterval = window.setInterval(refreshStudioState, 10000);
}

function attachStudioActions() {
  document.addEventListener("click", async (event) => {
    const action = event.target?.dataset?.studioAction;
    if (!action) {
      return;
    }

    try {
      if (action === "save") {
        await saveStudioSettings();
        setStudioStatus("Settings saved locally in Chrome.");
        return;
      }

      if (action === "analyze") {
        await saveStudioSettings();
        setStudioStatus("Streaming a direct replacement into the active tab...");
        const result = await Web40UI.sendMessage("web40:analyzeActiveTab");
        renderStudioState(result);
        setStudioStatus("Replaced the active page with a generated live runtime.");
        return;
      }

      if (action === "remix") {
        await saveStudioSettings();
        setStudioStatus("Running the remix prompt...");
        const result = await Web40UI.sendMessage("web40:remixActiveTab");
        renderStudioState(result);
        setStudioStatus("Applied a new remix to the active page.");
        return;
      }

      if (action === "toggle" || action === "open-overlay") {
        const result = await Web40UI.sendMessage("web40:toggleOverlay");
        setStudioStatus(result.visible ? "Dock shown on the active tab." : "Dock hidden.");
      }
    } catch (error) {
      setStudioStatus(error.message);
    }
  });
}

function applySettings(settings) {
  studioElements.apiKey.value = settings.apiKey || "";
  studioElements.model.value = settings.model || "";
  studioElements.defaultPrompt.value = settings.defaultPrompt || "";
  studioElements.remixPrompt.value = settings.remixPrompt || "";
  studioElements.heroModel.textContent = settings.model || "openai/gpt-5.5";
}

async function saveStudioSettings() {
  const next = {
    apiKey: studioElements.apiKey.value,
    model: studioElements.model.value,
    defaultPrompt: studioElements.defaultPrompt.value,
    remixPrompt: studioElements.remixPrompt.value
  };

  const saved = await Web40UI.sendMessage("web40:saveSettings", { settings: next });
  applySettings(saved);
}

async function refreshStudioState() {
  try {
    const tabState = await Web40UI.sendMessage("web40:getActiveTabState");
    renderStudioState(tabState);
  } catch (error) {
    studioElements.tabState.innerHTML = `<div>${Web40UI.escapeHtml(error.message)}</div>`;
  }
}

function renderStudioState(state) {
  studioElements.heroNetworkCount.textContent = String(state.networkCount || 0);
  studioElements.tabState.innerHTML = `
    <div><strong>Status:</strong> ${Web40UI.escapeHtml(state.status || "idle")}</div>
    <div><strong>Page:</strong> ${Web40UI.escapeHtml(Web40UI.clipText(state.title || state.url || "Current tab", 120))}</div>
    <div><strong>Captured requests:</strong> ${Number(state.networkCount || 0)}</div>
    <div><strong>API groups:</strong> ${Number(state.apiCount || 0)}</div>
    <div><strong>Last update:</strong> ${Web40UI.escapeHtml(Web40UI.formatTimestamp(state.updatedAt))}</div>
    ${
      state.artifactSummary
        ? `<div><strong>Generated UI:</strong> ${Web40UI.escapeHtml(state.artifactSummary.uiTitle || "Untitled runtime")}</div>
           <div>${Web40UI.escapeHtml(state.artifactSummary.summary || "")}</div>`
        : "<div>No remix has been generated for this tab yet.</div>"
    }
    ${state.lastError ? `<div><strong>Error:</strong> ${Web40UI.escapeHtml(state.lastError)}</div>` : ""}
  `;
}

function initializeMotion() {
  if (!window.gsap || !window.ScrollTrigger) {
    return;
  }

  gsap.registerPlugin(ScrollTrigger);

  document.querySelectorAll('[data-reveal="words"]').forEach((node) => {
    splitIntoWords(node);
    const words = node.querySelectorAll(".reveal-word");
    gsap.fromTo(
      words,
      { opacity: 0.1 },
      {
        opacity: 1,
        stagger: 0.08,
        ease: "none",
        scrollTrigger: {
          trigger: node,
          start: "top 82%",
          end: "bottom 35%",
          scrub: true
        }
      }
    );
  });

  document.querySelectorAll(".media-card").forEach((card) => {
    gsap.fromTo(
      card,
      {
        scale: 0.82,
        opacity: 0.35,
        filter: "brightness(0.58)"
      },
      {
        scale: 1,
        opacity: 1,
        filter: "brightness(1)",
        ease: "none",
        scrollTrigger: {
          trigger: card,
          start: "top 92%",
          end: "bottom 18%",
          scrub: true
        }
      }
    );
  });
}

function splitIntoWords(node) {
  if (node.dataset.wordsSplit === "true") {
    return;
  }

  const text = node.textContent || "";
  const words = text.trim().split(/\s+/).filter(Boolean);
  node.innerHTML = words
    .map((word) => `<span class="reveal-word">${Web40UI.escapeHtml(word)}</span>`)
    .join(" ");
  node.dataset.wordsSplit = "true";
}

function setStudioStatus(message) {
  studioElements.status.textContent = message || "";
}
