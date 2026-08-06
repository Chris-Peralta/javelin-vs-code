import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type * as vscode from "vscode";
import { SuggestionTracker } from "../src/suggestionTracker";
import type { JavelinHidDevice, JavSuggestionEventDetail } from "../src/javelinHidDevice";
import { JavelinSettings, type JavelinSettingsSnapshot } from "../src/settings";

/** Stands in for JavelinHidDevice: records listeners and lets tests fire fake suggestion events. */
class FakeDevice {
  private readonly listeners = new Map<string, Set<(ev: CustomEvent<JavSuggestionEventDetail>) => void>>();

  on(type: string, listener: (ev: CustomEvent<JavSuggestionEventDetail>) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }

  off(type: string, listener: (ev: CustomEvent<JavSuggestionEventDetail>) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  suggest(translation = "good day", outlines: string[] = ["TKPW-D"], strokes = 1): void {
    const detail: JavSuggestionEventDetail = { strokes, translation, outlines, raw: "" };
    for (const listener of this.listeners.get("suggestion") ?? []) {
      listener(new CustomEvent("suggestion", { detail }));
    }
  }
}

function makeSettings(initial: Partial<JavelinSettingsSnapshot> = {}): JavelinSettings {
  // Own storage dir per call - these tests don't exercise cross-window settings sync.
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "javelin-suggestion-settings-"));
  if (Object.keys(initial).length > 0) {
    fs.writeFileSync(
      path.join(storageDir, "settings.json"),
      JSON.stringify({
        showTimestamps: false,
        backgroundMonitoring: false,
        persistPerWindow: false,
        suggestionsBackgroundMonitoring: false,
        ...initial,
      })
    );
  }
  return new JavelinSettings({ globalStorageUri: { fsPath: storageDir } } as unknown as vscode.ExtensionContext);
}

test("records a suggestion while focused, with suggestionsBackgroundMonitoring off", () => {
  const device = new FakeDevice();
  const tracker = new SuggestionTracker(device as unknown as JavelinHidDevice, makeSettings(), () => true);

  device.suggest("good day", ["TKPW-D"]);

  assert.equal(tracker.getEntries().length, 1);
  assert.equal(tracker.getEntries()[0].translation, "good day");
  assert.deepEqual(tracker.getEntries()[0].outlines, ["TKPW-D"]);
});

test("does not record while unfocused, with suggestionsBackgroundMonitoring off", () => {
  const device = new FakeDevice();
  const tracker = new SuggestionTracker(device as unknown as JavelinHidDevice, makeSettings(), () => false);

  device.suggest();

  assert.equal(tracker.getEntries().length, 0);
});

test("records even while unfocused when suggestionsBackgroundMonitoring is on", () => {
  const device = new FakeDevice();
  const settings = makeSettings({ suggestionsBackgroundMonitoring: true });
  const tracker = new SuggestionTracker(device as unknown as JavelinHidDevice, settings, () => false);

  device.suggest();

  assert.equal(tracker.getEntries().length, 1);
});

test("onAppend listeners are notified of each new suggestion, in order", () => {
  const device = new FakeDevice();
  const tracker = new SuggestionTracker(device as unknown as JavelinHidDevice, makeSettings(), () => true);

  const seen: string[] = [];
  tracker.onAppend((entry) => seen.push(entry.translation));

  device.suggest("good day", ["TKPW-D"]);
  device.suggest("this is", ["TH-S", "STKHE", "STKH-B"]);

  assert.deepEqual(seen, ["good day", "this is"]);
});

test("a disposed onAppend subscription stops receiving new suggestions", () => {
  const device = new FakeDevice();
  const tracker = new SuggestionTracker(device as unknown as JavelinHidDevice, makeSettings(), () => true);

  const seen: string[] = [];
  const subscription = tracker.onAppend((entry) => seen.push(entry.translation));

  device.suggest("good day");
  subscription.dispose();
  device.suggest("this is");

  assert.deepEqual(seen, ["good day"]);
});

test("dispose() stops recording further suggestions", () => {
  const device = new FakeDevice();
  const tracker = new SuggestionTracker(device as unknown as JavelinHidDevice, makeSettings(), () => true);

  tracker.dispose();
  device.suggest();

  assert.equal(tracker.getEntries().length, 0);
});

test("entries beyond the cap drop the oldest first", () => {
  const device = new FakeDevice();
  const tracker = new SuggestionTracker(device as unknown as JavelinHidDevice, makeSettings(), () => true);

  for (let i = 0; i < 201; i++) {
    device.suggest(`word${i}`, [`OUT${i}`]);
  }

  const entries = tracker.getEntries();
  assert.equal(entries.length, 200, "should be capped at MAX_ENTRIES");
  assert.equal(entries[0].translation, "word1", "oldest entry (word0) should have been dropped");
  assert.equal(entries[entries.length - 1].translation, "word200");
});
