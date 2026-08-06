import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { logError } from "./logger";

const SETTINGS_FILE_NAME = "settings.json";

export interface JavelinSettingsSnapshot {
  showTimestamps: boolean;
  backgroundMonitoring: boolean;
  persistPerWindow: boolean;
  suggestionsBackgroundMonitoring: boolean;
}

const DEFAULT_SNAPSHOT: JavelinSettingsSnapshot = {
  showTimestamps: false,
  backgroundMonitoring: false,
  persistPerWindow: false,
  suggestionsBackgroundMonitoring: false,
};

/**
 * Persisted (survives closing/reopening VS Code) user-toggleable settings for the
 * Javelin views, shared live across all VS Code windows via one JSON file in global
 * storage plus a directory watcher - globalState alone doesn't propagate a write to
 * an already-open sibling window. Every window reads and writes the same file (not
 * one file per window like AppFocusTracker), so writes re-read from disk first to
 * limit lost updates when sibling windows write different settings close together.
 */
export class JavelinSettings implements vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<JavelinSettingsSnapshot>();
  readonly onDidChange = this._onDidChange.event;

  private readonly dir: string;
  private readonly filePath: string;
  private cache: JavelinSettingsSnapshot;
  private dirWatcher: fs.FSWatcher | undefined;
  private disposed = false;

  // Serializes the read-then-write setters below, so concurrent calls can't both read stale state.
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(context: vscode.ExtensionContext) {
    this.dir = context.globalStorageUri.fsPath;
    this.filePath = path.join(this.dir, SETTINGS_FILE_NAME);
    this.cache = this.loadInitial();
    this.watch();
  }

  get showTimestamps(): boolean {
    return this.cache.showTimestamps;
  }

  async setShowTimestamps(value: boolean): Promise<void> {
    await this.enqueueWrite((current) => ({ ...current, showTimestamps: value }));
  }

  /** Only settable while `persistPerWindow` is off - see `setPersistPerWindow`. */
  get backgroundMonitoring(): boolean {
    return this.cache.backgroundMonitoring;
  }

  async setBackgroundMonitoring(value: boolean): Promise<void> {
    await this.enqueueWrite((current) => {
      if (value && current.persistPerWindow) {
        // Rejected, not auto-cleared - user must untick persistPerWindow first.
        return null;
      }
      return { ...current, backgroundMonitoring: value };
    });
  }

  /**
   * When enabled, each VS Code window persists its own paper tape (via
   * `workspaceState`, scoped to that window) instead of the tape living only in
   * memory for the session. Only settable while `backgroundMonitoring` is off - see
   * `setBackgroundMonitoring`.
   */
  get persistPerWindow(): boolean {
    return this.cache.persistPerWindow;
  }

  async setPersistPerWindow(value: boolean): Promise<void> {
    await this.enqueueWrite((current) => {
      if (value && current.backgroundMonitoring) {
        return null;
      }
      return { ...current, persistPerWindow: value };
    });
  }

  get suggestionsBackgroundMonitoring(): boolean {
    return this.cache.suggestionsBackgroundMonitoring;
  }

  async setSuggestionsBackgroundMonitoring(value: boolean): Promise<void> {
    await this.enqueueWrite((current) => ({ ...current, suggestionsBackgroundMonitoring: value }));
  }

  snapshot(): JavelinSettingsSnapshot {
    return { ...this.cache };
  }

  dispose(): void {
    this.disposed = true;
    this.dirWatcher?.close();
    this._onDidChange.dispose();
  }

  /** Reads the shared file synchronously so getters work right after construction. */
  private loadInitial(): JavelinSettingsSnapshot {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
    } catch (err) {
      logError("JavelinSettings: failed to create global storage directory", err);
      return DEFAULT_SNAPSHOT;
    }

    return this.readFileSync() ?? DEFAULT_SNAPSHOT;
  }

  private readFileSync(): JavelinSettingsSnapshot | undefined {
    try {
      return this.parseSnapshot(fs.readFileSync(this.filePath, "utf8"));
    } catch {
      return undefined;
    }
  }

  private async readFile(): Promise<JavelinSettingsSnapshot | undefined> {
    try {
      return this.parseSnapshot(await fs.promises.readFile(this.filePath, "utf8"));
    } catch {
      return undefined;
    }
  }

  private parseSnapshot(raw: string): JavelinSettingsSnapshot {
    const parsed = JSON.parse(raw) as Partial<JavelinSettingsSnapshot>;
    return {
      showTimestamps: !!parsed.showTimestamps,
      backgroundMonitoring: !!parsed.backgroundMonitoring,
      persistPerWindow: !!parsed.persistPerWindow,
      suggestionsBackgroundMonitoring: !!parsed.suggestionsBackgroundMonitoring,
    };
  }

  /** Watches the directory, not the file directly, so a briefly-absent file mid-write doesn't throw. */
  private watch(): void {
    try {
      this.dirWatcher = fs.watch(this.dir, (_event, filename) => {
        if (this.disposed) return;
        if (filename === SETTINGS_FILE_NAME) this.reloadFromDisk();
      });
      // Best-effort live sync only - never let this handle keep the process alive on its own.
      this.dirWatcher.unref();
    } catch (err) {
      logError("JavelinSettings: failed to watch global storage directory for cross-window updates", err);
    }
  }

  private reloadFromDisk(): void {
    const onDisk = this.readFileSync();
    if (!onDisk) return;
    if (
      onDisk.showTimestamps === this.cache.showTimestamps &&
      onDisk.backgroundMonitoring === this.cache.backgroundMonitoring &&
      onDisk.persistPerWindow === this.cache.persistPerWindow &&
      onDisk.suggestionsBackgroundMonitoring === this.cache.suggestionsBackgroundMonitoring
    ) {
      return;
    }
    this.cache = onDisk;
    this._onDidChange.fire(this.snapshot());
  }

  /** Runs `mutate` after any already-queued write; `mutate` returns `null` to reject the write, or the next snapshot to persist. */
  private async enqueueWrite(
    mutate: (current: JavelinSettingsSnapshot) => JavelinSettingsSnapshot | null
  ): Promise<void> {
    const run = this.writeQueue.then(async () => {
      // Re-read from disk rather than trusting `this.cache`, which may not yet reflect a
      // sibling window's write that landed since our last watcher-triggered reload.
      const current = (await this.readFile()) ?? this.cache;
      const next = mutate(current);
      if (!next) return false;
      try {
        await fs.promises.writeFile(this.filePath, JSON.stringify(next));
      } catch (err) {
        logError("JavelinSettings: failed to write settings file", err);
        return false;
      }
      this.cache = next;
      return true;
    });
    this.writeQueue = run.then(
      () => undefined,
      () => undefined
    );

    const shouldFire = await run;
    if (shouldFire) {
      this._onDidChange.fire(this.snapshot());
    }
  }
}
