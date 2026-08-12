import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { SqlitePaperTapeStore } from "../src/paperTapeSqliteStore";
import type { PaperTapeEntry } from "../src/paperTapeRecorder";

function entry(overrides: Partial<PaperTapeEntry> & Pick<PaperTapeEntry, "timestamp" | "translation">): PaperTapeEntry {
  return { id: 0, outline: "TH", dictionary: "main.json", undo: 0, kind: "text", ...overrides };
}

function openStore(): { store: SqlitePaperTapeStore; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "javelin-sqlite-store-"));
  return { store: new SqlitePaperTapeStore(path.join(dir, "paperTape.sqlite")), dir };
}

test("loadEntriesBefore(undefined, limit) returns the most recent entries, oldest first", () => {
  const { store, dir } = openStore();
  for (let i = 0; i < 5; i++) store.appendEntry(entry({ timestamp: i, translation: `w${i}` }));

  const page = store.loadEntriesBefore(undefined, 3);

  assert.deepEqual(
    page.map((e) => e.translation),
    ["w2", "w3", "w4"]
  );
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("loadEntriesBefore(cursor, limit) returns entries immediately older than the cursor", () => {
  const { store, dir } = openStore();
  for (let i = 0; i < 5; i++) store.appendEntry(entry({ timestamp: i, translation: `w${i}` }));

  const firstPage = store.loadEntriesBefore(undefined, 2); // ["w3", "w4"]
  const secondPage = store.loadEntriesBefore(firstPage[0], 2);

  assert.deepEqual(
    secondPage.map((e) => e.translation),
    ["w1", "w2"]
  );
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("loadEntriesBefore paginates through the full history with no gaps or duplicates, even with same-millisecond ties", () => {
  const { store, dir } = openStore();
  // Several entries share timestamp 0 and 1, exercising the (timestamp, identity) tie-break.
  const all: PaperTapeEntry[] = [
    entry({ timestamp: 0, translation: "a" }),
    entry({ timestamp: 0, translation: "b" }),
    entry({ timestamp: 0, translation: "c" }),
    entry({ timestamp: 1, translation: "d" }),
    entry({ timestamp: 1, translation: "e" }),
    entry({ timestamp: 2, translation: "f" }),
  ];
  for (const e of all) store.appendEntry(e);

  const collected: string[] = [];
  let cursor: PaperTapeEntry | undefined;
  for (let i = 0; i < 10; i++) {
    // Guard against an infinite loop if pagination has a bug.
    const page = store.loadEntriesBefore(cursor, 2);
    if (page.length === 0) break;
    collected.unshift(...page.map((e) => e.translation));
    cursor = page[0];
  }

  assert.deepEqual(collected, ["a", "b", "c", "d", "e", "f"]);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("loadEntriesBefore returns an empty page once history is exhausted", () => {
  const { store, dir } = openStore();
  const only = entry({ timestamp: 0, translation: "only" });
  store.appendEntry(only);

  assert.deepEqual(store.loadEntriesBefore(only, 10), []);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("appendEntries persists a whole batch in one commit", () => {
  const { store, dir } = openStore();
  const batch = [0, 1, 2].map((i) => entry({ timestamp: i, translation: `w${i}` }));

  store.appendEntries(batch);

  assert.deepEqual(
    store.loadEntriesBefore(undefined, 10).map((e) => e.translation),
    ["w0", "w1", "w2"]
  );
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("clearAnchors empties the anchors table without touching entries", () => {
  const { store, dir } = openStore();
  store.appendEntry(entry({ timestamp: 0, translation: "kept" }));
  store.upsertAnchor({ wordId: "w1", documentUri: "file:///doc.txt", origin: "stroke", offset: 0, length: 5, originalText: "kept" });

  store.clearAnchors();

  assert.deepEqual(store.loadAnchors(), []);
  assert.equal(store.loadEntriesBefore(undefined, 10).length, 1);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
