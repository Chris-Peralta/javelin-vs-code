import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type * as vscode from "vscode";
import { PaperTapeRecorder, type PaperTapeEntry } from "../src/paperTapeRecorder";
import type { JavelinHidDevice, JavPaperTapeEventDetail } from "../src/javelinHidDevice";
import { JavelinSettings, type JavelinSettingsSnapshot } from "../src/settings";
import { FakePaperTapeStore } from "./fakePaperTapeStore";

/** Stands in for JavelinHidDevice: records listeners and lets tests fire fake strokes. */
class FakeDevice {
  private readonly listeners = new Map<string, Set<(ev: CustomEvent<JavPaperTapeEventDetail>) => void>>();

  on(type: string, listener: (ev: CustomEvent<JavPaperTapeEventDetail>) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }

  off(type: string, listener: (ev: CustomEvent<JavPaperTapeEventDetail>) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  strike(outline = "TH", translation = "this"): void {
    const detail: JavPaperTapeEventDetail = { outline, dictionary: "main.json", translation, undo: 0, raw: "" };
    for (const listener of this.listeners.get("paper_tape") ?? []) {
      listener(new CustomEvent("paper_tape", { detail }));
    }
  }
}

function makeSettings(initial: Partial<JavelinSettingsSnapshot> = {}): JavelinSettings {
  // Own storage dir per call - these tests don't exercise cross-window settings sync.
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "javelin-recorder-settings-"));
  if (Object.keys(initial).length > 0) {
    fs.writeFileSync(
      path.join(storageDir, "settings.json"),
      JSON.stringify({ showTimestamps: false, backgroundMonitoring: false, persistPerWindow: false, ...initial })
    );
  }
  return new JavelinSettings({ globalStorageUri: { fsPath: storageDir } } as unknown as vscode.ExtensionContext);
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test("records a stroke while focused, with backgroundMonitoring off", () => {
  const device = new FakeDevice();
  const recorder = new PaperTapeRecorder(device as unknown as JavelinHidDevice, makeSettings(), () => true);

  device.strike("TH", "this");

  assert.equal(recorder.getEntries().length, 1);
  assert.equal(recorder.getEntries()[0].translation, "this");
});

test("appendSynthetic records a placeholder entry for a manually inserted word", () => {
  const recorder = new PaperTapeRecorder(undefined, makeSettings(), () => true);

  const entry = recorder.appendSynthetic("official", "file:///doc.txt");

  assert.equal(recorder.getEntries().length, 1);
  assert.equal(recorder.getEntries()[0], entry);
  assert.equal(entry.outline, "");
  assert.equal(entry.dictionary, "");
  assert.equal(entry.translation, "official");
  assert.equal(entry.synthetic, true);
  assert.equal(entry.documentUri, "file:///doc.txt");
  assert.ok(entry.wordId, "it should still be grouped into a word, like a real stroke");
});

test("appendSynthetic notifies onAppend listeners, same as a real stroke", () => {
  const recorder = new PaperTapeRecorder(undefined, makeSettings(), () => true);
  const appended: string[] = [];
  recorder.onAppend((entry) => appended.push(entry.translation));

  recorder.appendSynthetic("official", "file:///doc.txt");

  assert.deepEqual(appended, ["official"]);
});

test("a throwing onWordUpdated listener does not prevent the stroke from being recorded", () => {
  // A failure in a downstream listener must never silently drop entries from the tape's immutable raw record.
  const device = new FakeDevice();
  const recorder = new PaperTapeRecorder(device as unknown as JavelinHidDevice, makeSettings(), () => true);
  recorder.onWordUpdated(() => {
    throw new Error("simulated failure in a downstream listener (e.g. anchor tracking)");
  });

  device.strike("TH", "this");

  assert.equal(recorder.getEntries().length, 1);
  assert.equal(recorder.getEntries()[0].translation, "this");
});

test("does not record while unfocused, with backgroundMonitoring off", () => {
  const device = new FakeDevice();
  const recorder = new PaperTapeRecorder(device as unknown as JavelinHidDevice, makeSettings(), () => false);

  device.strike();

  assert.equal(recorder.getEntries().length, 0);
});

test("records even while unfocused when backgroundMonitoring is on", () => {
  const device = new FakeDevice();
  const settings = makeSettings({ backgroundMonitoring: true });
  const recorder = new PaperTapeRecorder(device as unknown as JavelinHidDevice, settings, () => false);

  device.strike();

  assert.equal(recorder.getEntries().length, 1);
});

test("does not record when onlyRecordWhileEditingFile is on and no file is being edited", () => {
  const device = new FakeDevice();
  const settings = makeSettings({ onlyRecordWhileEditingFile: true });
  const recorder = new PaperTapeRecorder(
    device as unknown as JavelinHidDevice,
    settings,
    () => true,
    undefined,
    () => false
  );

  device.strike();

  assert.equal(recorder.getEntries().length, 0);
});

test("records when onlyRecordWhileEditingFile is on and a file is being edited", () => {
  const device = new FakeDevice();
  const settings = makeSettings({ onlyRecordWhileEditingFile: true });
  const recorder = new PaperTapeRecorder(
    device as unknown as JavelinHidDevice,
    settings,
    () => true,
    undefined,
    () => true
  );

  device.strike();

  assert.equal(recorder.getEntries().length, 1);
});

test("records regardless of the active editor when onlyRecordWhileEditingFile is off", () => {
  const device = new FakeDevice();
  const recorder = new PaperTapeRecorder(
    device as unknown as JavelinHidDevice,
    makeSettings(),
    () => true,
    undefined,
    () => false
  );

  device.strike();

  assert.equal(recorder.getEntries().length, 1);
});

function persistedEntry(overrides: Partial<PaperTapeEntry> & Pick<PaperTapeEntry, "id" | "translation" | "timestamp">): PaperTapeEntry {
  return { outline: "TH", dictionary: "main.json", undo: 0, kind: "text", ...overrides };
}

test("does not persist to the store when persistPerWindow is off", async () => {
  const device = new FakeDevice();
  const store = new FakePaperTapeStore();
  const recorder = new PaperTapeRecorder(device as unknown as JavelinHidDevice, makeSettings(), () => true, store);

  device.strike();
  recorder.dispose();
  await flushMicrotasks();

  assert.deepEqual(store.loadEntries(), []);
});

test("persists new entries to the store when persistPerWindow is on", async () => {
  const device = new FakeDevice();
  const store = new FakePaperTapeStore();
  const settings = makeSettings({ persistPerWindow: true });
  const recorder = new PaperTapeRecorder(device as unknown as JavelinHidDevice, settings, () => true, store);

  device.strike("TH", "this");
  device.strike("KWRO", "you");
  // dispose() flushes the debounced write immediately instead of waiting out the
  // 500ms debounce, so the test doesn't need a real (or mocked) timer wait.
  recorder.dispose();
  await flushMicrotasks();

  assert.deepEqual(
    store.loadEntries().map((e) => e.translation),
    ["this", "you"]
  );
});

test("loads previously persisted entries on construction when persistPerWindow is on", () => {
  const store = new FakePaperTapeStore();
  store.appendEntry(persistedEntry({ id: 1, translation: "this", timestamp: 1 }));
  store.appendEntry(persistedEntry({ id: 2, translation: "you", timestamp: 2 }));
  const settings = makeSettings({ persistPerWindow: true });
  const recorder = new PaperTapeRecorder(undefined, settings, () => true, store);

  assert.deepEqual(
    recorder.getEntries().map((e) => e.translation),
    ["this", "you"]
  );
});

test("does not load previously persisted entries when persistPerWindow is off", () => {
  const store = new FakePaperTapeStore();
  store.appendEntry(persistedEntry({ id: 1, translation: "this", timestamp: 1 }));
  const recorder = new PaperTapeRecorder(undefined, makeSettings(), () => true, store);

  assert.equal(recorder.getEntries().length, 0);
});

test("a stroke recorded after loading persisted entries gets a fresh, non-colliding id", () => {
  const store = new FakePaperTapeStore();
  store.appendEntry(persistedEntry({ id: 1, translation: "this", timestamp: 1 }));
  store.appendEntry(persistedEntry({ id: 5, translation: "you", timestamp: 2 }));
  const device = new FakeDevice();
  const settings = makeSettings({ persistPerWindow: true });
  const recorder = new PaperTapeRecorder(device as unknown as JavelinHidDevice, settings, () => true, store);

  device.strike("PWAOEUP", "paper");

  const ids = recorder.getEntries().map((e) => e.id);
  assert.deepEqual(ids, [1, 5, 6]);
});

test("clear() empties the tape and persists the cleared state", async () => {
  const device = new FakeDevice();
  const store = new FakePaperTapeStore();
  const settings = makeSettings({ persistPerWindow: true });
  const recorder = new PaperTapeRecorder(device as unknown as JavelinHidDevice, settings, () => true, store);

  device.strike();
  recorder.clear();
  recorder.dispose();
  await flushMicrotasks();

  assert.equal(recorder.getEntries().length, 0);
  assert.deepEqual(store.loadEntries(), []);
});

test("clear() notifies onClear listeners", () => {
  const device = new FakeDevice();
  const recorder = new PaperTapeRecorder(device as unknown as JavelinHidDevice, makeSettings(), () => true);
  let notified = false;
  recorder.onClear(() => (notified = true));

  recorder.clear();

  assert.equal(notified, true);
});

test("clear() does not touch the store when persistPerWindow is off", async () => {
  // clear() must respect persistPerWindow like every other write site.
  const device = new FakeDevice();
  const store = new FakePaperTapeStore();
  store.appendEntry(persistedEntry({ id: 1, translation: "this", timestamp: 1 }));
  const recorder = new PaperTapeRecorder(device as unknown as JavelinHidDevice, makeSettings(), () => true, store);

  device.strike();
  recorder.clear();
  await recorder.dispose();

  assert.deepEqual(
    store.loadEntries().map((e) => e.translation),
    ["this"]
  );
});

test("turning persistPerWindow on mid-session persists what was already buffered", async () => {
  const device = new FakeDevice();
  const store = new FakePaperTapeStore();
  const settings = makeSettings();
  const recorder = new PaperTapeRecorder(device as unknown as JavelinHidDevice, settings, () => true, store);

  // Recorded before persistence was ever turned on for this window.
  device.strike("TH", "this");
  assert.deepEqual(store.loadEntries(), []);

  await settings.setPersistPerWindow(true);
  await recorder.dispose();

  assert.deepEqual(
    store.loadEntries().map((e) => e.translation),
    ["this"]
  );
});

test("turning persistPerWindow on mid-session does not discard entries persisted by an earlier session", async () => {
  // Flipping persistPerWindow on mid-session must add to entries from an earlier session, not overwrite them.
  const device = new FakeDevice();
  const store = new FakePaperTapeStore();
  store.appendEntry(persistedEntry({ id: 1, translation: "this", timestamp: 1 }));
  store.appendEntry(persistedEntry({ id: 2, translation: "you", timestamp: 2 }));
  const settings = makeSettings();
  const recorder = new PaperTapeRecorder(device as unknown as JavelinHidDevice, settings, () => true, store);

  // This session's own recording never sees the earlier session's entries.
  assert.equal(recorder.getEntries().length, 0);

  device.strike("PWAOEUP", "paper");
  await settings.setPersistPerWindow(true);
  await recorder.dispose();

  assert.deepEqual(
    store.loadEntries().map((e) => e.translation),
    ["this", "you", "paper"]
  );
});

test("a window persisting its own strokes does not overwrite another window's already-committed entries", async () => {
  // Window B activates with persistPerWindow off, then turns it on and must add to A's write, not overwrite it.
  const disk = new FakePaperTapeStore();

  const deviceA = new FakeDevice();
  const storeA = new FakePaperTapeStore(disk);
  const recorderA = new PaperTapeRecorder(
    deviceA as unknown as JavelinHidDevice,
    makeSettings({ persistPerWindow: true }),
    () => true,
    storeA,
    undefined,
    () => 1000 // deterministically earlier than window B's clock below, regardless of real execution speed
  );
  deviceA.strike("TH", "this");
  await recorderA.dispose();

  const deviceB = new FakeDevice();
  const storeB = new FakePaperTapeStore(disk);
  const settingsB = makeSettings();
  const recorderB = new PaperTapeRecorder(
    deviceB as unknown as JavelinHidDevice,
    settingsB,
    () => true,
    storeB,
    undefined,
    () => 2000
  );
  assert.equal(recorderB.getEntries().length, 0, "B shouldn't have eagerly loaded A's entry");

  deviceB.strike("KWRO", "you");
  await settingsB.setPersistPerWindow(true);
  await recorderB.dispose();

  assert.deepEqual(
    storeB.loadEntries().map((e) => e.translation),
    ["this", "you"]
  );
});

test("entries beyond the cap drop the oldest from the live buffer", () => {
  const device = new FakeDevice();
  const recorder = new PaperTapeRecorder(device as unknown as JavelinHidDevice, makeSettings(), () => true);

  for (let i = 0; i < 5001; i++) {
    device.strike("TH", `word${i}`);
  }

  const entries = recorder.getEntries();
  assert.equal(entries.length, 5000, "should be capped at MAX_ENTRIES");
  assert.equal(entries[0].translation, "word1", "oldest entry (word0) should have been dropped");
  assert.equal(entries[entries.length - 1].translation, "word5000");
});

test("getAllEntries() falls back to the live buffer when there is no store or persistence is off", () => {
  const device = new FakeDevice();
  const recorder = new PaperTapeRecorder(device as unknown as JavelinHidDevice, makeSettings(), () => true);

  device.strike("TH", "this");

  assert.deepEqual(
    recorder.getAllEntries().map((e) => e.translation),
    recorder.getEntries().map((e) => e.translation)
  );
});

test("getRecentEntries() falls back to a single page from the capped live buffer when there is no store", () => {
  const device = new FakeDevice();
  const recorder = new PaperTapeRecorder(device as unknown as JavelinHidDevice, makeSettings(), () => true);

  device.strike("TH", "one");
  device.strike("TH", "two");
  device.strike("TH", "three");

  const page = recorder.getRecentEntries(2);
  assert.deepEqual(
    page.entries.map((e) => e.translation),
    ["two", "three"]
  );
  assert.equal(page.hasMore, false, "nothing durable to page into beyond the live buffer");
});

test("getRecentEntries() reports hasMore when persisted history exceeds the page size", () => {
  const store = new FakePaperTapeStore();
  for (let i = 0; i < 5; i++) {
    store.appendEntry({ id: i, outline: "TH", dictionary: "main.json", translation: `w${i}`, undo: 0, timestamp: i, kind: "text" });
  }
  const settings = makeSettings({ persistPerWindow: true });
  const recorder = new PaperTapeRecorder(undefined, settings, () => true, store);

  const page = recorder.getRecentEntries(2);

  assert.deepEqual(
    page.entries.map((e) => e.translation),
    ["w3", "w4"]
  );
  assert.equal(page.hasMore, true);
});

test("getOlderEntries() continues from getRecentEntries() with no overlap or gap", () => {
  const store = new FakePaperTapeStore();
  for (let i = 0; i < 5; i++) {
    store.appendEntry({ id: i, outline: "TH", dictionary: "main.json", translation: `w${i}`, undo: 0, timestamp: i, kind: "text" });
  }
  const settings = makeSettings({ persistPerWindow: true });
  const recorder = new PaperTapeRecorder(undefined, settings, () => true, store);

  const firstPage = recorder.getRecentEntries(2); // w3, w4 - hasMore
  const secondPage = recorder.getOlderEntries(firstPage.entries[0], 2);

  assert.deepEqual(
    secondPage.entries.map((e) => e.translation),
    ["w1", "w2"]
  );
  assert.equal(secondPage.hasMore, true, "w0 is still older than this page");

  const thirdPage = recorder.getOlderEntries(secondPage.entries[0], 2);
  assert.deepEqual(
    thirdPage.entries.map((e) => e.translation),
    ["w0"]
  );
  assert.equal(thirdPage.hasMore, false);
});

test("getRecentEntries() includes strokes not yet flushed to the store", () => {
  const device = new FakeDevice();
  const store = new FakePaperTapeStore();
  const settings = makeSettings({ persistPerWindow: true });
  const recorder = new PaperTapeRecorder(device as unknown as JavelinHidDevice, settings, () => true, store);

  device.strike("TH", "this");
  // No dispose/flush - "this" is still only in pendingEntries, not the store yet.

  const page = recorder.getRecentEntries(10);
  assert.deepEqual(
    page.entries.map((e) => e.translation),
    ["this"]
  );
});

test("getOlderEntries() returns nothing when there is no store or persistence is off", () => {
  const device = new FakeDevice();
  const recorder = new PaperTapeRecorder(device as unknown as JavelinHidDevice, makeSettings(), () => true);
  device.strike("TH", "this");

  const page = recorder.getOlderEntries(recorder.getEntries()[0], 10);
  assert.deepEqual(page, { entries: [], hasMore: false });
});

test("getAllEntries() returns the full persisted history across a restart, beyond what the live buffer holds", async () => {
  const device = new FakeDevice();
  const store = new FakePaperTapeStore();
  const settings = makeSettings({ persistPerWindow: true });
  const recorder = new PaperTapeRecorder(device as unknown as JavelinHidDevice, settings, () => true, store);

  for (let i = 0; i < 5001; i++) {
    device.strike("TH", `word${i}`);
  }
  // Flushes every pending entry, then simulates reopening the window with a fresh recorder against that store.
  await recorder.dispose();
  const reopened = new PaperTapeRecorder(undefined, settings, () => true, store);

  assert.equal(reopened.getEntries().length, 5000, "live buffer only loads the most recent MAX_ENTRIES");
  assert.equal(reopened.getAllEntries().length, 5001, "full history is still readable from disk");
  assert.equal(reopened.getAllEntries()[0].translation, "word0", "the oldest entry is gone from the live buffer but not from disk");
});

test("a stroke recorded after a backward clock jump still sorts after previously persisted history", () => {
  const store = new FakePaperTapeStore();
  store.appendEntry({ id: 1, outline: "TH", dictionary: "main.json", translation: "old", undo: 0, timestamp: 1000, kind: "text" });
  const settings = makeSettings({ persistPerWindow: true });
  const device = new FakeDevice();
  // The system clock reads earlier than the last persisted timestamp - e.g. after a sleep/resume or NTP correction.
  const recorder = new PaperTapeRecorder(
    device as unknown as JavelinHidDevice,
    settings,
    () => true,
    store,
    undefined,
    () => 500
  );

  device.strike("TH", "new");

  const [, newEntry] = recorder.getEntries();
  assert.ok(newEntry.timestamp > 1000, "new entry must sort after the persisted entry despite the clock reading earlier");
  assert.deepEqual(
    recorder.getRecentEntries(1).entries.map((e) => e.translation),
    ["new"],
    "the new stroke must be the most recent entry"
  );
});
