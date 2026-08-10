import * as vscode from "vscode";
import { createDebouncedPersister, type DebouncedPersister } from "./debouncedPersist";
import { JavelinHidDevice, type JavPaperTapeEventDetail } from "./javelinHidDevice";
import { logDebug, logError, logInfo } from "./logger";
import { JavelinSettings } from "./settings";
import { entryIdentity, WordGrouper } from "./paperTapeWordGrouping";

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

const PERSISTED_ENTRIES_KEY = "javelin.paperTapeEntries";
const PERSIST_DEBOUNCE_MS = 500;

/** Unions on-disk entries with this window's, so persisting never discards history it didn't produce. Deliberately unbounded. */
function mergeForPersist(onDisk: PaperTapeEntry[], current: PaperTapeEntry[]): PaperTapeEntry[] {
  const seen = new Set<string>();
  const merged: PaperTapeEntry[] = [];
  for (const entry of [...onDisk, ...current]) {
    const key = entryIdentity(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(entry);
  }

  merged.sort((a, b) => a.timestamp - b.timestamp);
  return merged.map((entry, index) => ({ ...entry, id: index + 1 }));
}

/**
 * Buffers paper_tape strokes as they arrive from the device, independent of whether
 * the Paper Tape panel is open, so reopening the panel shows everything recorded
 * while VS Code had focus in the meantime.
 *
 * When `settings.persistPerWindow` is on, entries are also saved to `workspaceState`,
 * which is shared by every window on this workspace - persisting merges with disk
 * (see `mergeForPersist`) rather than overwriting it, so windows don't clobber
 * each other's history.
 */
export class PaperTapeRecorder {
  private readonly entries: PaperTapeEntry[] = [];
  private nextId = 1;
  private readonly listeners = new Set<(entry: PaperTapeEntry) => void>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly persister: DebouncedPersister = createDebouncedPersister(PERSIST_DEBOUNCE_MS, () =>
    this.persistEntries()
  );
  private pendingClear = false;
  private readonly wordGrouper = new WordGrouper();

  constructor(
    private readonly device: JavelinHidDevice | undefined,
    private readonly settings: JavelinSettings,
    private readonly getFocused: () => boolean = () => vscode.window.state.focused,
    private readonly workspaceState?: vscode.Memento,
    private readonly getEditingFile: () => boolean = () =>
      !!vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri.scheme === "file"
  ) {
    logInfo(
      `PaperTapeRecorder initializing: persistPerWindow=${this.settings.persistPerWindow}, ` +
        `workspaceState=${this.workspaceState ? "available" : "unavailable"}`
    );

    if (this.settings.persistPerWindow) {
      this.loadPersistedEntries();
    }

    if (this.device) {
      this.device.on("paper_tape", this.onPaperTape);
    }

    this.disposables.push(
      this.settings.onDidChange((snapshot) => {
        // Covers turning the setting on mid-session, so what's already buffered
        // gets saved instead of only strokes recorded from this point on.
        if (snapshot.persistPerWindow) this.schedulePersist();
      })
    );
  }

  getEntries(): readonly PaperTapeEntry[] {
    return this.entries;
  }

  onAppend(listener: (entry: PaperTapeEntry) => void): vscode.Disposable {
    this.listeners.add(listener);
    return new vscode.Disposable(() => this.listeners.delete(listener));
  }

  /** See `WordGrouper.onWordUpdated` - used by the word/anchor tracker to (re)anchor words in the document. */
  onWordUpdated(listener: (wordId: string, entries: readonly PaperTapeEntry[]) => void): vscode.Disposable {
    const unsubscribe = this.wordGrouper.onWordUpdated(listener);
    return new vscode.Disposable(unsubscribe);
  }

  clear(): void {
    this.entries.length = 0;
    if (this.settings.persistPerWindow) {
      this.pendingClear = true;
      this.schedulePersist();
    }
  }

  async dispose(): Promise<void> {
    if (this.device) {
      this.device.off("paper_tape", this.onPaperTape);
    }
    this.listeners.clear();
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
    await this.persister.flush();
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
      timestamp: Date.now(),
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
      timestamp: Date.now(),
      kind: "text",
      synthetic: true,
      documentUri,
    };
    this.recordEntry(entry);
    return entry;
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

    if (this.settings.persistPerWindow) {
      this.schedulePersist();
    }

    for (const listener of this.listeners) {
      listener(entry);
    }
  }

  private loadPersistedEntries(): void {
    if (!this.workspaceState) return;

    const saved = this.workspaceState.get<PaperTapeEntry[]>(PERSISTED_ENTRIES_KEY, []);
    logInfo(`Loaded ${saved.length} persisted paper tape entries from workspaceState`);
    if (saved.length === 0) return;

    this.entries.push(...saved);
    // Recompute rather than trust whatever's on disk - kind/wordId are deterministically derivable from the other fields.
    for (const entry of this.entries) {
      try {
        this.wordGrouper.onEntry(entry);
      } catch (err) {
        logError("PaperTapeRecorder: word grouping failed replaying a persisted stroke, leaving it unclassified", err);
      }
    }
    this.nextId = this.entries.reduce((max, e) => Math.max(max, e.id), 0) + 1;
  }

  private schedulePersist(): void {
    if (!this.workspaceState) return;
    this.persister.schedule();
  }

  private async persistEntries(): Promise<void> {
    if (!this.workspaceState) return;

    // A clear wipes disk state too, instead of merging it back in.
    const clearing = this.pendingClear;
    this.pendingClear = false;

    const onDisk = clearing ? [] : this.workspaceState.get<PaperTapeEntry[]>(PERSISTED_ENTRIES_KEY, []);
    const merged = mergeForPersist(onDisk, this.entries);

    await this.workspaceState.update(PERSISTED_ENTRIES_KEY, merged);
    logInfo(`Persisted ${merged.length} paper tape entries to workspaceState${clearing ? " (after clear)" : ""}`);
  }
}
