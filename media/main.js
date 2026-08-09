// @ts-check
(function () {
  const vscode = acquireVsCodeApi();

  /** @type {HTMLInputElement} */
  const filterInput = document.getElementById("filter");
  const clearButton = document.getElementById("clear");
  const pausedBanner = document.getElementById("pausedBanner");
  const tape = document.getElementById("tape");

  let panelFocused = false;
  let selectedRow = null;
  let rowCounter = 0;

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
    row.id = `tape-row-${rowCounter++}`;
    row.dataset.search = searchTextFor(entry);
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", "false");

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

  function getVisibleRows() {
    return Array.from(tape.querySelectorAll(".row:not(.hidden)"));
  }

  function setSelectedRow(row) {
    if (selectedRow) {
      selectedRow.classList.remove("selected");
      selectedRow.setAttribute("aria-selected", "false");
    }
    selectedRow = row;
    if (selectedRow) {
      selectedRow.classList.add("selected");
      selectedRow.setAttribute("aria-selected", "true");
      tape.setAttribute("aria-activedescendant", selectedRow.id);
      selectedRow.scrollIntoView({ block: "nearest" });
    } else {
      tape.removeAttribute("aria-activedescendant");
    }
  }

  function moveSelection(delta) {
    const rows = getVisibleRows();
    if (rows.length === 0) {
      return;
    }
    const currentIndex = selectedRow ? rows.indexOf(selectedRow) : -1;
    const nextIndex =
      currentIndex === -1
        ? delta > 0
          ? 0
          : rows.length - 1
        : Math.min(rows.length - 1, Math.max(0, currentIndex + delta));
    setSelectedRow(rows[nextIndex]);
  }

  function selectEdgeRow(edge) {
    const rows = getVisibleRows();
    if (rows.length === 0) {
      return;
    }
    setSelectedRow(edge === "first" ? rows[0] : rows[rows.length - 1]);
  }

  function focusLastRow() {
    selectEdgeRow("last");
    tape.focus();
  }

  function pageSize() {
    const rowHeight = selectedRow ? selectedRow.offsetHeight : 18;
    return Math.max(1, Math.floor(tape.clientHeight / rowHeight));
  }

  function addEntry(entry) {
    if (panelFocused) {
      // Some part of the panel is focused: don't add new strokes to the tape.
      return;
    }
    renderRow(entry);
  }

  function applyFilterToExistingRows(filterValue) {
    for (const row of tape.children) {
      row.classList.toggle("hidden", !!filterValue && !rowMatchesFilter(row, filterValue));
    }
    if (selectedRow && selectedRow.classList.contains("hidden")) {
      setSelectedRow(null);
    }
  }

  function updatePausedBanner() {
    pausedBanner.classList.toggle("hidden", !panelFocused);
  }

  function updatePanelFocused() {
    panelFocused = document.hasFocus() && document.activeElement !== document.body;
    updatePausedBanner();
  }

  // focusin/focusout bubble, so this catches focus landing on any element in the
  // panel (filter, tape, clear button), not just the filter input.
  document.addEventListener("focusin", updatePanelFocused);
  document.addEventListener("focusout", () => {
    // The next focused element (if any) hasn't received focus yet when focusout fires.
    setTimeout(updatePanelFocused, 0);
  });
  window.addEventListener("focus", updatePanelFocused);
  window.addEventListener("blur", updatePanelFocused);

  filterInput.addEventListener("input", () => {
    const filterValue = filterInput.value.trim().toLowerCase();
    applyFilterToExistingRows(filterValue);
  });

  filterInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      focusLastRow();
    }
  });

  clearButton.addEventListener("click", () => {
    tape.innerHTML = "";
    selectedRow = null;
    vscode.postMessage({ type: "clear" });
  });

  tape.addEventListener("click", (event) => {
    const target = /** @type {HTMLElement} */ (event.target);
    const row = target.closest(".row");
    if (row && !row.classList.contains("hidden")) {
      setSelectedRow(row);
    }
  });

  tape.addEventListener("keydown", (event) => {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        moveSelection(1);
        break;
      case "ArrowUp":
        event.preventDefault();
        moveSelection(-1);
        break;
      case "PageDown":
        event.preventDefault();
        moveSelection(pageSize());
        break;
      case "PageUp":
        event.preventDefault();
        moveSelection(-pageSize());
        break;
      case "Home":
        event.preventDefault();
        selectEdgeRow("first");
        break;
      case "End":
        event.preventDefault();
        selectEdgeRow("last");
        break;
      case "Escape":
        event.preventDefault();
        setSelectedRow(null);
        break;
    }
  });

  window.addEventListener("message", (event) => {
    const message = event.data;
    switch (message.type) {
      case "init":
        setShowTimestamps(message.showTimestamps);
        tape.innerHTML = "";
        selectedRow = null;
        for (const entry of message.entries) {
          renderRow(entry);
        }
        applyFilterToExistingRows(filterInput.value.trim().toLowerCase());
        focusLastRow();
        break;
      case "append":
        addEntry(message.entry);
        break;
      case "settings":
        setShowTimestamps(message.showTimestamps);
        break;
      case "focusLast":
        focusLastRow();
        break;
    }
  });

  updatePausedBanner();
  vscode.postMessage({ type: "ready" });
})();
