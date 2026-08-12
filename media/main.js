// @ts-check
(function () {
  const vscode = acquireVsCodeApi();

  /** @type {HTMLInputElement} */
  const filterInput = document.getElementById("filter");
  const pausedBanner = document.getElementById("pausedBanner");
  const tape = document.getElementById("tape");

  let panelFocused = false;
  let selectedRow = null;
  let rowCounter = 0;
  /** @type {{ finish: (value: string | null) => void } | null} */
  let activeInlineEditor = null;
  // Infinite-scroll-upward state for older history (see the "loadOlder"/"olderEntries" messages).
  let hasMoreOlder = false;
  let loadingOlder = false;
  const LOAD_OLDER_THRESHOLD_PX = 100;

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
    // The ephemeral .row-inserting row has no dataset.search, so it's never subject to filtering.
    return (row.dataset.search ?? "").includes(filterValue);
  }

  /** Keys reserved for the paper tape's VS Code commands - must stay local when typed into a text field within the webview. */
  function isReservedTapeKey(event) {
    const key = event.key.toLowerCase();
    return key === "enter" || key === "f2" || key === "delete";
  }

  function buildRow(entry) {
    const row = document.createElement("div");
    row.className = "row";
    if (entry.kind && entry.kind !== "text") {
      row.classList.add(`kind-${entry.kind}`);
    }
    if (entry.synthetic) {
      row.classList.add("synthetic");
    }
    row.id = `tape-row-${rowCounter++}`;
    row.dataset.search = searchTextFor(entry);
    if (entry.wordId) {
      row.dataset.wordId = entry.wordId;
    }
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
    if (entry.synthetic) {
      const insertedBadge = document.createElement("span");
      insertedBadge.className = "inserted-badge";
      insertedBadge.textContent = "+";
      translation.appendChild(insertedBadge);
    }

    row.appendChild(timestamp);
    row.appendChild(outline);
    row.appendChild(translation);
    return row;
  }

  function applyFilterToRow(row) {
    const filterValue = filterInput.value.trim().toLowerCase();
    if (filterValue && !rowMatchesFilter(row, filterValue)) {
      row.classList.add("hidden");
    }
  }

  function renderRow(entry) {
    const row = buildRow(entry);
    tape.appendChild(row);
    applyFilterToRow(row);
    tape.scrollTop = tape.scrollHeight;
  }

  /** Inserts a page of older entries (oldest first) above everything currently loaded, keepingcontent stable instead of jumping. */
  function prependEntries(entries) {
    if (entries.length === 0) return;

    const previousScrollHeight = tape.scrollHeight;
    const previousScrollTop = tape.scrollTop;

    const fragment = document.createDocumentFragment();
    for (const entry of entries) {
      const row = buildRow(entry);
      applyFilterToRow(row);
      fragment.appendChild(row);
    }
    tape.insertBefore(fragment, tape.firstChild);

    tape.scrollTop = previousScrollTop + (tape.scrollHeight - previousScrollHeight);
  }

  /** If the loaded page doesn't fill the viewport, there's no scrollbar and trigger the next page - so keep pulling pages until it either fills up or history runs out. */
  function fillViewportIfNeeded() {
    if (hasMoreOlder && !loadingOlder && tape.scrollHeight <= tape.clientHeight) {
      requestOlderEntries();
    }
  }

  function requestOlderEntries() {
    if (!hasMoreOlder || loadingOlder) return;
    loadingOlder = true;
    vscode.postMessage({ type: "loadOlder" });
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
    vscode.postMessage({ type: "selectionChanged", wordId: selectedRow?.dataset.wordId ?? null });
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

  function applyWordStatus(update) {
    const rows = tape.querySelectorAll(`.row[data-word-id="${CSS.escape(update.wordId)}"]`);
    for (const row of rows) {
      row.classList.remove("status-edited", "status-deleted");
      row.title = "";
      if (update.state === "edited") {
        row.classList.add("status-edited");
        row.title = `Edited: "${update.originalText ?? ""}" → "${update.currentText}"`;
      } else if (update.state === "deleted") {
        row.classList.add("status-deleted");
      }
    }
  }

  /** Shared plumbing for the inline edit/insert text inputs: wires Enter/Escape/blur and guarantees `cleanup` runs exactly once. */
  function beginInlineInput({ createInput, placeholder, initialValue, cleanup, onSubmit }) {
    closeInlineEditor();

    const input = createInput();
    input.type = "text";
    input.className = "inline-edit";
    if (placeholder) input.placeholder = placeholder;
    if (initialValue !== undefined) input.value = initialValue;

    let settled = false;
    function finish(value) {
      if (settled) return;
      settled = true;
      activeInlineEditor = null;
      cleanup();
      if (value !== null) onSubmit(value);
    }

    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        finish(input.value.trim() || null);
      } else if (event.key === "Escape") {
        event.preventDefault();
        finish(null);
      }
      // Every key stays local to this input, never reaching the tape's nav handler or VS Code's keybinding dispatch.
      event.stopPropagation();
    });
    input.addEventListener("blur", () => finish(null));

    activeInlineEditor = { finish };
    input.focus();
    input.select();
  }

  function closeInlineEditor() {
    activeInlineEditor?.finish(null);
  }

  function beginRowEdit(wordId, currentText) {
    const rows = tape.querySelectorAll(`.row[data-word-id="${CSS.escape(wordId)}"]`);
    const row = /** @type {HTMLElement | undefined} */ (rows[rows.length - 1]);
    const cell = row?.querySelector(".col-translation");
    if (!cell) return;

    // Settle any other open inline editor first, so its cleanup restores the cell's true text before this one snapshots it.
    closeInlineEditor();

    const originalHtml = cell.innerHTML;
    cell.innerHTML = "";

    beginInlineInput({
      createInput: () => {
        const input = document.createElement("input");
        cell.appendChild(input);
        return input;
      },
      initialValue: currentText,
      cleanup: () => {
        cell.innerHTML = originalHtml;
      },
      onSubmit: (text) => vscode.postMessage({ type: "commitEdit", wordId, text }),
    });
  }

  function beginInsertRow(wordId, mode) {
    const row = document.createElement("div");
    row.className = "row row-inserting";
    row.setAttribute("role", "option");
    tape.appendChild(row);
    tape.scrollTop = tape.scrollHeight;

    beginInlineInput({
      createInput: () => {
        const input = document.createElement("input");
        row.appendChild(input);
        return input;
      },
      placeholder: mode === "before" ? "Insert before…" : "Insert after…",
      cleanup: () => row.remove(),
      onSubmit: (text) => vscode.postMessage({ type: "commitInsert", wordId, mode, text }),
    });
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
  // panel (filter, tape), not just the filter input.
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
    if (isReservedTapeKey(event)) {
      // Typing into the filter (e.g. searching for "delete") must never leak out as a paper tape command.
      event.stopPropagation();
    }
  });

  tape.addEventListener("click", (event) => {
    const target = /** @type {HTMLElement} */ (event.target);
    const row = target.closest(".row");
    if (row && !row.classList.contains("hidden")) {
      setSelectedRow(row);
      if (row.dataset.wordId) {
        vscode.postMessage({ type: "wordAction", action: "peek", wordId: row.dataset.wordId });
      }
    }
  });

  tape.addEventListener("dblclick", (event) => {
    const target = /** @type {HTMLElement} */ (event.target);
    const row = target.closest(".row");
    if (row && !row.classList.contains("hidden") && row.dataset.wordId) {
      vscode.postMessage({ type: "wordAction", action: "edit", wordId: row.dataset.wordId });
    }
  });

  tape.addEventListener("scroll", () => {
    if (tape.scrollTop > LOAD_OLDER_THRESHOLD_PX) return;
    requestOlderEntries();
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
      // No case for the reserved tape keys: left unhandled so they bubble out to VS Code's keybinding dispatch.
    }
  });

  window.addEventListener("message", (event) => {
    const message = event.data;
    switch (message.type) {
      case "init":
        setShowTimestamps(message.showTimestamps);
        tape.innerHTML = "";
        selectedRow = null;
        hasMoreOlder = !!message.hasMore;
        loadingOlder = false;
        for (const entry of message.entries) {
          renderRow(entry);
        }
        applyFilterToExistingRows(filterInput.value.trim().toLowerCase());
        focusLastRow();
        fillViewportIfNeeded();
        break;
      case "olderEntries":
        prependEntries(message.entries);
        hasMoreOlder = !!message.hasMore;
        loadingOlder = false;
        fillViewportIfNeeded();
        break;
      case "append":
        addEntry(message.entry);
        break;
      case "clear":
        tape.innerHTML = "";
        selectedRow = null;
        hasMoreOlder = false;
        loadingOlder = false;
        break;
      case "settings":
        setShowTimestamps(message.showTimestamps);
        break;
      case "focusLast":
        focusLastRow();
        break;
      case "wordStatus":
        for (const update of message.updates) {
          applyWordStatus(update);
        }
        break;
      case "beginEdit":
        beginRowEdit(message.wordId, message.currentText);
        break;
      case "beginInsert":
        beginInsertRow(message.wordId, message.mode);
        break;
    }
  });

  updatePausedBanner();
  vscode.postMessage({ type: "ready" });
})();
