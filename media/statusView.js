// @ts-check
(function () {
  const vscode = acquireVsCodeApi();

  const statusEl = document.getElementById("status");
  const statusText = document.getElementById("statusText");
  const troubleshootingEl = document.getElementById("troubleshooting");
  const connectionErrorText = document.getElementById("connectionErrorText");
  const udevRuleRow = document.getElementById("udevRuleRow");
  const udevRuleText = document.getElementById("udevRuleText");
  const copyUdevRule = document.getElementById("copyUdevRule");
  const showButton = document.getElementById("showPaperTape");
  const lookupInput = document.getElementById("lookupInput");
  const lookupResults = document.getElementById("lookupResults");
  const toggleTimestamps = document.getElementById("toggleTimestamps");
  const toggleBackgroundMonitoring = document.getElementById("toggleBackgroundMonitoring");
  const togglePersistPerWindow = document.getElementById("togglePersistPerWindow");
  const toggleSuggestionsBackgroundMonitoring = document.getElementById(
    "toggleSuggestionsBackgroundMonitoring"
  );
  const logLevelSelect = document.getElementById("logLevel");
  const suggestionsList = document.getElementById("suggestionsList");

  function setStatus(connected, deviceName, error, connectionError, udevRule) {
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

    if (!error && !connected && connectionError) {
      troubleshootingEl.hidden = false;
      connectionErrorText.textContent = connectionError;

      if (udevRule) {
        udevRuleRow.hidden = false;
        udevRuleText.textContent = udevRule;
      } else {
        udevRuleRow.hidden = true;
      }
    } else {
      troubleshootingEl.hidden = true;
    }
  }

  copyUdevRule.addEventListener("click", () => {
    navigator.clipboard.writeText(udevRuleText.textContent ?? "").then(() => {
      const original = copyUdevRule.textContent;
      copyUdevRule.textContent = "Copied";
      setTimeout(() => {
        copyUdevRule.textContent = original;
      }, 1500);
    });
  });

  showButton.addEventListener("click", () => {
    vscode.postMessage({ type: "showPaperTape" });
  });

  function setSettings(
    showTimestamps,
    backgroundMonitoring,
    persistPerWindow,
    suggestionsBackgroundMonitoring,
    logLevel
  ) {
    toggleTimestamps.checked = !!showTimestamps;
    toggleBackgroundMonitoring.checked = !!backgroundMonitoring;
    togglePersistPerWindow.checked = !!persistPerWindow;
    toggleBackgroundMonitoring.disabled = !!persistPerWindow;
    togglePersistPerWindow.disabled = !!backgroundMonitoring;

    toggleSuggestionsBackgroundMonitoring.checked = !!suggestionsBackgroundMonitoring;

    if (logLevel) logLevelSelect.value = logLevel;
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

  togglePersistPerWindow.addEventListener("change", () => {
    vscode.postMessage({
      type: "setPersistPerWindow",
      value: togglePersistPerWindow.checked,
    });
  });

  toggleSuggestionsBackgroundMonitoring.addEventListener("change", () => {
    vscode.postMessage({
      type: "setSuggestionsBackgroundMonitoring",
      value: toggleSuggestionsBackgroundMonitoring.checked,
    });
  });

  logLevelSelect.addEventListener("change", () => {
    vscode.postMessage({ type: "setLogLevel", logLevel: logLevelSelect.value });
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

  const MAX_DISPLAYED_SUGGESTIONS = 50;

  function suggestionHtml(entry) {
    return `
      <div class="suggestionEntry">
        <span class="suggestionOutlines">${escapeHtml(entry.outlines.join(", "))}</span>
        <span class="suggestionTranslation">${escapeHtml(entry.translation)}</span>
      </div>`;
  }

  function renderSuggestions(entries) {
    if (entries.length === 0) {
      suggestionsList.innerHTML = `<div class="lookupMessage">No suggestions yet.</div>`;
      return;
    }
    suggestionsList.innerHTML = entries
      .slice(-MAX_DISPLAYED_SUGGESTIONS)
      .reverse()
      .map(suggestionHtml)
      .join("");
  }

  function appendSuggestion(entry) {
    if (suggestionsList.querySelector(".lookupMessage")) {
      suggestionsList.innerHTML = "";
    }
    suggestionsList.insertAdjacentHTML("afterbegin", suggestionHtml(entry));
    while (suggestionsList.children.length > MAX_DISPLAYED_SUGGESTIONS) {
      suggestionsList.lastElementChild?.remove();
    }
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
      setStatus(
        message.connected,
        message.deviceName,
        message.error,
        message.connectionError,
        message.udevRule
      );
    } else if (message.type === "lookupResults") {
      if (message.requestId < latestReceivedRequestId) return;
      latestReceivedRequestId = message.requestId;
      renderLookupResults(message.results ?? [], message.error);
    } else if (message.type === "settings") {
      setSettings(
        message.showTimestamps,
        message.backgroundMonitoring,
        message.persistPerWindow,
        message.suggestionsBackgroundMonitoring,
        message.logLevel
      );
    } else if (message.type === "suggestions") {
      renderSuggestions(message.entries ?? []);
    } else if (message.type === "suggestion") {
      appendSuggestion(message.entry);
    }
  });

  vscode.postMessage({ type: "ready" });
})();
