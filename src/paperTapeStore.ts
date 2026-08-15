import type { PaperTapeEntry } from "./paperTapeRecorder";
import type { PaperTapeWordAnchor } from "./paperTapeWordTracker";

/** Backing store for paper tape entries/anchors, shared and written concurrently by every VS Code window on the same workspace. */
export interface PaperTapeStore {
  loadEntries(): PaperTapeEntry[];
  /** Up to `limit` entries immediately older than `cursor` (or the most recent `limit` if `cursor` is undefined), oldest first. */
  loadEntriesBefore(cursor: PaperTapeEntry | undefined, limit: number): PaperTapeEntry[];
  appendEntry(entry: PaperTapeEntry): void;
  /** Same as calling `appendEntry` for each entry, but as a single commit - for flushing a batch of buffered entries at once. */
  appendEntries(entries: readonly PaperTapeEntry[]): void;
  clearEntries(): void;

  loadAnchors(): PaperTapeWordAnchor[];
  upsertAnchor(anchor: PaperTapeWordAnchor): void;
  clearAnchors(): void;

  close(): void;
}
