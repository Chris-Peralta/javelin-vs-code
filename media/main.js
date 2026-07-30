// @ts-check
(function () {
  const vscode = acquireVsCodeApi();

  /** @type {HTMLInputElement} */
  const filterInput = document.getElementById("filter");
  const clearButton = document.getElementById("clear");
  const pausedBanner = document.getElementById("pausedBanner");
  const tape = document.getElementById("tape");

  let filterFocused = false;

  function formatTimestamp(ms) {
    return new Date(ms).toLocaleTimeString([], { hour12: false });
  }

  function setShowTimestamps(value) {
    document.body.classList.toggle("show-timestamps", !!value);
  }

  function searchTextFor(entry) {
    return `${entry.outline} ${entry.translation}`.toLowerCase();
  }

  function rowMatchesFilter(row, filterValue) {
    return row.dataset.search.includes(filterValue);
  }

  function renderRow(entry) {
    const row = document.createElement("div");
    row.className = "row";
    row.dataset.search = searchTextFor(entry);

    const timestamp = document.createElement("span");
    timestamp.className = "col-timestamp";
    timestamp.textContent = formatTimestamp(entry.timestamp);

    const outline = document.createElement("span");
    outline.className = "col-outline";
    outline.textContent = entry.outline;

    const translation = document.createElement("span");
    translation.className = "col-translation";
    translation.textContent = entry.translation;
    if (entry.undo) {
      const undoBadge = document.createElement("span");
      undoBadge.className = "undo-badge";
      undoBadge.textContent = `*${entry.undo}`;
      translation.appendChild(undoBadge);
    }

    row.appendChild(timestamp);
    row.appendChild(outline);
    row.appendChild(translation);
    tape.appendChild(row);

    const filterValue = filterInput.value.trim().toLowerCase();
    if (filterValue && !rowMatchesFilter(row, filterValue)) {
      row.classList.add("hidden");
    }

    tape.scrollTop = tape.scrollHeight;
  }

  function addEntry(entry) {
    if (filterFocused) {
      // The filter box is focused: don't add new strokes to the tape.
      return;
    }
    renderRow(entry);
  }

  function applyFilterToExistingRows(filterValue) {
    for (const row of tape.children) {
      row.classList.toggle("hidden", !!filterValue && !rowMatchesFilter(row, filterValue));
    }
  }

  function updatePausedBanner() {
    pausedBanner.classList.toggle("hidden", !filterFocused);
  }

  filterInput.addEventListener("input", () => {
    const filterValue = filterInput.value.trim().toLowerCase();
    applyFilterToExistingRows(filterValue);
  });

  filterInput.addEventListener("focus", () => {
    filterFocused = true;
    updatePausedBanner();
  });

  filterInput.addEventListener("blur", () => {
    filterFocused = false;
    updatePausedBanner();
  });

  clearButton.addEventListener("click", () => {
    tape.innerHTML = "";
    vscode.postMessage({ type: "clear" });
  });

  window.addEventListener("message", (event) => {
    const message = event.data;
    switch (message.type) {
      case "init":
        setShowTimestamps(message.showTimestamps);
        tape.innerHTML = "";
        for (const entry of message.entries) {
          renderRow(entry);
        }
        applyFilterToExistingRows(filterInput.value.trim().toLowerCase());
        break;
      case "append":
        addEntry(message.entry);
        break;
      case "settings":
        setShowTimestamps(message.showTimestamps);
        break;
    }
  });

  updatePausedBanner();
  vscode.postMessage({ type: "ready" });
})();
