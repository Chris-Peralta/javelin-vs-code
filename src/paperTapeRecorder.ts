import * as vscode from "vscode";
import { JavelinHidDevice, type JavPaperTapeEventDetail } from "./javelinHidDevice";
import { JavelinSettings } from "./settings";

export interface PaperTapeEntry {
  id: number;
  outline: string;
  dictionary: string;
  translation: string;
  undo: number;
  timestamp: number;
}

const PERSISTED_ENTRIES_KEY = "javelin.paperTapeEntries";
const PERSIST_DEBOUNCE_MS = 500;
const MAX_ENTRIES = 5000;

/** Identifies an entry by content, since `id` is only unique within one window's memory. */
function entryIdentity(entry: PaperTapeEntry): string {
  return `${entry.timestamp}|${entry.outline}|${entry.dictionary}|${entry.translation}|${entry.undo}`;
}

/** Unions on-disk entries with this window's, so persisting never discards history it didn't produce. */
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
  return merged.slice(-MAX_ENTRIES).map((entry, index) => ({ ...entry, id: index + 1 }));
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
  private persistTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingClear = false;

  constructor(
    private readonly device: JavelinHidDevice | undefined,
    private readonly settings: JavelinSettings,
    private readonly getFocused: () => boolean = () => vscode.window.state.focused,
    private readonly workspaceState?: vscode.Memento
  ) {
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
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
      await this.persistEntries();
    }
  }

  private onPaperTape = (ev: CustomEvent<JavPaperTapeEventDetail>) => {
    // Unless background monitoring is enabled, only record strokes while VS Code is focused.
    if (!this.settings.backgroundMonitoring && !this.getFocused()) return;

    const detail = ev.detail;
    const entry: PaperTapeEntry = {
      id: this.nextId++,
      outline: detail.outline ?? "",
      dictionary: detail.dictionary ?? "",
      translation: detail.translation ?? "",
      undo: detail.undo ?? 0,
      timestamp: Date.now(),
    };

    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.shift();
    }

    if (this.settings.persistPerWindow) {
      this.schedulePersist();
    }

    for (const listener of this.listeners) {
      listener(entry);
    }
  };

  private loadPersistedEntries(): void {
    if (!this.workspaceState) return;

    const saved = this.workspaceState.get<PaperTapeEntry[]>(PERSISTED_ENTRIES_KEY, []);
    if (saved.length === 0) return;

    this.entries.push(...saved.slice(-MAX_ENTRIES));
    this.nextId = this.entries.reduce((max, e) => Math.max(max, e.id), 0) + 1;
  }

  private schedulePersist(): void {
    if (!this.workspaceState || this.persistTimer) return;

    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      void this.persistEntries();
    }, PERSIST_DEBOUNCE_MS);
  }

  private async persistEntries(): Promise<void> {
    if (!this.workspaceState) return;

    // A clear wipes disk state too, instead of merging it back in.
    const clearing = this.pendingClear;
    this.pendingClear = false;

    const onDisk = clearing ? [] : this.workspaceState.get<PaperTapeEntry[]>(PERSISTED_ENTRIES_KEY, []);
    const merged = mergeForPersist(onDisk, this.entries);

    await this.workspaceState.update(PERSISTED_ENTRIES_KEY, merged);
  }
}
