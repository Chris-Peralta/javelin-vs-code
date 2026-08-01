import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type * as vscode from "vscode";
import { PaperTapeRecorder } from "../src/paperTapeRecorder";
import type { JavelinHidDevice, JavPaperTapeEventDetail } from "../src/javelinHidDevice";
import { JavelinSettings, type JavelinSettingsSnapshot } from "../src/settings";
import { FakeMemento } from "./fakeMemento";

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

test("does not persist to workspaceState when persistPerWindow is off", async () => {
  const device = new FakeDevice();
  const workspaceState = new FakeMemento();
  const recorder = new PaperTapeRecorder(
    device as unknown as JavelinHidDevice,
    makeSettings(),
    () => true,
    workspaceState
  );

  device.strike();
  recorder.dispose();
  await flushMicrotasks();

  assert.deepEqual(workspaceState.keys(), []);
});

test("persists new entries to workspaceState when persistPerWindow is on", async () => {
  const device = new FakeDevice();
  const workspaceState = new FakeMemento();
  const settings = makeSettings({ persistPerWindow: true });
  const recorder = new PaperTapeRecorder(
    device as unknown as JavelinHidDevice,
    settings,
    () => true,
    workspaceState
  );

  device.strike("TH", "this");
  device.strike("KWRO", "you");
  // dispose() flushes the debounced write immediately instead of waiting out the
  // 500ms debounce, so the test doesn't need a real (or mocked) timer wait.
  recorder.dispose();
  await flushMicrotasks();

  const saved = workspaceState.get<{ translation: string }[]>("javelin.paperTapeEntries", []);
  assert.deepEqual(
    saved.map((e) => e.translation),
    ["this", "you"]
  );
});

test("loads previously persisted entries on construction when persistPerWindow is on", () => {
  const workspaceState = new FakeMemento({
    "javelin.paperTapeEntries": [
      { id: 1, outline: "TH", dictionary: "main.json", translation: "this", undo: 0, timestamp: 1 },
      { id: 2, outline: "KWRO", dictionary: "main.json", translation: "you", undo: 0, timestamp: 2 },
    ],
  });
  const settings = makeSettings({ persistPerWindow: true });
  const recorder = new PaperTapeRecorder(undefined, settings, () => true, workspaceState);

  assert.deepEqual(
    recorder.getEntries().map((e) => e.translation),
    ["this", "you"]
  );
});

test("does not load previously persisted entries when persistPerWindow is off", () => {
  const workspaceState = new FakeMemento({
    "javelin.paperTapeEntries": [
      { id: 1, outline: "TH", dictionary: "main.json", translation: "this", undo: 0, timestamp: 1 },
    ],
  });
  const recorder = new PaperTapeRecorder(undefined, makeSettings(), () => true, workspaceState);

  assert.equal(recorder.getEntries().length, 0);
});

test("a stroke recorded after loading persisted entries gets a fresh, non-colliding id", () => {
  const workspaceState = new FakeMemento({
    "javelin.paperTapeEntries": [
      { id: 1, outline: "TH", dictionary: "main.json", translation: "this", undo: 0, timestamp: 1 },
      { id: 5, outline: "KWRO", dictionary: "main.json", translation: "you", undo: 0, timestamp: 2 },
    ],
  });
  const device = new FakeDevice();
  const settings = makeSettings({ persistPerWindow: true });
  const recorder = new PaperTapeRecorder(device as unknown as JavelinHidDevice, settings, () => true, workspaceState);

  device.strike("PWAOEUP", "paper");

  const ids = recorder.getEntries().map((e) => e.id);
  assert.deepEqual(ids, [1, 5, 6]);
});

test("clear() empties the tape and persists the cleared state", async () => {
  const device = new FakeDevice();
  const workspaceState = new FakeMemento();
  const settings = makeSettings({ persistPerWindow: true });
  const recorder = new PaperTapeRecorder(
    device as unknown as JavelinHidDevice,
    settings,
    () => true,
    workspaceState
  );

  device.strike();
  recorder.clear();
  recorder.dispose();
  await flushMicrotasks();

  assert.equal(recorder.getEntries().length, 0);
  assert.deepEqual(workspaceState.get("javelin.paperTapeEntries", undefined), []);
});

test("clear() does not touch workspaceState when persistPerWindow is off", async () => {
  // clear() must respect persistPerWindow like every other write site.
  const device = new FakeDevice();
  const workspaceState = new FakeMemento({
    "javelin.paperTapeEntries": [
      { id: 1, outline: "TH", dictionary: "main.json", translation: "this", undo: 0, timestamp: 1 },
    ],
  });
  const recorder = new PaperTapeRecorder(
    device as unknown as JavelinHidDevice,
    makeSettings(),
    () => true,
    workspaceState
  );

  device.strike();
  recorder.clear();
  await recorder.dispose();

  assert.deepEqual(
    workspaceState.get("javelin.paperTapeEntries", undefined),
    [{ id: 1, outline: "TH", dictionary: "main.json", translation: "this", undo: 0, timestamp: 1 }]
  );
});

test("turning persistPerWindow on mid-session persists what was already buffered", async () => {
  const device = new FakeDevice();
  const workspaceState = new FakeMemento();
  const settings = makeSettings();
  const recorder = new PaperTapeRecorder(
    device as unknown as JavelinHidDevice,
    settings,
    () => true,
    workspaceState
  );

  // Recorded before persistence was ever turned on for this window.
  device.strike("TH", "this");
  assert.deepEqual(workspaceState.keys(), []);

  await settings.setPersistPerWindow(true);
  await recorder.dispose();

  const saved = workspaceState.get<{ translation: string }[]>("javelin.paperTapeEntries", []);
  assert.deepEqual(
    saved.map((e) => e.translation),
    ["this"]
  );
});

test("turning persistPerWindow on mid-session does not discard entries persisted by an earlier session", async () => {
  // Entries saved by an earlier session (persistPerWindow was on then) aren't loaded
  // into memory since this session starts with the setting off; flipping it on
  // mid-session must merge with them, not overwrite with just this session's buffer.
  const device = new FakeDevice();
  const workspaceState = new FakeMemento({
    "javelin.paperTapeEntries": [
      { id: 1, outline: "TH", dictionary: "main.json", translation: "this", undo: 0, timestamp: 1 },
      { id: 2, outline: "KWRO", dictionary: "main.json", translation: "you", undo: 0, timestamp: 2 },
    ],
  });
  const settings = makeSettings();
  const recorder = new PaperTapeRecorder(
    device as unknown as JavelinHidDevice,
    settings,
    () => true,
    workspaceState
  );

  // This session's own recording never sees the earlier session's entries.
  assert.equal(recorder.getEntries().length, 0);

  device.strike("PWAOEUP", "paper");
  await settings.setPersistPerWindow(true);
  await recorder.dispose();

  const saved = workspaceState.get<{ translation: string }[]>("javelin.paperTapeEntries", []);
  assert.deepEqual(
    saved.map((e) => e.translation),
    ["this", "you", "paper"]
  );
});

test("a window persisting its own strokes does not overwrite another window's already-committed entries", async () => {
  // workspaceState is shared by every window on the workspace. Window B activates with
  // persistPerWindow off so it doesn't eagerly load A's entry, then turns persistence
  // on and must merge with A's write.
  const disk = new FakeMemento();

  const deviceA = new FakeDevice();
  const workspaceStateA = new FakeMemento(disk.snapshot());
  const recorderA = new PaperTapeRecorder(
    deviceA as unknown as JavelinHidDevice,
    makeSettings({ persistPerWindow: true }),
    () => true,
    workspaceStateA
  );
  deviceA.strike("TH", "this");
  await recorderA.dispose();
  disk.update("javelin.paperTapeEntries", workspaceStateA.get("javelin.paperTapeEntries", []));

  const deviceB = new FakeDevice();
  const workspaceStateB = new FakeMemento(disk.snapshot());
  const settingsB = makeSettings();
  const recorderB = new PaperTapeRecorder(deviceB as unknown as JavelinHidDevice, settingsB, () => true, workspaceStateB);
  assert.equal(recorderB.getEntries().length, 0, "B shouldn't have eagerly loaded A's entry");

  deviceB.strike("KWRO", "you");
  await settingsB.setPersistPerWindow(true);
  await recorderB.dispose();

  const saved = workspaceStateB.get<{ translation: string }[]>("javelin.paperTapeEntries", []);
  assert.deepEqual(
    saved.map((e) => e.translation),
    ["this", "you"]
  );
});
