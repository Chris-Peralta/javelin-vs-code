// @ts-check
(function () {
  const vscode = acquireVsCodeApi();

  const statusEl = document.getElementById("status");
  const statusText = document.getElementById("statusText");
  const showButton = document.getElementById("showPaperTape");
  const lookupInput = document.getElementById("lookupInput");
  const lookupResults = document.getElementById("lookupResults");
  const toggleTimestamps = document.getElementById("toggleTimestamps");
  const toggleBackgroundMonitoring = document.getElementById("toggleBackgroundMonitoring");

  function setStatus(connected, deviceName, error) {
    if (error) {
      statusEl.className = "disconnected";
      statusText.textContent = error;
    } else if (connected) {
      statusEl.className = "connected";
      statusText.textContent = deviceName ? `Connected — ${deviceName}` : "Connected";
    } else {
      statusEl.className = "disconnected";
      statusText.textContent = "Disconnected";
    }
  }

  showButton.addEventListener("click", () => {
    vscode.postMessage({ type: "showPaperTape" });
  });

  function setSettings(showTimestamps, backgroundMonitoring) {
    toggleTimestamps.checked = !!showTimestamps;
    toggleBackgroundMonitoring.checked = !!backgroundMonitoring;
  }

  toggleTimestamps.addEventListener("change", () => {
    vscode.postMessage({ type: "setShowTimestamps", value: toggleTimestamps.checked });
  });

  toggleBackgroundMonitoring.addEventListener("change", () => {
    vscode.postMessage({
      type: "setBackgroundMonitoring",
      value: toggleBackgroundMonitoring.checked,
    });
  });

  let requestId = 0;
  let debounceTimer;

  function escapeHtml(str) {
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function renderLookupResults(results, error) {
    if (error) {
      lookupResults.innerHTML = `<div class="lookupMessage">${escapeHtml(error)}</div>`;
      return;
    }

    if (!lookupInput.value.trim()) {
      lookupResults.innerHTML = "";
      return;
    }

    if (results.length === 0) {
      lookupResults.innerHTML = `<div class="lookupMessage">No outlines found.</div>`;
      return;
    }

    lookupResults.innerHTML = results
      .map(
        (r) => `
      <div class="lookupResult">
        <span class="lookupOutline">${escapeHtml(r.outline)}</span>
        <span class="lookupDictionary">${escapeHtml(r.dictionary ?? "unknown")}</span>
      </div>`
      )
      .join("");
  }

  lookupInput.addEventListener("input", () => {
    clearTimeout(debounceTimer);
    const text = lookupInput.value;

    if (!text.trim()) {
      lookupResults.innerHTML = "";
      return;
    }

    debounceTimer = setTimeout(() => {
      requestId += 1;
      vscode.postMessage({ type: "lookup", text, requestId });
    }, 200);
  });

  let latestReceivedRequestId = 0;

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (message.type === "status") {
      setStatus(message.connected, message.deviceName, message.error);
    } else if (message.type === "lookupResults") {
      if (message.requestId < latestReceivedRequestId) return;
      latestReceivedRequestId = message.requestId;
      renderLookupResults(message.results ?? [], message.error);
    } else if (message.type === "settings") {
      setSettings(message.showTimestamps, message.backgroundMonitoring);
    }
  });

  vscode.postMessage({ type: "ready" });
})();
