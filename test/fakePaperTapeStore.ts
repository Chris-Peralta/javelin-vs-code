import type { PaperTapeEntry } from "../src/paperTapeRecorder";
import type { PaperTapeWordAnchor } from "../src/paperTapeWordTracker";
import type { PaperTapeStore } from "../src/paperTapeStore";
import { entryIdentity } from "../src/paperTapeWordGrouping";

/** Minimal stand-in for a real PaperTapeStore; instances sharing a `shared` argument model two windows on the same db file. */
export class FakePaperTapeStore implements PaperTapeStore {
  private readonly entries: Map<string, PaperTapeEntry>;
  private readonly anchors: Map<string, PaperTapeWordAnchor>;

  constructor(shared?: FakePaperTapeStore) {
    this.entries = shared?.entries ?? new Map();
    this.anchors = shared?.anchors ?? new Map();
  }

  loadEntries(): PaperTapeEntry[] {
    return this.sorted();
  }

  loadEntriesBefore(cursor: PaperTapeEntry | undefined, limit: number): PaperTapeEntry[] {
    const all = this.sorted();
    const before = cursor ? all.filter((e) => this.compareKey(e) < this.compareKey(cursor)) : all;
    return before.slice(Math.max(0, before.length - limit));
  }

  private sorted(): PaperTapeEntry[] {
    return [...this.entries.values()].sort((a, b) => (this.compareKey(a) < this.compareKey(b) ? -1 : 1));
  }

  private compareKey(entry: PaperTapeEntry): string {
    // Zero-padded so numeric timestamp order matches string order, then identity breaks same-millisecond ties.
    return `${String(entry.timestamp).padStart(20, "0")}|${entryIdentity(entry)}`;
  }

  appendEntry(entry: PaperTapeEntry): void {
    this.entries.set(entryIdentity(entry), entry);
  }

  appendEntries(entries: readonly PaperTapeEntry[]): void {
    for (const entry of entries) this.appendEntry(entry);
  }

  clearEntries(): void {
    this.entries.clear();
  }

  loadAnchors(): PaperTapeWordAnchor[] {
    return [...this.anchors.values()];
  }

  upsertAnchor(anchor: PaperTapeWordAnchor): void {
    this.anchors.set(anchor.wordId, anchor);
  }

  clearAnchors(): void {
    this.anchors.clear();
  }

  close(): void {}
}
