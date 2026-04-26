const SETTINGS_KEY = "web40:settings";
const ARTIFACT_PREFIX = "web40:artifact:";
const TAB_STATE_PREFIX = "web40:tab-state:";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const MAX_NETWORK_ENTRIES = 36;
const MAX_SCRIPT_SNIPPETS = 3;
const MAX_STYLESHEET_SNIPPETS = 2;
const STREAM_PROGRESS_INTERVAL_MS = 140;

const DEFAULT_SETTINGS = {
  apiKey: "",
  model: "openai/gpt-5.5",
  defaultPrompt: [
    "Replace the current website UI with a sharper, clearer, more useful frontend for the person using it right now.",
    "Generate raw html that can directly replace document.body.innerHTML in the live page.",
    "Use the captured DOM, script hints, and network catalog to preserve the site's real capabilities.",
    "Prefer live data via window.Web40.callApi() and window.Web40.getCapturedApis() instead of inventing fake backends."
  ].join(" "),
  remixPrompt: [
    "Remix the currently generated frontend into a more opinionated runtime while keeping the same live data sources and behaviors intact.",
    "You may reorganize the layout, rename sections, and add new controls, but the result must still run directly in the live page.",
    "Keep the code self-contained in plain html, css, and js."
  ].join(" ")
};

const tabStateCache = new Map();

chrome.runtime.onInstalled.addListener(async () => {
  await ensureSettings();
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  tabStateCache.delete(tabId);
  await chrome.storage.local.remove([artifactKey(tabId), tabStateKey(tabId)]);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = MESSAGE_HANDLERS[message?.type];
  if (!handler) {
    return false;
  }

  (async () => {
    try {
      const result = await handler(message, sender);
      sendResponse({ ok: true, result });
    } catch (error) {
      sendResponse({
        ok: false,
        error: {
          message: error instanceof Error ? error.message : String(error)
        }
      });
    }
  })();

  return true;
});

const MESSAGE_HANDLERS = {
  "web40:getSettings": async () => ensureSettings(),
  "web40:saveSettings": async (message) => saveSettings(message.settings || {}),
  "web40:openStudio": async () => {
    await chrome.runtime.openOptionsPage();
    return { opened: true };
  },
  "web40:getActiveTabState": async () => {
    const tab = await getActiveHttpTab();
    return getTabState(tab.id, tab);
  },
  "web40:analyzeActiveTab": async () => {
    const tab = await getActiveHttpTab();
    return analyzeTab(tab);
  },
  "web40:remixActiveTab": async () => {
    const tab = await getActiveHttpTab();
    return remixTab(tab);
  },
  "web40:toggleOverlay": async () => {
    const tab = await getActiveHttpTab();
    await ensureContentReady(tab);
    const result = await chrome.tabs.sendMessage(tab.id, { type: "web40:toggleOverlay" });
    return {
      tabId: tab.id,
      visible: Boolean(result?.visible)
    };
  },
  "web40:saveRuntimeArtifact": async (message, sender) => {
    const tabId = sender.tab?.id;
    if (!tabId) {
      throw new Error("Unable to determine which tab owns the runtime edit.");
    }

    const tab = sender.tab;
    const currentState = await getTabState(tabId, tab);
    const nextArtifact = normalizeArtifact(message.artifact || {});

    await saveArtifact(tabId, nextArtifact);
    await saveTabState(tabId, {
      ...currentState,
      status: "ready",
      lastGeneratedAt: nextArtifact.generatedAt || new Date().toISOString(),
      artifactSummary: {
        uiTitle: nextArtifact.uiTitle,
        summary: clipText(nextArtifact.summary || "Runtime-edited page", 220)
      }
    });

    return getTabState(tabId, tab);
  }
};

async function ensureSettings() {
  const stored = (await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY] || {};
  const merged = {
    ...DEFAULT_SETTINGS,
    ...stored
  };

  if (JSON.stringify(stored) !== JSON.stringify(merged)) {
    await chrome.storage.local.set({ [SETTINGS_KEY]: merged });
  }

  return merged;
}

async function saveSettings(partial) {
  const current = await ensureSettings();
  const next = {
    ...current,
    ...sanitizeSettings(partial)
  };
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

function sanitizeSettings(settings) {
  return {
    apiKey: String(settings.apiKey || "").trim(),
    model: String(settings.model || DEFAULT_SETTINGS.model).trim() || DEFAULT_SETTINGS.model,
    defaultPrompt: String(settings.defaultPrompt || DEFAULT_SETTINGS.defaultPrompt).trim() || DEFAULT_SETTINGS.defaultPrompt,
    remixPrompt: String(settings.remixPrompt || DEFAULT_SETTINGS.remixPrompt).trim() || DEFAULT_SETTINGS.remixPrompt
  };
}

async function getActiveHttpTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !isInspectableUrl(tab.url)) {
    throw new Error("Open a regular http or https page before using Web 4.0.");
  }
  return tab;
}

function isInspectableUrl(url) {
  return /^https?:\/\//i.test(String(url || ""));
}

async function ensureContentReady(tab) {
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "web40:ping" });
    return;
  } catch (error) {
    if (!isInspectableUrl(tab.url)) {
      throw error;
    }
  }

  await chrome.scripting.insertCSS({
    target: { tabId: tab.id },
    files: ["overlay.css"]
  });

  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ["content-script.js"]
  });

  await delay(120);
}

async function analyzeTab(tab) {
  return generateForTab(tab, "analyze");
}

async function remixTab(tab) {
  return generateForTab(tab, "remix");
}

async function generateForTab(tab, mode) {
  const settings = await ensureSettings();
  if (!settings.apiKey) {
    throw new Error("Save an OpenRouter API key first.");
  }

  await ensureContentReady(tab);
  const currentState = await getTabState(tab.id, tab);
  const existingArtifact = mode === "remix" ? await getArtifact(tab.id) : null;

  if (mode === "remix" && !existingArtifact) {
    throw new Error("Generate a Web 4.0 UI for this tab before running a remix.");
  }

  await saveTabState(tab.id, {
    ...currentState,
    status: mode === "remix" ? "remixing" : "analyzing",
    url: tab.url,
    title: tab.title || "Untitled tab",
    updatedAt: new Date().toISOString(),
    lastError: ""
  });

  try {
    const snapshot = await chrome.tabs.sendMessage(tab.id, { type: "web40:collectSnapshot" });
    const assetSnippets = await fetchReferencedAssets(snapshot);
    const sitePayload = buildSitePayload(snapshot, assetSnippets);

    await safeSendTabMessage(tab.id, {
      type: "web40:streamRenderStart",
      mode,
      snapshot
    });

    const artifact = await requestArtifactFromModel({
      settings,
      mode,
      sitePayload,
      existingArtifact,
      onProgress: async (progress) => {
        await safeSendTabMessage(tab.id, {
          type: "web40:streamArtifactUpdate",
          progress
        });
      }
    });

    const generatedAt = new Date().toISOString();
    artifact.generatedAt = generatedAt;
    artifact.sourceUrl = snapshot.url;
    artifact.mode = mode;

    await saveArtifact(tab.id, artifact);
    await saveTabState(tab.id, {
      tabId: tab.id,
      status: "ready",
      url: snapshot.url,
      title: snapshot.title,
      updatedAt: generatedAt,
      lastGeneratedAt: generatedAt,
      networkCount: snapshot.networkEntries.length,
      apiCount: sitePayload.network.apiCatalog.length,
      artifactSummary: {
        uiTitle: artifact.uiTitle,
        summary: clipText(artifact.summary, 220)
      },
      lastError: ""
    });

    await safeSendTabMessage(tab.id, {
      type: "web40:applyArtifact",
      artifact,
      snapshot
    });

    return getTabState(tab.id, tab);
  } catch (error) {
    await saveTabState(tab.id, {
      ...(await getTabState(tab.id, tab)),
      status: "error",
      updatedAt: new Date().toISOString(),
      lastError: error instanceof Error ? error.message : String(error)
    });

    await safeSendTabMessage(tab.id, {
      type: "web40:streamArtifactError",
      error: error instanceof Error ? error.message : String(error)
    });

    throw error;
  }
}

async function requestArtifactFromModel({
  settings,
  mode,
  sitePayload,
  existingArtifact,
  onProgress
}) {
  const requestBody = {
    model: settings.model,
    max_tokens: 7000,
    stream: true,
    messages: [
      {
        role: "system",
        content: [
          "You are Web 4.0, an expert reverse-engineering UI architect.",
          "The generated result will replace the current document.body.innerHTML directly in the live page.",
          "Return raw HTML only. Do not return JSON. Do not return markdown fences. Do not explain the code.",
          "You may include inline <style> and <script> tags inside the HTML if needed.",
          "The response should still be useful even if it is streamed and temporarily incomplete.",
          "The generated experience must stay wired to the source site's real data, API endpoints, and page context.",
          "Use only plain html, css, and js. No external libraries.",
          "Assume these helpers exist directly on the live page:",
          "- await window.Web40.getPageContext()",
          "- await window.Web40.getCapturedApis()",
          "- await window.Web40.callApi({ url, method, headers, body, credentials })",
          "- window.Web40.registerCleanup(fn)",
          "Prefer live data through those helpers instead of inventing fake payloads.",
          "If the site has no useful API calls yet, build from page context first and progressively enhance with captured endpoints.",
          "The HTML should look like a finished frontend, not a loading skeleton.",
          "Do not wrap the result in triple backticks."
        ].join("\n")
      },
      {
        role: "user",
        content: buildModelPrompt({ settings, mode, sitePayload, existingArtifact })
      }
    ]
  };

  let streamedText = "";
  let lastProgressAt = 0;

  await performOpenRouterStream(settings.apiKey, requestBody, async (delta) => {
    streamedText += delta;
    const now = Date.now();
    if (now - lastProgressAt < STREAM_PROGRESS_INTERVAL_MS) {
      return;
    }

    lastProgressAt = now;
    const partialArtifact = parseArtifactFromText(streamedText, sitePayload.site.title || "Web 4.0 Remix");
    await onProgress?.({
      artifact: partialArtifact,
      statusText: determineStreamStatus(streamedText)
    });
  });

  const finalArtifact = parseArtifactFromText(streamedText, sitePayload.site.title || "Web 4.0 Remix");
  if (!finalArtifact.rawHtml.trim()) {
    throw new Error("The model did not return any HTML in the streamed response.");
  }

  return finalArtifact;
}

async function performOpenRouterStream(apiKey, requestBody, onTextDelta) {
  const response = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://web40.extension.local",
      "X-Title": "Web 4.0"
    },
    body: JSON.stringify(requestBody)
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenRouter request failed (${response.status}): ${clipText(text, 500)}`);
  }

  if (!response.body) {
    throw new Error("OpenRouter did not provide a streaming response body.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done }).replace(/\r\n/g, "\n");

    let boundaryIndex = buffer.indexOf("\n\n");
    while (boundaryIndex !== -1) {
      const rawEvent = buffer.slice(0, boundaryIndex);
      buffer = buffer.slice(boundaryIndex + 2);
      await processSseEvent(rawEvent, onTextDelta);
      boundaryIndex = buffer.indexOf("\n\n");
    }

    if (done) {
      break;
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) {
    await processSseEvent(buffer, onTextDelta);
  }
}

async function processSseEvent(rawEvent, onTextDelta) {
  const lines = String(rawEvent || "").split("\n");
  const dataLines = [];

  for (const line of lines) {
    if (!line || line.startsWith(":")) {
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  if (!dataLines.length) {
    return;
  }

  const payloadText = dataLines.join("\n").trim();
  if (!payloadText || payloadText === "[DONE]") {
    return;
  }

  let payload;
  try {
    payload = JSON.parse(payloadText);
  } catch (error) {
    return;
  }

  if (payload.error?.message) {
    throw new Error(`OpenRouter stream error: ${payload.error.message}`);
  }

  const deltaText = extractMessageContent(payload?.choices?.[0]?.delta?.content);
  if (deltaText) {
    await onTextDelta(deltaText);
  }
}

function buildModelPrompt({ settings, mode, sitePayload, existingArtifact }) {
  const promptLines = [
    `Mode: ${mode}`,
    "",
    mode === "remix" ? "User remix instruction:" : "User default generation instruction:",
    mode === "remix" ? settings.remixPrompt : settings.defaultPrompt,
    "",
    "Execution rules:",
    "- The generated response will be written directly into document.body.innerHTML.",
    "- If you need CSS or JS, embed them as <style> and <script> tags inside the returned HTML.",
    "- The runtime runs directly on the page, not in an iframe.",
    "- Use window.Web40.callApi() for the real data whenever possible.",
    "",
    "Site payload JSON:",
    JSON.stringify(sitePayload, null, 2)
  ];

  if (mode === "remix" && existingArtifact) {
    promptLines.push(
      "",
      "Current generated frontend:",
      JSON.stringify(
        {
          uiTitle: existingArtifact.uiTitle,
          summary: existingArtifact.summary,
          html: clipText(existingArtifact.rawHtml || existingArtifact.html, 6000),
          css: clipText(existingArtifact.css, 6000),
          js: clipText(existingArtifact.js, 6000),
          dataBindings: existingArtifact.dataBindings || []
        },
        null,
        2
      )
    );
  }

  promptLines.push(
    "",
    "Output rules:",
    "- Build a genuinely different UI, not a cosmetic reskin.",
    "- Preserve or improve the working data flows.",
    "- The frontend should still work against the same site and APIs.",
    "- Keep the JS resilient if some API calls fail.",
    "- Return raw HTML only with inline styles and scripts if needed."
  );

  return promptLines.join("\n");
}

function determineStreamStatus(streamedText) {
  if (/<script[\s>]/i.test(streamedText)) {
    return "Streaming HTML with live JS";
  }
  if (/<style[\s>]/i.test(streamedText)) {
    return "Streaming HTML with live CSS";
  }
  if (/<[a-z!/]/i.test(streamedText)) {
    return "Streaming HTML replacement";
  }
  return "Planning the new page runtime";
}

function parseArtifactFromText(text, fallbackTitle) {
  const rawHtml = stripHtmlFence(text);
  return normalizeArtifact({
    analysis: "",
    uiTitle: extractTitleFromRawHtml(rawHtml, fallbackTitle),
    summary: "Generated direct HTML replacement for the live page.",
    html: rawHtml,
    rawHtml
  });
}

function buildSitePayload(snapshot, assetSnippets) {
  const apiCatalog = buildApiCatalog(snapshot.networkEntries);

  return {
    site: {
      url: snapshot.url,
      title: snapshot.title,
      description: snapshot.description,
      lang: snapshot.lang,
      viewport: snapshot.viewport,
      bodyClasses: snapshot.bodyClasses
    },
    dom: {
      headings: snapshot.headings,
      primaryButtons: snapshot.buttons,
      inputs: snapshot.inputs,
      forms: snapshot.forms,
      navItems: snapshot.navItems,
      links: snapshot.links,
      images: snapshot.images,
      visibleTextExcerpt: clipText(snapshot.visibleTextExcerpt, 6000),
      htmlPreview: clipText(snapshot.htmlPreview, 14000)
    },
    scripts: {
      external: assetSnippets.externalScripts,
      inline: snapshot.inlineScripts
    },
    styles: {
      external: assetSnippets.stylesheets
    },
    network: {
      totalCaptured: snapshot.networkEntries.length,
      apiCatalog,
      recentRequests: snapshot.networkEntries.slice(-MAX_NETWORK_ENTRIES)
    },
    runtimeHelpers: {
      getPageContext: "Returns the captured source-page context, DOM signals, and metadata.",
      getCapturedApis: "Returns grouped API/network observations gathered from fetch and XHR.",
      callApi: "Performs a real request through the current page context so cookies and auth state continue to apply."
    }
  };
}

function buildApiCatalog(networkEntries) {
  const grouped = new Map();

  for (const entry of networkEntries.slice(-MAX_NETWORK_ENTRIES)) {
    const method = String(entry.method || "GET").toUpperCase();
    const url = normalizeUrlSignature(entry.url);
    const key = `${method} ${url}`;

    if (!grouped.has(key)) {
      grouped.set(key, {
        method,
        url,
        count: 0,
        sampleStatus: entry.status || 0,
        contentType: entry.contentType || "",
        sampleRequestBody: clipText(entry.requestBodyPreview || "", 700),
        sampleResponse: clipText(entry.responsePreview || "", 900)
      });
    }

    grouped.get(key).count += 1;
  }

  return Array.from(grouped.values()).slice(0, 18);
}

function normalizeUrlSignature(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const params = Array.from(url.searchParams.keys()).sort();
    const querySignature = params.length ? `?${params.join("&")}` : "";
    return `${url.origin}${url.pathname}${querySignature}`;
  } catch (error) {
    return String(rawUrl || "");
  }
}

async function fetchReferencedAssets(snapshot) {
  const sourceUrl = snapshot.url;
  const externalScripts = await fetchAssetSnippets(
    sourceUrl,
    snapshot.externalScripts || [],
    MAX_SCRIPT_SNIPPETS
  );
  const stylesheets = await fetchAssetSnippets(
    sourceUrl,
    snapshot.stylesheets || [],
    MAX_STYLESHEET_SNIPPETS
  );

  return {
    externalScripts,
    stylesheets
  };
}

async function fetchAssetSnippets(pageUrl, assets, limit) {
  const sorted = assets
    .map((asset) => ({
      url: String(asset.url || asset.href || ""),
      kind: asset.kind || "",
      sameOrigin: isSameOrigin(pageUrl, asset.url || asset.href || "")
    }))
    .filter((asset) => /^https?:\/\//i.test(asset.url))
    .sort((left, right) => Number(right.sameOrigin) - Number(left.sameOrigin))
    .slice(0, limit);

  const results = [];
  for (const asset of sorted) {
    try {
      const response = await fetch(asset.url);
      const contentType = response.headers.get("content-type") || "";
      const text = await response.text();
      results.push({
        url: asset.url,
        contentType,
        sameOrigin: asset.sameOrigin,
        snippet: clipText(compactWhitespace(text), 4000)
      });
    } catch (error) {
      results.push({
        url: asset.url,
        sameOrigin: asset.sameOrigin,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return results;
}

function isSameOrigin(pageUrl, assetUrl) {
  try {
    return new URL(pageUrl).origin === new URL(assetUrl).origin;
  } catch (error) {
    return false;
  }
}

function extractMessageContent(content) {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        if (typeof part?.text === "string") {
          return part.text;
        }
        return "";
      })
      .join("");
  }

  return "";
}

function stripJsonFence(text) {
  return String(text || "")
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function stripHtmlFence(text) {
  let cleaned = String(text || "")
    .trim()
    .replace(/^```html\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  const firstTagIndex = cleaned.indexOf("<");
  if (firstTagIndex > 0) {
    cleaned = cleaned.slice(firstTagIndex).trim();
  }

  return cleaned;
}

function extractTitleFromRawHtml(rawHtml, fallbackTitle) {
  const titleMatch = rawHtml.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch?.[1]) {
    return clipText(compactWhitespace(titleMatch[1]), 140);
  }

  const headingMatch = rawHtml.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || rawHtml.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
  if (headingMatch?.[1]) {
    return clipText(compactWhitespace(stripHtmlTags(headingMatch[1])), 140);
  }

  return clipText(String(fallbackTitle || "Web 4.0 Remix"), 140);
}

function normalizeArtifact(raw) {
  return {
    analysis: String(raw.analysis || "").trim(),
    uiTitle: clipText(String(raw.uiTitle || "Web 4.0 Remix").trim(), 140),
    summary: String(raw.summary || "").trim(),
    html: stripCodeFence(raw.html, "html"),
    rawHtml: stripHtmlFence(raw.rawHtml || raw.html || ""),
    css: stripCodeFence(raw.css, "css"),
    js: stripCodeFence(raw.js, "js"),
    generatedAt: raw.generatedAt ? String(raw.generatedAt) : "",
    sourceUrl: raw.sourceUrl ? String(raw.sourceUrl) : "",
    mode: raw.mode ? String(raw.mode) : "",
    dataBindings: Array.isArray(raw.dataBindings)
      ? raw.dataBindings.map((item) => String(item).trim()).filter(Boolean).slice(0, 20)
      : []
  };
}

function stripCodeFence(value, languageHint) {
  return String(value || "")
    .trim()
    .replace(new RegExp(`^\\\`\\\`\\\`${languageHint}\\s*`, "i"), "")
    .replace(/^```[a-z0-9-]*\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

async function saveArtifact(tabId, artifact) {
  await chrome.storage.local.set({
    [artifactKey(tabId)]: artifact
  });
}

async function getArtifact(tabId) {
  return (await chrome.storage.local.get(artifactKey(tabId)))[artifactKey(tabId)] || null;
}

async function saveTabState(tabId, state) {
  tabStateCache.set(tabId, state);
  await chrome.storage.local.set({
    [tabStateKey(tabId)]: state
  });
}

async function getTabState(tabId, tab) {
  if (tabStateCache.has(tabId)) {
    return tabStateCache.get(tabId);
  }

  const stored = (await chrome.storage.local.get(tabStateKey(tabId)))[tabStateKey(tabId)];
  if (stored) {
    tabStateCache.set(tabId, stored);
    return stored;
  }

  return {
    tabId,
    status: "idle",
    url: tab?.url || "",
    title: tab?.title || "Untitled tab",
    updatedAt: "",
    lastGeneratedAt: "",
    networkCount: 0,
    apiCount: 0,
    artifactSummary: null,
    lastError: ""
  };
}

async function safeSendTabMessage(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (error) {
    return null;
  }
}

function artifactKey(tabId) {
  return `${ARTIFACT_PREFIX}${tabId}`;
}

function tabStateKey(tabId) {
  return `${TAB_STATE_PREFIX}${tabId}`;
}

function clipText(value, maxLength) {
  const text = String(value || "");
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}...`;
}

function compactWhitespace(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function stripHtmlTags(text) {
  return String(text || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function delay(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}
