(function web40UiCommon() {
  function sendMessage(type, payload = {}) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type, ...payload }, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }

        if (!response?.ok) {
          reject(new Error(response?.error?.message || "Web 4.0 request failed."));
          return;
        }

        resolve(response.result);
      });
    });
  }

  function clipText(value, maxLength) {
    const text = String(value || "");
    return text.length <= maxLength ? text : `${text.slice(0, maxLength)}...`;
  }

  function escapeHtml(text) {
    return String(text || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function formatTimestamp(value) {
    if (!value) {
      return "Not yet";
    }

    try {
      return new Date(value).toLocaleString();
    } catch (error) {
      return value;
    }
  }

  window.Web40UI = {
    sendMessage,
    clipText,
    escapeHtml,
    formatTimestamp
  };
})();
