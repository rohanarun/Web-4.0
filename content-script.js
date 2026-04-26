(function web40ContentScript() {
  if (window.__WEB40_CONTENT_SCRIPT__) {
    return;
  }

  window.__WEB40_CONTENT_SCRIPT__ = true;

  const state = {
    sourceSnapshot: null,
    artifact: null,
    originalArtifact: null,
    networkEntries: [],
    generatedViewActive: false,
    dockVisible: true,
    originalBodyFragment: null,
    originalTitle: "",
    generatedStyleEl: null,
    generatedScriptEl: null,
    lastAppliedHtml: "",
    lastAppliedCss: "",
    elements: {
      root: null,
      panel: null,
      apiList: null,
      summary: null,
      status: null,
      htmlField: null,
      cssField: null,
      jsField: null,
      title: null,
      bindings: null
    }
  };

  injectPageBridge();
  window.addEventListener("message", handleWindowMessage, false);

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const handler = MESSAGE_HANDLERS[message?.type];
    if (!handler) {
      return false;
    }

    (async () => {
      try {
        const result = await handler(message);
        sendResponse(result);
      } catch (error) {
        sendResponse({
          error: error instanceof Error ? error.message : String(error)
        });
      }
    })();

    return true;
  });

  const MESSAGE_HANDLERS = {
    "web40:ping": async () => ({ ready: true }),
    "web40:collectSnapshot": async () => {
      const snapshot = getSourceSnapshot();
      if (!state.generatedViewActive) {
        state.sourceSnapshot = snapshot;
      }
      return snapshot;
    },
    "web40:streamRenderStart": async (message) => {
      state.sourceSnapshot = message.snapshot || getSourceSnapshot();
      await ensureBodyAvailable();
      await stashOriginalPage();
      ensureDock();
      showDock(true);
      renderStreamingShell(message.mode || "analyze");
      setStatus(`Streaming a ${message.mode === "remix" ? "remixed" : "new"} live page UI...`);
      return { started: true };
    },
    "web40:streamArtifactUpdate": async (message) => {
      const progress = message.progress || {};
      state.artifact = mergeArtifacts(state.artifact, progress.artifact || {});
      ensureDock();
      showDock(true);
      updateDockFields();
      await applyStreamingPreview(state.artifact, progress.statusText || "Streaming replacement UI...");
      return { updated: true };
    },
    "web40:applyArtifact": async (message) => {
      state.sourceSnapshot = message.snapshot || state.sourceSnapshot || getSourceSnapshot();
      state.artifact = cloneArtifact(message.artifact);
      state.originalArtifact = cloneArtifact(message.artifact);
      ensureDock();
      showDock(true);
      await applyArtifactToLivePage(state.artifact, { final: true });
      state.originalArtifact = cloneArtifact(state.artifact);
      updateDockFields();
      return { rendered: true };
    },
    "web40:streamArtifactError": async (message) => {
      ensureDock();
      showDock(true);
      setStatus(message.error || "Streaming failed.");
      return { shown: true };
    },
    "web40:toggleOverlay": async () => {
      ensureDock();
      state.dockVisible = !state.dockVisible;
      syncDockVisibility();
      return { visible: state.dockVisible };
    }
  };

  function injectPageBridge() {
    const script = document.createElement("script");
    script.src = chrome.runtime.getURL("page-bridge.js");
    script.async = false;
    script.dataset.web40 = "bridge";
    (document.documentElement || document.head || document.body).appendChild(script);
    script.addEventListener("load", () => script.remove());
  }

  function handleWindowMessage(event) {
    const data = event.data;
    if (!data || typeof data !== "object" || event.source !== window) {
      return;
    }

    if (data.source === "WEB40_PAGE") {
      handlePageBridgeMessage(data);
    }
  }

  function handlePageBridgeMessage(data) {
    if (data.type === "WEB40_NETWORK_EVENT" && data.payload?.entry) {
      state.networkEntries.push(sanitizeNetworkEntry(data.payload.entry));
      if (state.networkEntries.length > 60) {
        state.networkEntries.splice(0, state.networkEntries.length - 60);
      }
      renderApiCatalog();
      return;
    }

    if (data.type === "WEB40_RUNTIME_LOG") {
      const message = String(data.payload?.message || "").trim();
      if (message) {
        setStatus(message);
      }
      return;
    }

    if (data.type === "WEB40_RUNTIME_REQUEST") {
      handleRuntimeRequest(data);
    }
  }

  async function handleRuntimeRequest(data) {
    const requestType = data.requestType;

    try {
      if (requestType === "getPageContext") {
        respondToPageRuntime(data.requestId, {
          snapshot: getSourceSnapshot(),
          artifact: summarizeArtifact(state.artifact)
        });
        return;
      }

      if (requestType === "getCapturedApis") {
        respondToPageRuntime(data.requestId, {
          apiCatalog: buildApiCatalog(state.networkEntries),
          networkEntries: state.networkEntries.slice(-24)
        });
        return;
      }

      if (requestType === "restoreOriginalView") {
        await restoreOriginalPage();
        respondToPageRuntime(data.requestId, { restored: true });
      }
    } catch (error) {
      respondToPageRuntime(data.requestId, null, error);
    }
  }

  function respondToPageRuntime(requestId, payload, error) {
    window.postMessage(
      {
        source: "WEB40_EXTENSION",
        type: "WEB40_RUNTIME_RESPONSE",
        requestId,
        ok: !error,
        payload: error
          ? { error: error instanceof Error ? error.message : String(error) }
          : payload
      },
      "*"
    );
  }

  function getSourceSnapshot() {
    if (state.generatedViewActive && state.sourceSnapshot) {
      return {
        ...cloneArtifactLike(state.sourceSnapshot),
        networkEntries: state.networkEntries.slice(-60),
        capturedAt: new Date().toISOString()
      };
    }

    return collectLiveSnapshot();
  }

  function collectLiveSnapshot() {
    const htmlPreview = getSanitizedHtmlPreview();
    const visibleText = clipText(document.body?.innerText || "", 7000);

    return {
      url: location.href,
      title: document.title || "Untitled page",
      description: document.querySelector('meta[name="description"]')?.content || "",
      lang: document.documentElement.lang || "",
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight
      },
      bodyClasses: Array.from(document.body?.classList || []).slice(0, 24),
      headings: serializeTextNodes("h1, h2, h3", 16, 220),
      navItems: serializeTextNodes("nav a, header a", 18, 140),
      buttons: serializeButtons(),
      inputs: serializeInputs(),
      forms: serializeForms(),
      links: serializeLinks(),
      images: serializeImages(),
      htmlPreview,
      visibleTextExcerpt: visibleText,
      inlineScripts: serializeInlineScripts(),
      externalScripts: serializeExternalScripts(),
      stylesheets: serializeStylesheets(),
      networkEntries: state.networkEntries.slice(-60),
      capturedAt: new Date().toISOString()
    };
  }

  function getSanitizedHtmlPreview() {
    if (!document.documentElement) {
      return "";
    }

    const clone = document.documentElement.cloneNode(true);
    clone.querySelector("#web40-root")?.remove();
    clone.querySelector("style[data-web40-generated-style]")?.remove();
    clone.querySelector("script[data-web40-generated-script]")?.remove();
    clone.querySelectorAll("script[data-web40='bridge']").forEach((node) => node.remove());
    return clipText(clone.outerHTML, 18000);
  }

  async function ensureBodyAvailable() {
    if (document.body) {
      return;
    }

    await new Promise((resolve) => {
      const observer = new MutationObserver(() => {
        if (document.body) {
          observer.disconnect();
          resolve();
        }
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
    });
  }

  async function stashOriginalPage() {
    await ensureBodyAvailable();
    if (state.generatedViewActive && state.originalBodyFragment) {
      return;
    }

    state.originalTitle = document.title;
    state.originalBodyFragment = document.createDocumentFragment();
    while (document.body.firstChild) {
      state.originalBodyFragment.appendChild(document.body.firstChild);
    }
    state.generatedViewActive = true;
    state.lastAppliedHtml = "";
    state.lastAppliedCss = "";
  }

  async function restoreOriginalPage() {
    if (!state.generatedViewActive) {
      setStatus("Original page is already visible.");
      return;
    }

    await ensureBodyAvailable();
    runCleanupInPage();
    removeGeneratedRuntimeArtifacts();
    document.body.innerHTML = "";

    if (state.originalBodyFragment) {
      document.body.appendChild(state.originalBodyFragment);
    }

    state.originalBodyFragment = null;
    state.generatedViewActive = false;
    state.lastAppliedHtml = "";
    state.lastAppliedCss = "";
    if (state.originalTitle) {
      document.title = state.originalTitle;
    }
    setStatus("Restored the original page view.");
  }

  async function applyStreamingPreview(artifact, statusText) {
    await ensureBodyAvailable();
    await stashOriginalPage();

    const html = (artifact.rawHtml?.trim() || artifact.html?.trim())
      ? artifact.rawHtml || artifact.html
      : buildStreamingShellHtml(statusText, artifact);

    if (html !== state.lastAppliedHtml) {
      document.body.innerHTML = html;
      state.lastAppliedHtml = html;
    }

    if (artifact.uiTitle) {
      document.title = artifact.uiTitle;
    }

    setStatus(statusText);
  }

  async function applyArtifactToLivePage(artifact, { final }) {
    await ensureBodyAvailable();
    await stashOriginalPage();

    const runtimeParts = extractRuntimePartsFromHtml(artifact.rawHtml || artifact.html || "");
    const html = runtimeParts.html?.trim() || buildStreamingShellHtml("Applying generated page...", artifact);
    document.body.innerHTML = html;
    state.lastAppliedHtml = html;
    updateGeneratedStyles(runtimeParts.css || artifact.css || "");

    artifact.html = runtimeParts.html;
    artifact.rawHtml = artifact.rawHtml || artifact.html;
    artifact.css = runtimeParts.css || artifact.css || "";
    artifact.js = runtimeParts.js || artifact.js || "";
    artifact.uiTitle = artifact.uiTitle || runtimeParts.title || state.originalTitle || document.title;

    if (artifact.uiTitle) {
      document.title = artifact.uiTitle;
    }

    if (final) {
      runCleanupInPage();
      executeGeneratedRuntime(artifact.js || "");
      setStatus("Applied generated UI directly to the live page.");
    }

    updateDockFields();
  }

  function updateGeneratedStyles(cssText) {
    if (!state.generatedStyleEl) {
      state.generatedStyleEl = document.createElement("style");
      state.generatedStyleEl.dataset.web40GeneratedStyle = "true";
      document.head.appendChild(state.generatedStyleEl);
    }

    if (cssText === state.lastAppliedCss) {
      return;
    }

    state.generatedStyleEl.textContent = cssText;
    state.lastAppliedCss = cssText;
  }

  function removeGeneratedRuntimeArtifacts() {
    if (state.generatedStyleEl) {
      state.generatedStyleEl.remove();
      state.generatedStyleEl = null;
    }

    if (state.generatedScriptEl) {
      state.generatedScriptEl.remove();
      state.generatedScriptEl = null;
    }
  }

  function runCleanupInPage() {
    injectPageScript(`
      (() => {
        try {
          if (typeof window.__WEB40_RUNTIME_CLEANUP__ === "function") {
            window.__WEB40_RUNTIME_CLEANUP__();
          }
        } catch (error) {
          console.warn("Web 4.0 cleanup error", error);
        }
        window.__WEB40_RUNTIME_CLEANUP__ = null;
      })();
    `);
  }

  function executeGeneratedRuntime(jsText) {
    removeGeneratedScriptOnly();
    if (!jsText.trim()) {
      return;
    }

    const wrappedScript = `
      (() => {
        try {
          window.Web40 = window.Web40 || {};
          window.Web40.registerCleanup = function registerCleanup(fn) {
            window.__WEB40_RUNTIME_CLEANUP__ = typeof fn === "function" ? fn : null;
          };
          ${jsText}
        } catch (error) {
          console.error("Web 4.0 runtime error", error);
          window.postMessage({
            source: "WEB40_PAGE",
            type: "WEB40_RUNTIME_LOG",
            payload: { message: "Runtime error: " + (error.message || String(error)) }
          }, "*");
        }
      })();
    `;

    state.generatedScriptEl = injectPageScript(wrappedScript, "web40-generated-script");
  }

  function removeGeneratedScriptOnly() {
    if (state.generatedScriptEl) {
      state.generatedScriptEl.remove();
      state.generatedScriptEl = null;
    }
  }

  function injectPageScript(code, dataAttribute) {
    const script = document.createElement("script");
    if (dataAttribute) {
      script.dataset[dataAttribute] = "true";
      script.setAttribute(`data-${dataAttribute}`, "true");
    }
    script.textContent = code;
    (document.documentElement || document.head || document.body).appendChild(script);
    script.remove();
    return script;
  }

  function ensureDock() {
    if (state.elements.root) {
      return;
    }

    const root = document.createElement("div");
    root.id = "web40-root";
    root.innerHTML = `
      <div class="web40-shell">
        <div class="web40-toolbar">
          <div class="web40-brand">
            <span class="web40-brand-mark"></span>
            <div>
              <strong>Web 4.0</strong>
              <span class="web40-brand-sub">Direct live-page runtime</span>
            </div>
          </div>
          <div class="web40-toolbar-copy">
            <div class="web40-title-line"></div>
            <div class="web40-status-line"></div>
          </div>
          <div class="web40-toolbar-actions">
            <button type="button" data-web40-action="toggle-panel">Code</button>
            <button type="button" data-web40-action="restore-page">Restore</button>
            <button type="button" data-web40-action="hide-dock">Hide</button>
          </div>
        </div>
        <aside class="web40-panel">
          <div class="web40-panel-section">
            <div class="web40-summary-text"></div>
            <div class="web40-binding-list"></div>
          </div>
          <label class="web40-field">
            <span>HTML</span>
            <textarea data-web40-field="html"></textarea>
          </label>
          <label class="web40-field">
            <span>CSS</span>
            <textarea data-web40-field="css"></textarea>
          </label>
          <label class="web40-field">
            <span>JS</span>
            <textarea data-web40-field="js"></textarea>
          </label>
          <div class="web40-sidebar-actions">
            <button type="button" data-web40-action="apply-code">Apply edits</button>
            <button type="button" data-web40-action="reset-code">Reset to model</button>
          </div>
          <div class="web40-api-panel">
            <h3>Captured APIs</h3>
            <div class="web40-api-list"></div>
          </div>
        </aside>
      </div>
    `;

    document.documentElement.appendChild(root);

    state.elements.root = root;
    state.elements.panel = root.querySelector(".web40-panel");
    state.elements.apiList = root.querySelector(".web40-api-list");
    state.elements.summary = root.querySelector(".web40-summary-text");
    state.elements.status = root.querySelector(".web40-status-line");
    state.elements.htmlField = root.querySelector('[data-web40-field="html"]');
    state.elements.cssField = root.querySelector('[data-web40-field="css"]');
    state.elements.jsField = root.querySelector('[data-web40-field="js"]');
    state.elements.title = root.querySelector(".web40-title-line");
    state.elements.bindings = root.querySelector(".web40-binding-list");

    root.addEventListener("click", async (event) => {
      const action = event.target?.dataset?.web40Action;
      if (!action) {
        return;
      }

      if (action === "toggle-panel") {
        state.elements.panel.classList.toggle("web40-panel-collapsed");
        return;
      }

      if (action === "hide-dock") {
        showDock(false);
        return;
      }

      if (action === "restore-page") {
        await restoreOriginalPage();
        return;
      }

      if (action === "apply-code") {
        await applyRuntimeEdit();
        return;
      }

      if (action === "reset-code" && state.originalArtifact) {
        state.artifact = cloneArtifact(state.originalArtifact);
        updateDockFields();
        await applyArtifactToLivePage(state.artifact, { final: true });
      }
    });

    renderApiCatalog();
    syncDockVisibility();
  }

  function showDock(visible) {
    state.dockVisible = visible;
    syncDockVisibility();
  }

  function syncDockVisibility() {
    if (!state.elements.root) {
      return;
    }
    state.elements.root.classList.toggle("web40-hidden", !state.dockVisible);
  }

  function updateDockFields() {
    ensureDock();

    const artifact = state.artifact || {};
    state.elements.htmlField.value = artifact.html || "";
    state.elements.cssField.value = artifact.css || "";
    state.elements.jsField.value = artifact.js || "";
    state.elements.summary.textContent =
      artifact.summary || "Streaming a replacement UI directly into the live page.";
    state.elements.title.textContent = artifact.uiTitle || "Generating live page replacement";

    const bindings = (artifact.dataBindings || [])
      .map((binding) => `<span class="web40-binding-chip">${escapeHtml(binding)}</span>`)
      .join("");
    state.elements.bindings.innerHTML =
      bindings || `<span class="web40-binding-empty">No live bindings listed yet.</span>`;

    renderApiCatalog();
  }

  async function applyRuntimeEdit() {
    ensureDock();

    const nextArtifact = mergeArtifacts(state.artifact, {
      html: state.elements.htmlField.value,
      css: state.elements.cssField.value,
      js: state.elements.jsField.value,
      generatedAt: new Date().toISOString(),
      summary: `${state.artifact?.summary || "Runtime edit applied"} (manual live edit)`
    });

    state.artifact = nextArtifact;
    await applyArtifactToLivePage(nextArtifact, { final: true });

    try {
      await sendBackgroundMessage({
        type: "web40:saveRuntimeArtifact",
        artifact: nextArtifact
      });
      setStatus("Applied and saved manual live-page edits.");
    } catch (error) {
      setStatus(`Applied edits locally, but persistence failed: ${error.message}`);
    }
  }

  function renderApiCatalog() {
    if (!state.elements.apiList) {
      return;
    }

    const apiItems = buildApiCatalog(state.networkEntries);
    if (!apiItems.length) {
      state.elements.apiList.innerHTML = `
        <div class="web40-api-empty">
          No fetch or XHR traffic has been captured yet. Reloading the page after installing the extension usually helps.
        </div>
      `;
      return;
    }

    state.elements.apiList.innerHTML = apiItems
      .map(
        (item) => `
          <article class="web40-api-item">
            <div class="web40-api-head">
              <span class="web40-api-method">${escapeHtml(item.method)}</span>
              <span class="web40-api-count">${item.count} calls</span>
            </div>
            <strong>${escapeHtml(item.url)}</strong>
            <p>${escapeHtml(item.sampleResponse || item.sampleRequestBody || item.contentType || "Captured without preview text.")}</p>
          </article>
        `
      )
      .join("");
  }

  function buildApiCatalog(networkEntries) {
    const grouped = new Map();

    for (const entry of networkEntries.slice(-30)) {
      const method = String(entry.method || "GET").toUpperCase();
      const url = normalizeUrlSignature(entry.url);
      const key = `${method} ${url}`;

      if (!grouped.has(key)) {
        grouped.set(key, {
          method,
          url,
          count: 0,
          contentType: entry.contentType || "",
          sampleRequestBody: clipText(entry.requestBodyPreview || "", 260),
          sampleResponse: clipText(entry.responsePreview || "", 320)
        });
      }

      grouped.get(key).count += 1;
    }

    return Array.from(grouped.values()).slice(0, 12);
  }

  function normalizeUrlSignature(rawUrl) {
    try {
      const url = new URL(rawUrl);
      const params = Array.from(url.searchParams.keys()).sort();
      return `${url.origin}${url.pathname}${params.length ? `?${params.join("&")}` : ""}`;
    } catch (error) {
      return String(rawUrl || "");
    }
  }

  function buildStreamingShellHtml(statusText, artifact) {
    return `
      <section style="min-height:100vh;display:grid;place-items:center;padding:48px;background:radial-gradient(circle at top left, rgba(72,199,255,0.16), transparent 30%),radial-gradient(circle at bottom right, rgba(255,145,90,0.12), transparent 28%),#050811;color:#f4f7ff;font-family:Satoshi,Segoe UI,sans-serif;">
        <div style="width:min(960px,92vw);display:grid;gap:20px;">
          <div style="display:grid;gap:10px;">
            <div style="font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:rgba(214,224,255,.62);">Web 4.0 streaming replacement</div>
            <h1 style="margin:0;font-size:clamp(2.8rem,6vw,5.5rem);line-height:.98;letter-spacing:-.05em;">${escapeHtml(
              artifact?.uiTitle || "Generating a new live UI"
            )}</h1>
            <p style="margin:0;font-size:1.05rem;line-height:1.7;color:rgba(214,224,255,.78);">${escapeHtml(
              artifact?.summary || statusText || "Streaming a direct replacement for this page."
            )}</p>
          </div>
          <div style="padding:18px 20px;border-radius:22px;border:1px solid rgba(255,255,255,.08);background:rgba(255,255,255,.045);font-size:12px;line-height:1.7;color:rgba(228,234,255,.78);">
            ${escapeHtml(statusText || "Generating...")}
          </div>
        </div>
      </section>
    `;
  }

  function extractRuntimePartsFromHtml(rawHtml) {
    const parser = new DOMParser();
    const parsed = parser.parseFromString(rawHtml || "", "text/html");
    const styleTexts = Array.from(parsed.querySelectorAll("style"))
      .map((node) => node.textContent || "")
      .filter(Boolean);
    const scriptTexts = Array.from(parsed.querySelectorAll("script"))
      .map((node) => node.textContent || "")
      .filter(Boolean);

    parsed.querySelectorAll("style, script").forEach((node) => node.remove());

    const title =
      parsed.querySelector("title")?.textContent?.trim() ||
      parsed.querySelector("h1")?.textContent?.trim() ||
      parsed.querySelector("h2")?.textContent?.trim() ||
      "";

    return {
      html: parsed.body?.innerHTML || rawHtml || "",
      css: styleTexts.join("\n\n"),
      js: scriptTexts.join("\n\n"),
      title
    };
  }

  function setStatus(message) {
    ensureDock();
    state.elements.status.textContent = message || "";
  }

  function summarizeArtifact(artifact) {
    if (!artifact) {
      return {
        uiTitle: "",
        summary: "",
        dataBindings: []
      };
    }

    return {
      uiTitle: artifact.uiTitle || "",
      summary: artifact.summary || "",
      dataBindings: artifact.dataBindings || []
    };
  }

  function mergeArtifacts(current, partial) {
    const next = {
      ...(current || {})
    };

    for (const [key, value] of Object.entries(partial || {})) {
      if (value === undefined) {
        continue;
      }
      next[key] = Array.isArray(value) ? value.slice() : value;
    }

    return next;
  }

  function cloneArtifact(artifact) {
    return JSON.parse(JSON.stringify(artifact || {}));
  }

  function cloneArtifactLike(value) {
    return JSON.parse(JSON.stringify(value || {}));
  }

  function sanitizeNetworkEntry(entry) {
    return {
      transport: entry.transport || "fetch",
      url: String(entry.url || ""),
      method: String(entry.method || "GET").toUpperCase(),
      status: Number(entry.status || 0),
      ok: Boolean(entry.ok),
      duration: Number(entry.duration || 0),
      contentType: String(entry.contentType || ""),
      requestBodyPreview: clipText(entry.requestBodyPreview || "", 1200),
      responsePreview: clipText(entry.responsePreview || "", 1600)
    };
  }

  function sendBackgroundMessage(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }

        if (!response?.ok) {
          reject(new Error(response?.error?.message || "Web 4.0 background request failed."));
          return;
        }

        resolve(response.result);
      });
    });
  }

  function serializeTextNodes(selector, limit, textLimit) {
    return Array.from(document.querySelectorAll(selector))
      .slice(0, limit)
      .map((node) => clipText((node.textContent || "").trim(), textLimit))
      .filter(Boolean);
  }

  function serializeButtons() {
    return Array.from(document.querySelectorAll("button, [role='button'], input[type='submit']"))
      .slice(0, 18)
      .map((node) => ({
        label: clipText(getElementLabel(node), 120),
        type: node.getAttribute("type") || "",
        id: node.id || "",
        classes: clipText(node.className || "", 160)
      }))
      .filter((button) => button.label || button.id);
  }

  function serializeInputs() {
    return Array.from(document.querySelectorAll("input, textarea, select"))
      .slice(0, 20)
      .map((node) => ({
        name: node.getAttribute("name") || "",
        id: node.id || "",
        type: node.getAttribute("type") || node.tagName.toLowerCase(),
        placeholder: clipText(node.getAttribute("placeholder") || "", 120),
        label: clipText(getAssociatedLabel(node), 120)
      }));
  }

  function serializeForms() {
    return Array.from(document.forms)
      .slice(0, 10)
      .map((form) => ({
        action: form.getAttribute("action") || "",
        method: (form.getAttribute("method") || "GET").toUpperCase(),
        fields: Array.from(form.elements)
          .slice(0, 10)
          .map((field) => ({
            name: field.getAttribute?.("name") || "",
            type: field.getAttribute?.("type") || field.tagName?.toLowerCase() || "",
            placeholder: clipText(field.getAttribute?.("placeholder") || "", 100)
          }))
      }));
  }

  function serializeLinks() {
    return Array.from(document.querySelectorAll("a[href]"))
      .slice(0, 18)
      .map((link) => ({
        label: clipText((link.textContent || "").trim(), 120),
        href: link.href
      }))
      .filter((item) => item.label || item.href);
  }

  function serializeImages() {
    return Array.from(document.images)
      .slice(0, 14)
      .map((image) => ({
        alt: clipText(image.alt || "", 120),
        src: image.currentSrc || image.src || ""
      }));
  }

  function serializeInlineScripts() {
    return Array.from(document.querySelectorAll("script:not([src])"))
      .map((script, index) => ({
        index,
        snippet: clipText(compactWhitespace(script.textContent || ""), 1800)
      }))
      .filter((script) => script.snippet)
      .slice(0, 4);
  }

  function serializeExternalScripts() {
    return Array.from(document.querySelectorAll("script[src]"))
      .map((script) => ({
        url: script.src,
        kind: "script",
        type: script.type || ""
      }))
      .filter((script) => script.url)
      .slice(0, 12);
  }

  function serializeStylesheets() {
    return Array.from(document.querySelectorAll('link[rel="stylesheet"][href]'))
      .map((link) => ({
        url: link.href,
        kind: "stylesheet"
      }))
      .filter((item) => item.url)
      .slice(0, 8);
  }

  function getElementLabel(node) {
    return (
      node.getAttribute?.("aria-label") ||
      node.getAttribute?.("title") ||
      node.value ||
      node.textContent ||
      ""
    )
      .trim()
      .replace(/\s+/g, " ");
  }

  function getAssociatedLabel(node) {
    if (!node) {
      return "";
    }

    if (node.id) {
      const fromFor = document.querySelector(`label[for="${CSS.escape(node.id)}"]`);
      if (fromFor?.textContent) {
        return fromFor.textContent.trim().replace(/\s+/g, " ");
      }
    }

    const parentLabel = node.closest("label");
    return parentLabel?.textContent?.trim().replace(/\s+/g, " ") || "";
  }

  function escapeHtml(text) {
    return String(text || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function compactWhitespace(text) {
    return String(text || "").replace(/\s+/g, " ").trim();
  }

  function clipText(text, maxLength) {
    const value = String(text || "");
    return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...`;
  }
})();
