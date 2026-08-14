import * as vscode from "vscode";
import { createDebouncer, type Debouncer } from "./debounce";
import { Emitter } from "./emitter";
import { JavelinHidDevice, type JavPaperTapeEventDetail } from "./javelinHidDevice";
import { logDebug, logError, logInfo } from "./logger";
import { JavelinSettings } from "./settings";
import { entryIdentity, WordGrouper } from "./paperTapeWordGrouping";
import type { PaperTapeStore } from "./paperTapeStore";

export type PaperTapeEntryKind = "text" | "command" | "keyboard" | "undo";

export interface PaperTapeEntry {
  id: number;
  outline: string;
  dictionary: string;
  translation: string;
  undo: number;
  timestamp: number;
  /** Classification for display/grouping - see paperTapeWordGrouping.ts. */
  kind: PaperTapeEntryKind;
  /** Groups entries that combine into one document position (a "word"). */
  wordId?: string;
  /** True only for placeholder entries created by the insert-before/insert-after commands. */
  synthetic?: boolean;
  /** The active editor's document at record time. */
  documentUri?: string;
}

const PERSIST_DEBOUNCE_MS = 500;
/** Caps the live in-memory buffer (`getEntries()`). Independent of persistence - persisted history is unbounded and readable in full via `getAllEntries()` when persistPerWindow is on. */
const MAX_ENTRIES = 5000;

export interface PaperTapeEntriesPage {
  entries: readonly PaperTapeEntry[];
  /** True if there's at least one more (older) entry beyond this page. */
  hasMore: boolean;
}

/** Buffers paper_tape strokes independent of whether the panel is open; when persistPerWindow is on, also appends to the shared store, which is the source of truth for what's on disk. */
export class PaperTapeRecorder {
  private readonly entries: PaperTapeEntry[] = [];
  private nextId = 1;
  private lastTimestamp = 0;
  private readonly appendEmitter = new Emitter<PaperTapeEntry>();
  private readonly clearEmitter = new Emitter();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly pendingEntries: PaperTapeEntry[] = [];
  private readonly persister: Debouncer = createDebouncer(PERSIST_DEBOUNCE_MS, () => this.persistEntries());
  private readonly wordGrouper = new WordGrouper();

  constructor(
    private readonly device: JavelinHidDevice | undefined,
    private readonly settings: JavelinSettings,
    private readonly getFocused: () => boolean = () => vscode.window.state.focused,
    private readonly store?: PaperTapeStore,
    private readonly getEditingFile: () => boolean = () =>
      !!vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri.scheme === "file",
    private readonly now: () => number = () => Date.now()
  ) {
    logInfo(
      `PaperTapeRecorder initializing: persistPerWindow=${this.settings.persistPerWindow}, ` +
        `store=${this.store ? "available" : "unavailable"}`
    );

    if (this.settings.persistPerWindow) {
      this.loadPersistedEntries();
    }

    if (this.device) {
      this.device.on("paper_tape", this.onPaperTape);
    }

    let lastPersistPerWindow = this.settings.persistPerWindow;
    this.disposables.push(
      this.settings.onDidChange((snapshot) => {
        // Only react to the off->on transition, so what was buffered before persistence
        // was ever turned on for this window also gets saved, not just strokes recorded
        // from this point on - and an unrelated setting change doesn't requeue everything.
        if (snapshot.persistPerWindow && !lastPersistPerWindow) {
          this.pendingEntries.push(...this.entries);
          this.schedulePersist();
        }
        lastPersistPerWindow = snapshot.persistPerWindow;
      })
    );
  }

  /** The live buffer, capped to the most recent MAX_ENTRIES - fast, but may be missing older history. */
  getEntries(): readonly PaperTapeEntry[] {
    return this.entries;
  }

  /** Every entry ever recorded this workspace, uncapped - falls back to the capped live buffer when there's nowhere durable to read the rest from. */
  getAllEntries(): readonly PaperTapeEntry[] {
    if (!this.store || !this.settings.persistPerWindow) return this.entries;

    const persisted = this.store.loadEntries();
    const seen = new Set(persisted.map(entryIdentity));
    const unflushed = this.pendingEntries.filter((entry) => !seen.has(entryIdentity(entry)));
    return [...persisted, ...unflushed].sort((a, b) => a.timestamp - b.timestamp);
  }

  /** The most recent `limit` entries, for a paginated view; falls back to the live buffer when there's nowhere durable to read from. */
  getRecentEntries(limit: number): PaperTapeEntriesPage {
    if (!this.store || !this.settings.persistPerWindow) {
      const entries = this.entries.length > limit ? this.entries.slice(this.entries.length - limit) : this.entries;
      return { entries, hasMore: false };
    }
    // Ask for one extra row to detect whether there's anything older than this page.
    return this.mergeWithPending(this.store.loadEntriesBefore(undefined, limit + 1), undefined, limit);
  }

  /** The `limit` entries immediately older than `before` - for infinite scroll. Always empty when there's nowhere durable to read from. */
  getOlderEntries(before: PaperTapeEntry, limit: number): PaperTapeEntriesPage {
    if (!this.store || !this.settings.persistPerWindow) return { entries: [], hasMore: false };
    return this.mergeWithPending(this.store.loadEntriesBefore(before, limit + 1), before, limit);
  }

  /** Combines a store read with any still-unflushed `pendingEntries` before `cursor`, so a page mid-debounce doesn't over-report `hasMore`. */
  private mergeWithPending(rawPersisted: readonly PaperTapeEntry[], cursor: PaperTapeEntry | undefined, limit: number): PaperTapeEntriesPage {
    const hasMoreOnDisk = rawPersisted.length > limit;
    const persisted = hasMoreOnDisk ? rawPersisted.slice(rawPersisted.length - limit) : rawPersisted;

    const seen = new Set(persisted.map(entryIdentity));
    const pendingBeforeCursor = this.pendingEntries.filter((entry) => {
      if (seen.has(entryIdentity(entry))) return false;
      if (!cursor) return true;
      return entry.timestamp !== cursor.timestamp
        ? entry.timestamp < cursor.timestamp
        : entryIdentity(entry) < entryIdentity(cursor);
    });

    const merged = [...persisted, ...pendingBeforeCursor].sort((a, b) => a.timestamp - b.timestamp);
    if (merged.length <= limit) return { entries: merged, hasMore: hasMoreOnDisk };
    // Not-yet-flushed entries pushed this page over the limit - trim the oldest back off;
    // they're still reachable via getOlderEntries from the new front of the page.
    return { entries: merged.slice(merged.length - limit), hasMore: true };
  }

  onAppend(listener: (entry: PaperTapeEntry) => void): vscode.Disposable {
    return this.appendEmitter.event(listener);
  }

  /** Fires after `clear()` wipes the buffer/store, so listeners tracking derived state (e.g. word anchors, the open panel) can reset too. */
  onClear(listener: () => void): vscode.Disposable {
    return this.clearEmitter.event(listener);
  }

  /** See `WordGrouper.onWordUpdated` - used by the word/anchor tracker to (re)anchor words in the document. */
  onWordUpdated(listener: (wordId: string, entries: readonly PaperTapeEntry[]) => void): vscode.Disposable {
    const unsubscribe = this.wordGrouper.onWordUpdated(listener);
    return new vscode.Disposable(unsubscribe);
  }

  clear(): void {
    this.entries.length = 0;
    this.pendingEntries.length = 0;
    if (this.settings.persistPerWindow && this.store) {
      // Cancel rather than flush: a scheduled persist from just before clear() would
      // otherwise re-append entries this clear is meant to remove.
      this.persister.cancel();
      this.store.clearEntries();
    }
    this.clearEmitter.fire();
  }

  async dispose(): Promise<void> {
    if (this.device) {
      this.device.off("paper_tape", this.onPaperTape);
    }
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
    await this.persister.flush();
    this.appendEmitter.dispose();
    this.clearEmitter.dispose();
  }

  private onPaperTape = (ev: CustomEvent<JavPaperTapeEventDetail>) => {
    const detail = ev.detail;

    // Unless background monitoring is enabled, only record strokes while VS Code is focused.
    if (!this.settings.backgroundMonitoring && !this.getFocused()) {
      logDebug(`Dropped paper_tape event (window not focused): outline="${detail.outline ?? ""}"`);
      return;
    }

    if (this.settings.onlyRecordWhileEditingFile && !this.getEditingFile()) {
      logDebug(`Dropped paper_tape event (not editing a file): outline="${detail.outline ?? ""}"`);
      return;
    }

    const entry: PaperTapeEntry = {
      id: this.nextId++,
      outline: detail.outline ?? "",
      dictionary: detail.dictionary ?? "",
      translation: detail.translation ?? "",
      undo: detail.undo ?? 0,
      timestamp: this.nextTimestamp(),
      kind: "text",
      documentUri: vscode.window.activeTextEditor?.document.uri.toString(),
    };
    this.recordEntry(entry);
  };

  /** Appends a placeholder entry for text inserted via the paper tape's insert-before/after commands - no real stroke happened. */
  appendSynthetic(text: string, documentUri: string): PaperTapeEntry {
    const entry: PaperTapeEntry = {
      id: this.nextId++,
      outline: "",
      dictionary: "",
      translation: text,
      undo: 0,
      timestamp: this.nextTimestamp(),
      kind: "text",
      synthetic: true,
      documentUri,
    };
    this.recordEntry(entry);
    return entry;
  }

  /** Strictly increasing, even if called twice within the same millisecond - keeps entries recorded by this window orderable without ties, which the store's keyset pagination cursor depends on. */
  private nextTimestamp(): number {
    this.lastTimestamp = Math.max(this.now(), this.lastTimestamp + 1);
    return this.lastTimestamp;
  }

  private recordEntry(entry: PaperTapeEntry): void {
    try {
      // Word grouping is enrichment, not part of the immutable raw log - it must never be able to stop a stroke from being recorded.
      this.wordGrouper.onEntry(entry);
    } catch (err) {
      logError("PaperTapeRecorder: word grouping failed for a stroke, recording it unclassified", err);
    }

    logInfo(`Recorded paper_tape event: outline="${entry.outline}" translation="${entry.translation}"`);
    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) {
      // Only trims the live buffer - independent of pendingEntries/the store, so this never drops anything not yet persisted.
      this.entries.shift();
    }

    if (this.settings.persistPerWindow) {
      this.pendingEntries.push(entry);
      this.schedulePersist();
    }

    this.appendEmitter.fire(entry);
  }

  private loadPersistedEntries(): void {
    if (!this.store) return;

    const saved = this.store.loadEntries();
    logInfo(`Loaded ${saved.length} persisted paper tape entries from the store`);
    if (saved.length === 0) return;

    // nextId and lastTimestamp must stay clear of every id/timestamp on disk, not just the recent ones loaded into the live buffer below.
    this.nextId = saved.reduce((max, e) => Math.max(max, e.id), 0) + 1;
    this.lastTimestamp = saved.reduce((max, e) => Math.max(max, e.timestamp), 0);

    const recent = saved.length > MAX_ENTRIES ? saved.slice(saved.length - MAX_ENTRIES) : saved;
    this.entries.push(...recent);
    // Recomputed rather than trusted from disk - kind/wordId are deterministically derivable from the other fields; only the loaded (recent) entries need replaying.
    for (const entry of this.entries) {
      try {
        this.wordGrouper.onEntry(entry);
      } catch (err) {
        logError("PaperTapeRecorder: word grouping failed replaying a persisted stroke, leaving it unclassified", err);
      }
    }
  }

  private schedulePersist(): void {
    if (!this.store) return;
    this.persister.schedule();
  }

  private async persistEntries(): Promise<void> {
    if (!this.store || this.pendingEntries.length === 0) return;

    this.store.appendEntries(this.pendingEntries);
    logInfo(`Persisted ${this.pendingEntries.length} paper tape entries to the store`);
    this.pendingEntries.length = 0;
  }
}
