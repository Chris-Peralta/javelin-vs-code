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

function createPanel(): { window: DOMWindow; tape: HTMLElement; filterInput: HTMLInputElement } {
  const dom = new JSDOM(`<!doctype html><body>${PANEL_HTML}</body></html>`, {
    runScripts: "outside-only",
  });
  const window = dom.window;
  (window as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({
    postMessage: () => {},
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
  };
}

function appendEntry(window: DOMWindow, translation: string, outline = "H-L"): void {
  window.dispatchEvent(
    new window.MessageEvent("message", {
      data: { type: "append", entry: { timestamp: Date.now(), outline, translation } },
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
