(function web40PageBridge() {
  if (window.__WEB40_PAGE_BRIDGE__) {
    return;
  }

  window.__WEB40_PAGE_BRIDGE__ = true;

  const originalFetch = window.fetch.bind(window);
  const originalXHROpen = XMLHttpRequest.prototype.open;
  const originalXHRSend = XMLHttpRequest.prototype.send;
  const MAX_PREVIEW = 2400;
  const pendingRuntimeRequests = new Map();

  window.fetch = async function patchedFetch(input, init = {}) {
    const request = input instanceof Request ? input : null;
    const method = String(init.method || request?.method || "GET").toUpperCase();
    const url = resolveUrl(request ? request.url : input);
    const startedAt = performance.now();

    try {
      const response = await originalFetch(input, init);
      const preview = await readResponsePreview(response.clone());

      postToExtension("WEB40_NETWORK_EVENT", {
        entry: {
          transport: "fetch",
          url,
          method,
          status: response.status,
          ok: response.ok,
          duration: Math.round(performance.now() - startedAt),
          contentType: response.headers.get("content-type") || "",
          requestBodyPreview: previewBody(init.body),
          responsePreview: preview
        }
      });

      return response;
    } catch (error) {
      postToExtension("WEB40_NETWORK_EVENT", {
        entry: {
          transport: "fetch",
          url,
          method,
          status: 0,
          ok: false,
          duration: Math.round(performance.now() - startedAt),
          contentType: "",
          requestBodyPreview: previewBody(init.body),
          responsePreview: clipText(error.message || String(error), MAX_PREVIEW)
        }
      });
      throw error;
    }
  };

  XMLHttpRequest.prototype.open = function patchedOpen(method, url, async, user, password) {
    this.__web40Meta = {
      method: String(method || "GET").toUpperCase(),
      url: resolveUrl(url)
    };
    return originalXHROpen.call(this, method, url, async, user, password);
  };

  XMLHttpRequest.prototype.send = function patchedSend(body) {
    const xhr = this;
    const startedAt = performance.now();

    const finalize = () => {
      let responsePreview = "";
      let contentType = "";

      try {
        responsePreview = clipText(xhr.responseText || "", MAX_PREVIEW);
      } catch (error) {
        responsePreview = "";
      }

      try {
        contentType = xhr.getResponseHeader("content-type") || "";
      } catch (error) {
        contentType = "";
      }

      postToExtension("WEB40_NETWORK_EVENT", {
        entry: {
          transport: "xhr",
          url: xhr.__web40Meta?.url || "",
          method: xhr.__web40Meta?.method || "GET",
          status: xhr.status,
          ok: xhr.status >= 200 && xhr.status < 400,
          duration: Math.round(performance.now() - startedAt),
          contentType,
          requestBodyPreview: previewBody(body),
          responsePreview
        }
      });
    };

    xhr.addEventListener("loadend", finalize, { once: true });
    return originalXHRSend.call(xhr, body);
  };

  window.addEventListener("message", (event) => {
    if (event.source !== window) {
      return;
    }

    const data = event.data;
    if (!data || typeof data !== "object") {
      return;
    }

    if (data.source === "WEB40_EXTENSION" && data.type === "WEB40_RUNTIME_RESPONSE") {
      const pending = pendingRuntimeRequests.get(data.requestId);
      if (!pending) {
        return;
      }

      pendingRuntimeRequests.delete(data.requestId);
      if (!data.ok) {
        pending.reject(new Error(data.payload?.error || "Web 4.0 runtime request failed."));
        return;
      }

      pending.resolve(data.payload);
    }
  });

  window.Web40 = {
    getPageContext: async () => {
      const response = await requestRuntime("getPageContext");
      return response.snapshot;
    },
    getCapturedApis: async () => requestRuntime("getCapturedApis"),
    callApi: async (request) => {
      const response = await window.fetch(request?.url, buildFetchInit(request));
      const contentType = response.headers.get("content-type") || "";
      const text = await response.text();
      let parsedData = null;

      if (/json/i.test(contentType)) {
        try {
          parsedData = JSON.parse(text);
        } catch (error) {
          parsedData = null;
        }
      }

      return {
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        url: response.url,
        contentType,
        text: clipText(text, 150000),
        data: parsedData,
        headers: serializeHeaders(response.headers)
      };
    },
    log: (message) => {
      postToExtension("WEB40_RUNTIME_LOG", {
        message: String(message || "")
      });
    },
    registerCleanup: (fn) => {
      window.__WEB40_RUNTIME_CLEANUP__ = typeof fn === "function" ? fn : null;
    },
    restoreOriginalView: async () => requestRuntime("restoreOriginalView")
  };

  function requestRuntime(requestType, payload = {}) {
    return new Promise((resolve, reject) => {
      const requestId = `web40-runtime-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      pendingRuntimeRequests.set(requestId, { resolve, reject });

      window.postMessage(
        {
          source: "WEB40_PAGE",
          type: "WEB40_RUNTIME_REQUEST",
          requestId,
          requestType,
          payload
        },
        "*"
      );
    });
  }

  function buildFetchInit(request) {
    const method = String(request?.method || "GET").toUpperCase();
    const init = {
      method,
      headers: request?.headers || {},
      credentials: request?.credentials || "include",
      redirect: request?.redirect || "follow"
    };

    if (!["GET", "HEAD"].includes(method) && request?.body !== undefined) {
      init.body = request.body;
    }

    return init;
  }

  async function readResponsePreview(response) {
    const contentType = response.headers.get("content-type") || "";
    if (!/json|text|javascript|xml|html/i.test(contentType)) {
      return `[non-text response: ${contentType || "unknown"}]`;
    }

    try {
      const text = await response.text();
      return clipText(text, MAX_PREVIEW);
    } catch (error) {
      return `[preview unavailable: ${error.message || String(error)}]`;
    }
  }

  function previewBody(body) {
    if (typeof body === "string") {
      return clipText(body, 1200);
    }

    if (body instanceof URLSearchParams) {
      return clipText(body.toString(), 1200);
    }

    if (body && typeof body === "object" && !(body instanceof FormData) && !(body instanceof Blob)) {
      try {
        return clipText(JSON.stringify(body), 1200);
      } catch (error) {
        return "";
      }
    }

    return "";
  }

  function postToExtension(type, payload) {
    window.postMessage(
      {
        source: "WEB40_PAGE",
        type,
        payload
      },
      "*"
    );
  }

  function serializeHeaders(headers) {
    const output = {};
    headers.forEach((value, key) => {
      if (Object.keys(output).length < 20) {
        output[key] = clipText(value, 240);
      }
    });
    return output;
  }

  function resolveUrl(value) {
    try {
      return new URL(String(value || ""), window.location.href).toString();
    } catch (error) {
      return String(value || "");
    }
  }

  function clipText(text, maxLength) {
    const value = String(text || "");
    return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...`;
  }
})();
