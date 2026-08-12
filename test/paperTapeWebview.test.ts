import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { JSDOM, type DOMWindow } from "jsdom";

const mainJsSource = fs.readFileSync(path.join(__dirname, "..", "media", "main.js"), "utf8");

// Mirrors the elements PaperTapePanel.getHtml() renders in src/paperTapePanel.ts.
const PANEL_HTML = `
  <div id="toolbar">
    <input id="filter" type="text" />
  </div>
  <div id="pausedBanner" class="hidden"></div>
  <div id="tapeHeader"></div>
  <div id="tape" tabindex="0" role="listbox"></div>
`;

function createPanel(): {
  window: DOMWindow;
  tape: HTMLElement;
  filterInput: HTMLInputElement;
  postedMessages: unknown[];
} {
  const dom = new JSDOM(`<!doctype html><body>${PANEL_HTML}</body></html>`, {
    runScripts: "outside-only",
  });
  const window = dom.window;
  const postedMessages: unknown[] = [];
  (window as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({
    postMessage: (message: unknown) => postedMessages.push(message),
    getState: () => undefined,
    setState: () => {},
  });
  // jsdom doesn't implement scrollIntoView; main.js calls it whenever a row is selected.
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.eval(mainJsSource);
  return {
    window,
    tape: window.document.getElementById("tape") as HTMLElement,
    filterInput: window.document.getElementById("filter") as HTMLInputElement,
    postedMessages,
  };
}

function appendEntry(
  window: DOMWindow,
  translation: string,
  outline = "H-L",
  overrides: Record<string, unknown> = {}
): void {
  window.dispatchEvent(
    new window.MessageEvent("message", {
      data: { type: "append", entry: { timestamp: Date.now(), outline, translation, ...overrides } },
    })
  );
}

function visibleRows(tape: HTMLElement): Element[] {
  return Array.from(tape.querySelectorAll(".row:not(.hidden)"));
}

function selectedRow(tape: HTMLElement): Element | null {
  return tape.querySelector(".row.selected");
}

function pressKey(window: DOMWindow, target: HTMLElement, key: string): void {
  target.dispatchEvent(new window.KeyboardEvent("keydown", { key, cancelable: true }));
}

function click(window: DOMWindow, target: Element): void {
  target.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
}

function setFilter(window: DOMWindow, filterInput: HTMLInputElement, value: string): void {
  filterInput.value = value;
  filterInput.dispatchEvent(new window.Event("input", { bubbles: true }));
}

test("does not write new strokes to the tape while it has focus", () => {
  const { window, tape } = createPanel();

  appendEntry(window, "before focus");
  assert.equal(tape.children.length, 1, "sanity check: entries append normally when unfocused");

  tape.focus();
  appendEntry(window, "while focused");
  assert.equal(tape.children.length, 1, "no new row should be written while the tape has focus");
});

test("resumes writing strokes once focus leaves the tape", async () => {
  const { window, tape } = createPanel();

  tape.focus();
  appendEntry(window, "while focused");
  assert.equal(tape.children.length, 0, "sanity check: focused tape should have dropped the stroke");

  tape.blur();
  // focusout handling is deferred via setTimeout(0) in main.js
  await new Promise((resolve) => setTimeout(resolve, 0));

  appendEntry(window, "after blur");
  assert.equal(tape.children.length, 1, "entries should resume once focus leaves the panel");
});

test("a clear message empties the tape, e.g. after the store's entries and anchors were wiped", () => {
  const { window, tape } = createPanel();
  appendEntry(window, "one");
  appendEntry(window, "two");
  assert.equal(tape.children.length, 2);

  window.dispatchEvent(new window.MessageEvent("message", { data: { type: "clear" } }));

  assert.equal(tape.children.length, 0);
  appendEntry(window, "after clear");
  assert.equal(tape.children.length, 1, "the tape should still accept new rows after a clear");
});

test("does not write new strokes to the tape while the filter box has focus", () => {
  const { window, tape, filterInput } = createPanel();

  filterInput.focus();
  appendEntry(window, "while filter focused");
  assert.equal(tape.children.length, 0, "focusing any part of the panel should pause writes, not just the tape");
});

test("ArrowDown/ArrowUp move the selection and clamp at the boundaries instead of wrapping", () => {
  const { window, tape } = createPanel();
  appendEntry(window, "one");
  appendEntry(window, "two");
  appendEntry(window, "three");
  const rows = visibleRows(tape);

  pressKey(window, tape, "ArrowDown");
  assert.equal(selectedRow(tape), rows[0], "first ArrowDown selects the first row");

  pressKey(window, tape, "ArrowDown");
  pressKey(window, tape, "ArrowDown");
  assert.equal(selectedRow(tape), rows[2], "ArrowDown walks forward through the rows");

  pressKey(window, tape, "ArrowDown");
  assert.equal(selectedRow(tape), rows[2], "ArrowDown past the last row clamps instead of wrapping to the first");

  pressKey(window, tape, "ArrowUp");
  pressKey(window, tape, "ArrowUp");
  pressKey(window, tape, "ArrowUp");
  assert.equal(selectedRow(tape), rows[0], "ArrowUp walks backward through the rows");

  pressKey(window, tape, "ArrowUp");
  assert.equal(selectedRow(tape), rows[0], "ArrowUp past the first row clamps instead of wrapping to the last");
});

test("Home/End select the first/last visible row", () => {
  const { window, tape } = createPanel();
  appendEntry(window, "one");
  appendEntry(window, "two");
  appendEntry(window, "three");
  const rows = visibleRows(tape);

  pressKey(window, tape, "End");
  assert.equal(selectedRow(tape), rows[2]);

  pressKey(window, tape, "Home");
  assert.equal(selectedRow(tape), rows[0]);
});

test("Escape clears the selection", () => {
  const { window, tape } = createPanel();
  appendEntry(window, "one");
  appendEntry(window, "two");

  pressKey(window, tape, "End");
  assert.ok(selectedRow(tape), "sanity check: a row is selected");

  pressKey(window, tape, "Escape");
  assert.equal(selectedRow(tape), null, "Escape should clear the selection");
  assert.equal(tape.hasAttribute("aria-activedescendant"), false);
});

test("filtering out the selected row clears the selection", () => {
  const { window, tape, filterInput } = createPanel();
  appendEntry(window, "alpha", "A");
  appendEntry(window, "beta", "B");
  appendEntry(window, "gamma", "C");

  pressKey(window, tape, "Home");
  assert.equal(selectedRow(tape)?.textContent?.includes("alpha"), true, "sanity check: first row (alpha) is selected");

  setFilter(window, filterInput, "gamma");
  assert.equal(selectedRow(tape), null, "the selection should clear once its row is hidden by the filter");
  assert.equal(tape.hasAttribute("aria-activedescendant"), false);
});

test("clicking a visible row selects it and sets aria-activedescendant", () => {
  const { window, tape } = createPanel();
  appendEntry(window, "one");
  appendEntry(window, "two");
  const rows = visibleRows(tape);

  click(window, rows[1]);
  assert.equal(selectedRow(tape), rows[1]);
  assert.equal(tape.getAttribute("aria-activedescendant"), rows[1].id);
});

test("clicking a filtered-out row does not select it", () => {
  const { window, tape, filterInput } = createPanel();
  appendEntry(window, "alpha", "A");
  appendEntry(window, "beta", "B");
  const hiddenRow = tape.querySelector(".row"); // "alpha" - will be hidden below

  setFilter(window, filterInput, "beta");
  assert.ok(hiddenRow?.classList.contains("hidden"), "sanity check: the alpha row is hidden by the filter");

  click(window, hiddenRow!);
  assert.equal(selectedRow(tape), null, "clicking a hidden row must not select it");
});

// jsdom's window has its own realm, so a plain-object round trip normalizes messages before deepEqual compares prototypes.
function lastPostedMessage(postedMessages: unknown[]): unknown {
  return JSON.parse(JSON.stringify(postedMessages.at(-1)));
}

// These keys are reserved for VS Code commands - the webview must leave them alone so they bubble out to keybinding dispatch.
test("Enter/Shift+Enter/F2/Delete/Ctrl+Enter/Ctrl+Shift+Enter are not captured by the tape", () => {
  const { window, tape } = createPanel();
  appendEntry(window, "world", "TPHOULD", { wordId: "w1" });
  pressKey(window, tape, "End");

  const combos: [string, Partial<KeyboardEventInit>][] = [
    ["Enter", {}],
    ["Enter", { shiftKey: true }],
    ["F2", {}],
    ["Delete", {}],
    ["Enter", { ctrlKey: true }],
    ["Enter", { ctrlKey: true, shiftKey: true }],
  ];
  for (const [key, modifiers] of combos) {
    const event = new window.KeyboardEvent("keydown", { key, cancelable: true, ...modifiers });
    tape.dispatchEvent(event);
    assert.equal(event.defaultPrevented, false, `${key} with ${JSON.stringify(modifiers)} must not be prevented`);
  }
});

test("selecting a row posts a selectionChanged message with its wordId", () => {
  const { window, tape, postedMessages } = createPanel();
  appendEntry(window, "world", "TPHOULD", { wordId: "w1" });

  pressKey(window, tape, "End");

  assert.deepEqual(lastPostedMessage(postedMessages), { type: "selectionChanged", wordId: "w1" });
});

test("clearing the selection posts a selectionChanged message with a null wordId", () => {
  const { window, tape, postedMessages } = createPanel();
  appendEntry(window, "world", "TPHOULD", { wordId: "w1" });
  pressKey(window, tape, "End");

  pressKey(window, tape, "Escape");

  assert.deepEqual(lastPostedMessage(postedMessages), { type: "selectionChanged", wordId: null });
});

test("clicking a row selects it and posts a peek wordAction", () => {
  const { window, tape, postedMessages } = createPanel();
  appendEntry(window, "world", "TPHOULD", { wordId: "w1" });
  const [row] = visibleRows(tape);

  click(window, row);

  assert.deepEqual(lastPostedMessage(postedMessages), { type: "wordAction", action: "peek", wordId: "w1" });
});

test("double-clicking a row posts an edit wordAction", () => {
  const { window, tape, postedMessages } = createPanel();
  appendEntry(window, "world", "TPHOULD", { wordId: "w1" });
  const [row] = visibleRows(tape);

  row.dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true }));

  assert.deepEqual(lastPostedMessage(postedMessages), { type: "wordAction", action: "edit", wordId: "w1" });
});

test("clicking a row with no word (e.g. a command/keyboard entry) selects it but posts no wordAction", () => {
  const { window, tape, postedMessages } = createPanel();
  appendEntry(window, "{#Escape}{^}", "EFBG", { kind: "keyboard" });
  const [row] = visibleRows(tape);

  click(window, row);

  assert.equal(selectedRow(tape), row);
  assert.deepEqual(lastPostedMessage(postedMessages), { type: "selectionChanged", wordId: null });
});

test("a beginEdit message opens an inline input on the word's row, pre-filled with its current text", () => {
  const { window, tape } = createPanel();
  appendEntry(window, "world", "TPHOULD", { wordId: "w1" });
  const [row] = visibleRows(tape);

  window.dispatchEvent(
    new window.MessageEvent("message", {
      data: { type: "beginEdit", wordId: "w1", currentText: "world" },
    })
  );

  const input = row.querySelector<HTMLInputElement>(".inline-edit");
  assert.ok(input, "an inline input should appear on the row");
  assert.equal(input!.value, "world");
});

test("committing an inline edit posts commitEdit and restores the row's original content", () => {
  const { window, tape, postedMessages } = createPanel();
  appendEntry(window, "world", "TPHOULD", { wordId: "w1" });
  const [row] = visibleRows(tape);

  window.dispatchEvent(
    new window.MessageEvent("message", { data: { type: "beginEdit", wordId: "w1", currentText: "world" } })
  );
  const input = row.querySelector<HTMLInputElement>(".inline-edit")!;
  input.value = "worlds";
  input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", cancelable: true, bubbles: true }));

  assert.deepEqual(lastPostedMessage(postedMessages), { type: "commitEdit", wordId: "w1", text: "worlds" });
  assert.equal(row.querySelector(".inline-edit"), null, "the inline input should be gone");
  assert.match(row.querySelector(".col-translation")!.textContent ?? "", /world/);
});

test("re-invoking beginEdit on the same row before committing does not corrupt the restored text", () => {
  const { window, tape } = createPanel();
  appendEntry(window, "world", "TPHOULD", { wordId: "w1" });
  const [row] = visibleRows(tape);

  window.dispatchEvent(
    new window.MessageEvent("message", { data: { type: "beginEdit", wordId: "w1", currentText: "world" } })
  );
  window.dispatchEvent(
    new window.MessageEvent("message", { data: { type: "beginEdit", wordId: "w1", currentText: "world" } })
  );

  const input = row.querySelector<HTMLInputElement>(".inline-edit")!;
  input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", cancelable: true, bubbles: true }));

  assert.equal(row.querySelector(".inline-edit"), null, "no leftover input should remain");
  assert.equal(row.querySelector(".col-translation")!.textContent, "world");
});

test("Escape cancels an inline edit without posting anything", () => {
  const { window, tape, postedMessages } = createPanel();
  appendEntry(window, "world", "TPHOULD", { wordId: "w1" });
  const [row] = visibleRows(tape);

  window.dispatchEvent(
    new window.MessageEvent("message", { data: { type: "beginEdit", wordId: "w1", currentText: "world" } })
  );
  const countBeforeEscape = postedMessages.length;
  const input = row.querySelector<HTMLInputElement>(".inline-edit")!;
  input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", cancelable: true, bubbles: true }));

  assert.equal(postedMessages.length, countBeforeEscape);
  assert.equal(row.querySelector(".inline-edit"), null);
});

test("a beginInsert message opens a new inline input row, which posts commitInsert on Enter", () => {
  const { window, tape, postedMessages } = createPanel();
  appendEntry(window, "world", "TPHOULD", { wordId: "w1" });

  window.dispatchEvent(
    new window.MessageEvent("message", { data: { type: "beginInsert", wordId: "w1", mode: "before" } })
  );

  const insertingRow = tape.querySelector(".row-inserting");
  assert.ok(insertingRow, "an inserting row should appear");
  const input = insertingRow!.querySelector<HTMLInputElement>(".inline-edit")!;
  input.value = "official";
  input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", cancelable: true, bubbles: true }));

  assert.deepEqual(lastPostedMessage(postedMessages), {
    type: "commitInsert",
    wordId: "w1",
    mode: "before",
    text: "official",
  });
  assert.equal(tape.querySelector(".row-inserting"), null);
});

test("filtering while the ephemeral insert row is open does not throw", () => {
  const { window, tape, filterInput } = createPanel();
  appendEntry(window, "world", "TPHOULD", { wordId: "w1" });
  window.dispatchEvent(
    new window.MessageEvent("message", { data: { type: "beginInsert", wordId: "w1", mode: "before" } })
  );

  assert.doesNotThrow(() => setFilter(window, filterInput, "wor"));

  assert.ok(tape.querySelector(".row-inserting"), "the insert row should still exist, whether hidden or not");
});

test("a wordStatus message marks every row sharing that word as edited, with a tooltip", () => {
  const { window, tape } = createPanel();
  appendEntry(window, "dock", "TKOBG", { wordId: "w1" });
  appendEntry(window, "document", "-PLT", { wordId: "w1" });

  window.dispatchEvent(
    new window.MessageEvent("message", {
      data: {
        type: "wordStatus",
        updates: [{ wordId: "w1", state: "edited", currentText: "documents", originalText: "document" }],
      },
    })
  );

  const rows = Array.from(tape.querySelectorAll('.row[data-word-id="w1"]'));
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.ok(row.classList.contains("status-edited"));
    assert.match((row as HTMLElement).title, /document.*documents/);
  }
});

test("a wordStatus message marks a deleted word's row with strikethrough", () => {
  const { window, tape } = createPanel();
  appendEntry(window, "world", "TPHOULD", { wordId: "w1" });

  window.dispatchEvent(
    new window.MessageEvent("message", {
      data: { type: "wordStatus", updates: [{ wordId: "w1", state: "deleted" }] },
    })
  );

  assert.ok(tape.querySelector('.row[data-word-id="w1"]')?.classList.contains("status-deleted"));
});

function sendMessage(window: DOMWindow, data: unknown): void {
  window.dispatchEvent(new window.MessageEvent("message", { data }));
}

function pageEntries(count: number, startTimestamp: number): { timestamp: number; outline: string; translation: string }[] {
  return Array.from({ length: count }, (_, i) => ({
    timestamp: startTimestamp + i,
    outline: "TH",
    translation: `w${startTimestamp + i}`,
  }));
}

function loadOlderCount(postedMessages: unknown[]): number {
  return postedMessages.filter((m) => (m as { type?: string }).type === "loadOlder").length;
}

/** Shadows jsdom's hardcoded-0 layout getters so the panel sees an already-scrollable viewport, isolating the scroll listener from the init/olderEntries auto-fill check (which would otherwise always fire in a real 0-height jsdom layout). */
function makeScrollable(tape: HTMLElement): void {
  Object.defineProperty(tape, "clientHeight", { value: 50, configurable: true });
  Object.defineProperty(tape, "scrollHeight", { value: 500, configurable: true });
}

test("init with hasMore true automatically requests another page when the loaded page doesn't fill the viewport", () => {
  const { window, postedMessages } = createPanel();

  sendMessage(window, { type: "init", entries: pageEntries(2, 10), hasMore: true, showTimestamps: false });

  assert.equal(loadOlderCount(postedMessages), 1);
});

test("init with hasMore false does not request further pages", () => {
  const { window, postedMessages } = createPanel();

  sendMessage(window, { type: "init", entries: pageEntries(2, 10), hasMore: false, showTimestamps: false });

  assert.equal(loadOlderCount(postedMessages), 0);
});

test("an olderEntries message prepends rows above the existing ones, oldest first", () => {
  const { window, tape } = createPanel();
  makeScrollable(tape); // avoid the auto-fill request reordering things before the explicit olderEntries below

  sendMessage(window, { type: "init", entries: pageEntries(2, 10), hasMore: true, showTimestamps: false });
  sendMessage(window, { type: "olderEntries", entries: pageEntries(2, 8), hasMore: false });

  const translations = Array.from(tape.querySelectorAll(".row")).map(
    (row) => row.querySelector(".col-translation")?.textContent
  );
  assert.deepEqual(translations, ["w8", "w9", "w10", "w11"]);
});

test("automatic page-filling stops once hasMore becomes false", () => {
  const { window, postedMessages } = createPanel();

  sendMessage(window, { type: "init", entries: pageEntries(2, 10), hasMore: true, showTimestamps: false });
  assert.equal(loadOlderCount(postedMessages), 1, "sanity: the first automatic request happened");

  sendMessage(window, { type: "olderEntries", entries: pageEntries(2, 8), hasMore: false });

  assert.equal(loadOlderCount(postedMessages), 1, "no further requests once hasMore is false");
});

test("scrolling near the top requests another page when more history is available", () => {
  const { window, tape, postedMessages } = createPanel();
  makeScrollable(tape);

  sendMessage(window, { type: "init", entries: pageEntries(2, 10), hasMore: true, showTimestamps: false });
  assert.equal(loadOlderCount(postedMessages), 0, "sanity: nothing requested yet - the viewport already looks filled");

  tape.scrollTop = 0;
  tape.dispatchEvent(new window.Event("scroll"));

  assert.equal(loadOlderCount(postedMessages), 1);
});

test("scrolling while not near the top does not request another page", () => {
  const { window, tape, postedMessages } = createPanel();
  makeScrollable(tape);

  sendMessage(window, { type: "init", entries: pageEntries(2, 10), hasMore: true, showTimestamps: false });

  tape.scrollTop = 400;
  tape.dispatchEvent(new window.Event("scroll"));

  assert.equal(loadOlderCount(postedMessages), 0);
});

test("a second scroll event while a page is already loading does not send a duplicate request", () => {
  const { window, tape, postedMessages } = createPanel();
  makeScrollable(tape);

  sendMessage(window, { type: "init", entries: pageEntries(2, 10), hasMore: true, showTimestamps: false });
  tape.scrollTop = 0;
  tape.dispatchEvent(new window.Event("scroll"));
  assert.equal(loadOlderCount(postedMessages), 1);

  tape.dispatchEvent(new window.Event("scroll")); // still "loading" - the extension hasn't responded yet

  assert.equal(loadOlderCount(postedMessages), 1, "no duplicate request while one is already in flight");
});
