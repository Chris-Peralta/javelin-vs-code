import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { logError, logInfo } from "./logger";

/** Best-effort signal for whether *this* window has OS focus - cross-window coordination only corrects a `vscode.window.state.focused` stuck true after a missed blur event. */
/** Each window writes only its own file, so concurrent writers never race; see applySharedState() for how the holder is derived. */
/** Entries older than this are treated as a dead window's leftovers, not a live claim. */
const MAX_SHARED_STATE_AGE_MS = 5000;
const FOCUS_FILE_PREFIX = "focus-";
const FOCUS_FILE_SUFFIX = ".json";

interface FocusEntry {
  focused: boolean;
  timestamp: number;
}

type SharedFocusState = Record<string, FocusEntry>;

/** The slice of `vscode.window` this class depends on - real `vscode.window` by default, injectable so tests can simulate more than one independent window. */
export type WindowStateSource = Pick<typeof vscode.window, "state" | "onDidChangeWindowState">;

export class AppFocusTracker implements vscode.Disposable {
  private readonly ownFilePath: string;
  private readonly lockDir: string;
  private readonly windowId: string;
  private focused: boolean;
  private readonly disposables: vscode.Disposable[] = [];
  private dirWatcher: fs.FSWatcher | undefined;
  private disposed = false;
  private writeQueue: Promise<void> = Promise.resolve();

  /** @param windowId - Identifies this window's own file in the lock directory; defaults to this process's pid, one per window. */
  constructor(
    context: vscode.ExtensionContext,
    windowId: string = String(process.pid),
    windowStateSource: WindowStateSource = vscode.window
  ) {
    this.windowId = windowId;
    this.focused = windowStateSource.state.focused;
    this.lockDir = context.globalStorageUri.fsPath;
    this.ownFilePath = path.join(this.lockDir, `${FOCUS_FILE_PREFIX}${encodeURIComponent(windowId)}${FOCUS_FILE_SUFFIX}`);

    this.disposables.push(
      windowStateSource.onDidChangeWindowState((e) => this.onLocalStateChange(e.focused))
    );

    this.init().catch((err) => {
      logError("AppFocusTracker: setup failed, falling back to this window's own focus state", err);
    });
  }

  /** Best-effort signal for whether this specific window currently has OS focus. */
  isFocused(): boolean {
    return this.focused;
  }

  dispose(): void {
    this.disposed = true;
    this.dirWatcher?.close();
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }

  private async init(): Promise<void> {
    await fs.promises.mkdir(this.lockDir, { recursive: true });
    if (this.disposed) return;

    // Publish before reading, so a window with genuinely fresh focus isn't outvoted by an older sibling claim.
    await this.writeSharedState(this.focused);
    if (this.disposed) return;

    // Watch the directory, not a specific file, so this doesn't throw before any window has written one,
    // and so it picks up every sibling window's file, not just this window's own.
    const dirWatcher = fs.watch(this.lockDir, (_event, filename) => {
      if (this.disposed) return;
      if (filename && filename.startsWith(FOCUS_FILE_PREFIX) && filename.endsWith(FOCUS_FILE_SUFFIX)) {
        void this.readSharedState();
      }
    });
    if (this.disposed) {
      dirWatcher.close();
      return;
    }
    this.dirWatcher = dirWatcher;

    await this.readSharedState();
  }

  private onLocalStateChange(focused: boolean): void {
    logInfo(`AppFocusTracker: local window focus changed to ${focused}`);
    // Trust our own local observation immediately; the write below reconciles it against siblings shortly after.
    this.focused = focused;
    void this.writeSharedState(focused);
  }

  private async readSharedState(): Promise<void> {
    let files: string[];
    try {
      files = await fs.promises.readdir(this.lockDir);
    } catch {
      // Directory may not exist yet.
      return;
    }

    const data: SharedFocusState = {};
    for (const file of files) {
      if (!file.startsWith(FOCUS_FILE_PREFIX) || !file.endsWith(FOCUS_FILE_SUFFIX)) continue;
      const id = decodeURIComponent(file.slice(FOCUS_FILE_PREFIX.length, -FOCUS_FILE_SUFFIX.length));
      try {
        const raw = await fs.promises.readFile(path.join(this.lockDir, file), "utf8");
        data[id] = JSON.parse(raw) as FocusEntry;
      } catch {
        // File may have been mid-write when read, or removed since readdir(); skip it this round.
      }
    }

    this.applySharedState(data);
  }

  /** Derives the current holder from every window's latest entry: a claim always wins; a release only clears the holder it matches. */
  private applySharedState(data: SharedFocusState): void {
    const now = Date.now();
    const fresh = Object.entries(data)
      .filter((entry): entry is [string, FocusEntry] => {
        const [, e] = entry;
        return (
          !!e &&
          typeof e.focused === "boolean" &&
          typeof e.timestamp === "number" &&
          now - e.timestamp <= MAX_SHARED_STATE_AGE_MS
        );
      })
      .sort((a, b) => a[1].timestamp - b[1].timestamp);

    // Nothing fresh to go on - keep the current belief rather than defaulting to unfocused.
    if (fresh.length === 0) return;

    let holder: string | null = null;
    for (const [id, entry] of fresh) {
      if (entry.focused) {
        holder = id;
      } else if (holder === id) {
        holder = null;
      }
    }

    const focused = holder === this.windowId;
    if (focused !== this.focused) {
      logInfo(`AppFocusTracker: derived focus changed ${this.focused} -> ${focused} (holder ${holder ?? "none"})`);
    }
    this.focused = focused;
  }

  private writeSharedState(focused: boolean): Promise<void> {
    const timestamp = Date.now();

    // Chain writes so they land in call order; no read-modify-write needed since this file is ours alone.
    this.writeQueue = this.writeQueue.then(async () => {
      try {
        await fs.promises.writeFile(this.ownFilePath, JSON.stringify({ focused, timestamp }));
      } catch (err) {
        logError("AppFocusTracker: failed to write shared focus state", err);
      }
    });
    return this.writeQueue;
  }
}
