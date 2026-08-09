import test from "node:test";
import assert from "node:assert/strict";
import { formatPaperTapeExport } from "../src/paperTapeExport";
import type { PaperTapeEntry } from "../src/paperTapeRecorder";

function entry(overrides: Partial<PaperTapeEntry> = {}): PaperTapeEntry {
  return {
    id: 1,
    outline: "TH",
    dictionary: "main.json",
    translation: "this",
    undo: 0,
    timestamp: 0,
    ...overrides,
  };
}

test("formats an empty tape as an empty JSON array", () => {
  assert.equal(formatPaperTapeExport([]), "[]\n");
});

test("formats entries as a JSON array preserving every field", () => {
  const entries = [entry({ outline: "TH", translation: "this" })];
  const output = formatPaperTapeExport(entries);

  assert.deepEqual(JSON.parse(output), entries);
});

test("output is valid, parseable JSON", () => {
  const entries = [entry({ translation: "cat", undo: 1 }), entry({ id: 2, translation: "dog" })];
  const output = formatPaperTapeExport(entries);

  assert.deepEqual(JSON.parse(output), entries);
});
