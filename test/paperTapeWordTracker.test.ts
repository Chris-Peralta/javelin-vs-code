import test from "node:test";
import assert from "node:assert/strict";
import { PaperTapeWordTracker, type TrackedDocumentChange } from "../src/paperTapeWordTracker";
import type { PaperTapeRecorder, PaperTapeEntry } from "../src/paperTapeRecorder";
import type { JavelinSettings, JavelinSettingsSnapshot } from "../src/settings";
import { FakeMemento } from "./fakeMemento";

/** Stands in for PaperTapeRecorder: records the WordTracker's listener and lets tests fire word updates. */
class FakeRecorder {
  private listener: ((wordId: string, entries: readonly PaperTapeEntry[]) => void) | undefined;

  onWordUpdated(listener: (wordId: string, entries: readonly PaperTapeEntry[]) => void) {
    this.listener = listener;
    return { dispose: () => (this.listener = undefined) };
  }

  fire(wordId: string, entries: readonly PaperTapeEntry[]): void {
    this.listener?.(wordId, entries);
  }
}

/** Stands in for JavelinSettings: just enough for the `persistPerWindow` gating tests. */
class FakeSettings {
  private readonly listeners = new Set<(snapshot: Pick<JavelinSettingsSnapshot, "persistPerWindow">) => void>();

  constructor(public persistPerWindow: boolean) {}

  onDidChange(listener: (snapshot: Pick<JavelinSettingsSnapshot, "persistPerWindow">) => void) {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  set(persistPerWindow: boolean): void {
    this.persistPerWindow = persistPerWindow;
    for (const listener of this.listeners) listener({ persistPerWindow });
  }
}

class FakeDocument {
  constructor(
    readonly uri: string,
    public text: string
  ) {}

  getText(): string {
    return this.text;
  }
}

function entry(overrides: Partial<PaperTapeEntry> = {}): PaperTapeEntry {
  return {
    id: 1,
    outline: "TH",
    dictionary: "main.json",
    translation: "this",
    undo: 0,
    timestamp: 1,
    kind: "text",
    documentUri: "file:///doc.txt",
    ...overrides,
  };
}

interface Harness {
  recorder: FakeRecorder;
  doc: FakeDocument;
  tracker: PaperTapeWordTracker;
  setCursor(offset: number): void;
  change(c: Partial<TrackedDocumentChange>): void;
}

function createHarness(initialText: string, uri = "file:///doc.txt"): Harness {
  const recorder = new FakeRecorder();
  const doc = new FakeDocument(uri, initialText);
  let cursorOffset = initialText.length;
  let changeListener: ((changes: TrackedDocumentChange[]) => void) | undefined;

  const tracker = new PaperTapeWordTracker(
    recorder as unknown as PaperTapeRecorder,
    undefined,
    undefined,
    () => ({ documentUri: doc.uri, cursorOffset }),
    (u) => (u === doc.uri ? doc : undefined),
    (listener) => {
      changeListener = listener;
      return { dispose: () => (changeListener = undefined) };
    },
    // Anchor creation is normally debounced to avoid racing steno's keystroke injection; tests don't have that race, so run synchronously.
    (run) => {
      run();
      return () => {};
    }
  );

  return {
    recorder,
    doc,
    tracker,
    setCursor: (offset) => (cursorOffset = offset),
    change: (c) => {
      const full: TrackedDocumentChange = { documentUri: uri, rangeOffset: 0, rangeLength: 0, text: "", ...c };
      // Apply to the fake document's text too, so the change event and resulting content stay in sync.
      doc.text = doc.text.slice(0, full.rangeOffset) + full.text + doc.text.slice(full.rangeOffset + full.rangeLength);
      changeListener?.([full]);
    },
  };
}

test("a second update for the same word before it settles cancels the first, using the latest state", () => {
  // Guards against reading a stale mid-correction cursor/document snapshot instead of the settled one.
  const recorder = new FakeRecorder();
  const doc = new FakeDocument("file:///doc.txt", "hello dock");
  let cursorOffset = doc.text.length;
  const scheduled: { run: () => void; cancelled: boolean }[] = [];

  const tracker = new PaperTapeWordTracker(
    recorder as unknown as PaperTapeRecorder,
    undefined,
    undefined,
    () => ({ documentUri: doc.uri, cursorOffset }),
    (u) => (u === doc.uri ? doc : undefined),
    () => ({ dispose: () => {} }),
    (run) => {
      const entryRecord = { run, cancelled: false };
      scheduled.push(entryRecord);
      return () => (entryRecord.cancelled = true);
    }
  );

  recorder.fire("w1", [entry({ translation: "dock" })]);
  assert.equal(scheduled.length, 1, "the first update schedules a settle");

  // Steno folds "dock" into "document", and the document is updated to match, before the first scheduled settle ever fires.
  doc.text = "hello document";
  cursorOffset = doc.text.length;
  recorder.fire("w1", [entry({ translation: "document" })]);

  assert.equal(scheduled.length, 2, "a second update schedules another settle");
  assert.equal(scheduled[0].cancelled, true, "the stale first settle must be cancelled, not left to fire later");

  scheduled[1].run();

  assert.deepEqual(tracker.getAnchor("w1"), {
    wordId: "w1",
    documentUri: "file:///doc.txt",
    origin: "stroke",
    offset: 6,
    length: 8,
    originalText: "document",
  });
});

test("dictating a second word before the first settles freezes the first word's cursor position, instead of racing the live cursor", () => {
  const recorder = new FakeRecorder();
  const doc = new FakeDocument("file:///doc.txt", "hello how");
  let cursorOffset = doc.text.length; // right after "how"
  const scheduled: { run: () => void; cancelled: boolean }[] = [];

  const tracker = new PaperTapeWordTracker(
    recorder as unknown as PaperTapeRecorder,
    undefined,
    undefined,
    () => ({ documentUri: doc.uri, cursorOffset }),
    (u) => (u === doc.uri ? doc : undefined),
    () => ({ dispose: () => {} }),
    (run) => {
      const entryRecord = { run, cancelled: false };
      scheduled.push(entryRecord);
      return () => (entryRecord.cancelled = true);
    }
  );

  recorder.fire("w-how", [entry({ translation: "how" })]);
  assert.equal(scheduled.length, 1, "\"how\" schedules a settle");

  // "are" arrives before "how"'s settle timer fires, while "are"'s own keystrokes haven't landed in the document yet.
  recorder.fire("w-are", [entry({ translation: "are" })]);
  assert.equal(scheduled.length, 2, "\"are\" schedules its own settle");

  // Only now does the document catch up to reflect "are" too, before either settle timer fires.
  doc.text = "hello how are";
  cursorOffset = doc.text.length;

  scheduled[0].run(); // "how"'s settle
  scheduled[1].run(); // "are"'s settle

  assert.deepEqual(tracker.getAnchor("w-how"), {
    wordId: "w-how",
    documentUri: "file:///doc.txt",
    origin: "stroke",
    offset: 6,
    length: 3,
    originalText: "how",
  });
  assert.deepEqual(tracker.getAnchor("w-are"), {
    wordId: "w-are",
    documentUri: "file:///doc.txt",
    origin: "stroke",
    offset: 10,
    length: 3,
    originalText: "are",
  });
});

test("registerInsertedAnchor cancels the settle timer the accompanying onWordUpdated call already scheduled", () => {
  // appendSynthetic fires onWordUpdated before registerInsertedAnchor sets the exact known position - the stale settle must not clobber it.
  const recorder = new FakeRecorder();
  const doc = new FakeDocument("file:///doc.txt", "hello there");
  const scheduled: { run: () => void; cancelled: boolean }[] = [];

  const tracker = new PaperTapeWordTracker(
    recorder as unknown as PaperTapeRecorder,
    undefined,
    undefined,
    () => ({ documentUri: doc.uri, cursorOffset: 0 }), // deliberately wrong - must never be read
    (u) => (u === doc.uri ? doc : undefined),
    () => ({ dispose: () => {} }),
    (run) => {
      const entryRecord = { run, cancelled: false };
      scheduled.push(entryRecord);
      return () => (entryRecord.cancelled = true);
    }
  );

  recorder.fire("w-inserted", [entry({ translation: "there", synthetic: true })]);
  assert.equal(scheduled.length, 1);

  tracker.registerInsertedAnchor("w-inserted", "file:///doc.txt", 6, "there");

  assert.equal(scheduled[0].cancelled, true, "the settle scheduled by onWordUpdated must be cancelled");
  assert.deepEqual(tracker.getAnchor("w-inserted"), {
    wordId: "w-inserted",
    documentUri: "file:///doc.txt",
    origin: "inserted",
    offset: 6,
    length: 5,
    originalText: "there",
  });
});

test("registerInsertedAnchor anchors an inserted word directly, without reading the cursor", () => {
  const h = createHarness("hello there");
  h.setCursor(0); // deliberately wrong - registerInsertedAnchor must not consult the cursor at all

  h.tracker.registerInsertedAnchor("w-inserted", "file:///doc.txt", 6, "there");

  assert.deepEqual(h.tracker.getAnchor("w-inserted"), {
    wordId: "w-inserted",
    documentUri: "file:///doc.txt",
    origin: "inserted",
    offset: 6,
    length: 5,
    originalText: "there",
  });
  assert.deepEqual(h.tracker.getWordStatus("w-inserted"), { state: "unmodified" });
});

test("creates an anchor at the cursor position when a word closes, reporting unmodified", () => {
  const h = createHarness("hello world");
  h.setCursor(11);

  h.recorder.fire("w1", [entry({ translation: "world" })]);

  assert.deepEqual(h.tracker.getAnchor("w1"), {
    wordId: "w1",
    documentUri: "file:///doc.txt",
    origin: "stroke",
    offset: 6,
    length: 5,
    originalText: "world",
  });
  assert.deepEqual(h.tracker.getWordStatus("w1"), { state: "unmodified" });
});

test("a single stroke whose translation is multiple words anchors the whole phrase, not just the trailing word", () => {
  const h = createHarness("hello on the");
  h.setCursor(12);

  h.recorder.fire("w1", [entry({ translation: " on the" })]);

  assert.deepEqual(h.tracker.getAnchor("w1"), {
    wordId: "w1",
    documentUri: "file:///doc.txt",
    origin: "stroke",
    offset: 6,
    length: 6,
    originalText: "on the",
  });
  assert.deepEqual(h.tracker.getWordStatus("w1"), { state: "unmodified" });
});

test("a bare newline stroke anchors the exact newline character, not a trimmed-away empty span", () => {
  const h = createHarness("hello\nworld");
  h.setCursor(6); // right after the newline

  h.recorder.fire("w1", [entry({ translation: "\n" })]);

  assert.deepEqual(h.tracker.getAnchor("w1"), {
    wordId: "w1",
    documentUri: "file:///doc.txt",
    origin: "stroke",
    offset: 5,
    length: 1,
    originalText: "\n",
  });
  assert.deepEqual(h.tracker.getWordStatus("w1"), { state: "unmodified" });
});

test("a blank-line stroke chaining two Return key combos anchors both newline characters", () => {
  const h = createHarness("hello\n\nworld");
  h.setCursor(7); // right after both newlines

  h.recorder.fire("w1", [entry({ translation: "{#Return}{#Return}" })]);

  assert.deepEqual(h.tracker.getAnchor("w1"), {
    wordId: "w1",
    documentUri: "file:///doc.txt",
    origin: "stroke",
    offset: 5,
    length: 2,
    originalText: "\n\n",
  });
});

test("deleting an anchored newline is reported as deleted, same as any other word", () => {
  const h = createHarness("hello\nworld");
  h.setCursor(6);
  h.recorder.fire("w1", [entry({ translation: "\n" })]);

  h.change({ rangeOffset: 5, rangeLength: 1, text: "" });

  assert.deepEqual(h.tracker.getWordStatus("w1"), { state: "deleted" });
});

test("a fully cancelled word (empty resolved text) is never anchored", () => {
  const h = createHarness("hello ");
  h.setCursor(6);

  h.recorder.fire("w1", []);

  assert.equal(h.tracker.getAnchor("w1"), undefined);
  assert.equal(h.tracker.getWordStatus("w1"), undefined);
});

test("getWordStatus returns undefined for a word that was never anchored", () => {
  const h = createHarness("hello world");
  assert.equal(h.tracker.getWordStatus("nope"), undefined);
});

test("an edit before the anchor shifts it", () => {
  const h = createHarness("hello world");
  h.setCursor(11);
  h.recorder.fire("w1", [entry({ translation: "world" })]);

  // Insert "very " before "world".
  h.change({ rangeOffset: 6, rangeLength: 0, text: "very " });

  assert.deepEqual(h.tracker.getWordStatus("w1"), { state: "unmodified" });
  assert.equal(h.tracker.getAnchor("w1")?.offset, 11, "anchor should shift right by the inserted length");
});

test("an edit after the anchor does not affect it", () => {
  const h = createHarness("hello world");
  h.setCursor(5); // right after "hello"
  h.recorder.fire("w0", [entry({ translation: "hello" })]);

  // Replace "world" with "there", well after "hello"'s anchor.
  h.change({ rangeOffset: 6, rangeLength: 5, text: "there" });

  assert.deepEqual(h.tracker.getWordStatus("w0"), { state: "unmodified" });
  assert.equal(h.tracker.getAnchor("w0")?.offset, 0);
});

test("an edit inside the anchor's region is reported as edited, with the new text", () => {
  const h = createHarness("hello world");
  h.setCursor(11);
  h.recorder.fire("w1", [entry({ translation: "world" })]);

  // Replace "world" with "there".
  h.change({ rangeOffset: 6, rangeLength: 5, text: "there" });

  assert.deepEqual(h.tracker.getWordStatus("w1"), { state: "edited", currentText: "there" });
});

test("deleting the anchor's region entirely is reported as deleted", () => {
  const h = createHarness("hello world");
  h.setCursor(11);
  h.recorder.fire("w1", [entry({ translation: "world" })]);

  // Delete "world" and the space before it, leaving just "hello".
  h.change({ rangeOffset: 5, rangeLength: 6, text: "" });

  assert.deepEqual(h.tracker.getWordStatus("w1"), { state: "deleted" });
});

test("an anchor whose document isn't open is reported unmodified (best effort - can't verify)", () => {
  const h = createHarness("hello world");
  h.setCursor(11);
  h.recorder.fire("w1", [entry({ translation: "world" })]);

  const tracker2 = new PaperTapeWordTracker(
    h.recorder as unknown as PaperTapeRecorder,
    undefined,
    undefined,
    () => undefined,
    () => undefined,
    () => ({ dispose: () => {} })
  );
  // Same signal as a tracker whose document later closes: getOpenDocument returning undefined.
  assert.equal(tracker2.getWordStatus("w1"), undefined);
});

test("a change in a different open document does not touch an anchor in this one", () => {
  const recorder = new FakeRecorder();
  const docA = new FakeDocument("file:///a.txt", "hello world");
  const docB = new FakeDocument("file:///b.txt", "unrelated document");
  let changeListener: ((changes: TrackedDocumentChange[]) => void) | undefined;

  const tracker = new PaperTapeWordTracker(
    recorder as unknown as PaperTapeRecorder,
    undefined,
    undefined,
    () => ({ documentUri: docA.uri, cursorOffset: docA.text.length }),
    (u) => (u === docA.uri ? docA : u === docB.uri ? docB : undefined),
    (listener) => {
      changeListener = listener;
      return { dispose: () => (changeListener = undefined) };
    },
    (run) => {
      run();
      return () => {};
    }
  );

  recorder.fire("w1", [entry({ translation: "world", documentUri: docA.uri })]);
  assert.equal(tracker.getAnchor("w1")?.offset, 6);

  // Edit docB, not docA; only docB's fake text needs updating for this test's own bookkeeping.
  docB.text = "XXunrelated document";
  changeListener?.([{ documentUri: docB.uri, rangeOffset: 0, rangeLength: 0, text: "XX" }]);

  assert.deepEqual(tracker.getWordStatus("w1"), { state: "unmodified" });
  assert.equal(tracker.getAnchor("w1")?.offset, 6);
});

test("does not persist anchors to workspaceState when persistPerWindow is off", async () => {
  const recorder = new FakeRecorder();
  const doc = new FakeDocument("file:///doc.txt", "hello world");
  const workspaceState = new FakeMemento();

  const tracker = new PaperTapeWordTracker(
    recorder as unknown as PaperTapeRecorder,
    new FakeSettings(false) as unknown as JavelinSettings,
    workspaceState,
    () => ({ documentUri: doc.uri, cursorOffset: doc.text.length }),
    (u) => (u === doc.uri ? doc : undefined),
    () => ({ dispose: () => {} }),
    (run) => {
      run();
      return () => {};
    }
  );

  recorder.fire("w1", [entry({ translation: "world" })]);
  await tracker.dispose();

  assert.deepEqual(workspaceState.keys(), []);
});

test("persists anchors to workspaceState when persistPerWindow is on", async () => {
  const recorder = new FakeRecorder();
  const doc = new FakeDocument("file:///doc.txt", "hello world");
  const workspaceState = new FakeMemento();

  const tracker = new PaperTapeWordTracker(
    recorder as unknown as PaperTapeRecorder,
    new FakeSettings(true) as unknown as JavelinSettings,
    workspaceState,
    () => ({ documentUri: doc.uri, cursorOffset: doc.text.length }),
    (u) => (u === doc.uri ? doc : undefined),
    () => ({ dispose: () => {} }),
    (run) => {
      run();
      return () => {};
    }
  );

  recorder.fire("w1", [entry({ translation: "world" })]);
  // dispose() flushes the debounced write immediately instead of waiting out the 500ms debounce.
  await tracker.dispose();

  const saved = workspaceState.get<{ wordId: string }[]>("javelin.paperTapeAnchors", []);
  assert.deepEqual(saved.map((a) => a.wordId), ["w1"]);
});

test("loads previously persisted anchors on construction when persistPerWindow is on", () => {
  const workspaceState = new FakeMemento({
    "javelin.paperTapeAnchors": [
      { wordId: "w1", documentUri: "file:///doc.txt", origin: "stroke", offset: 0, length: 5, originalText: "hello" },
    ],
  });
  const recorder = new FakeRecorder();

  const tracker = new PaperTapeWordTracker(
    recorder as unknown as PaperTapeRecorder,
    new FakeSettings(true) as unknown as JavelinSettings,
    workspaceState,
    undefined,
    undefined,
    () => ({ dispose: () => {} })
  );

  assert.equal(tracker.getAnchor("w1")?.originalText, "hello");
});

test("does not load previously persisted anchors when persistPerWindow is off", () => {
  const workspaceState = new FakeMemento({
    "javelin.paperTapeAnchors": [
      { wordId: "w1", documentUri: "file:///doc.txt", origin: "stroke", offset: 0, length: 5, originalText: "hello" },
    ],
  });
  const recorder = new FakeRecorder();

  const tracker = new PaperTapeWordTracker(
    recorder as unknown as PaperTapeRecorder,
    new FakeSettings(false) as unknown as JavelinSettings,
    workspaceState,
    undefined,
    undefined,
    () => ({ dispose: () => {} })
  );

  assert.equal(tracker.getAnchor("w1"), undefined);
});

test("turning persistPerWindow on mid-session persists what was already tracked", async () => {
  const recorder = new FakeRecorder();
  const doc = new FakeDocument("file:///doc.txt", "hello world");
  const workspaceState = new FakeMemento();
  const settings = new FakeSettings(false);

  const tracker = new PaperTapeWordTracker(
    recorder as unknown as PaperTapeRecorder,
    settings as unknown as JavelinSettings,
    workspaceState,
    () => ({ documentUri: doc.uri, cursorOffset: doc.text.length }),
    (u) => (u === doc.uri ? doc : undefined),
    () => ({ dispose: () => {} }),
    (run) => {
      run();
      return () => {};
    }
  );

  recorder.fire("w1", [entry({ translation: "world" })]);
  assert.deepEqual(workspaceState.keys(), []);

  settings.set(true);
  await tracker.dispose();

  const saved = workspaceState.get<{ wordId: string }[]>("javelin.paperTapeAnchors", []);
  assert.deepEqual(saved.map((a) => a.wordId), ["w1"]);
});

test("anchors are never evicted, no matter how many accumulate", () => {
  // Anchor storage is deliberately unbounded, same as the tape itself.
  const h = createHarness("hello there");
  for (let i = 0; i < 5001; i++) {
    h.tracker.registerInsertedAnchor(`w${i}`, "file:///doc.txt", 0, "x");
  }

  assert.ok(h.tracker.getAnchor("w0"), "the oldest anchor should still be present");
  assert.ok(h.tracker.getAnchor("w5000"), "the newest anchor should still be present");
});
