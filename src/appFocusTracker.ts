import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { logError, logInfo } from "./logger";

/** Best-effort signal for whether VS Code (any window) has OS focus - works around `vscode.window.state.focused` getting stuck true for a window that lost focus without a blur event. */
/** Each window writes only its own entry (never a shared scalar), so one window's write can't clobber another's; see applySharedState() for how the holder is derived from that. */
/** Entries older than this are treated as a dead window's leftovers, not a live claim. */
const MAX_SHARED_STATE_AGE_MS = 5000;

interface FocusEntry {
  focused: boolean;
  timestamp: number;
}

type SharedFocusState = Record<string, FocusEntry>;

/** The slice of `vscode.window` this class depends on - real `vscode.window` by default, injectable so tests can simulate more than one independent window. */
export type WindowStateSource = Pick<typeof vscode.window, "state" | "onDidChangeWindowState">;

export class AppFocusTracker implements vscode.Disposable {
  private readonly lockFilePath: string;
  private readonly lockDir: string;
  private readonly windowId: string;
  private focused: boolean;
  private readonly disposables: vscode.Disposable[] = [];
  private dirWatcher: fs.FSWatcher | undefined;
  private disposed = false;
  private writeQueue: Promise<void> = Promise.resolve();

  /** @param windowId - Identifies this window's entry in the shared state; defaults to this process's pid, one per window. */
  constructor(
    context: vscode.ExtensionContext,
    windowId: string = String(process.pid),
    windowStateSource: WindowStateSource = vscode.window
  ) {
    this.windowId = windowId;
    this.focused = windowStateSource.state.focused;
    this.lockDir = context.globalStorageUri.fsPath;
    this.lockFilePath = path.join(this.lockDir, "focus-state.json");

    this.disposables.push(
      windowStateSource.onDidChangeWindowState((e) => this.onLocalStateChange(e.focused))
    );

    this.init().catch((err) => {
      logError("AppFocusTracker: setup failed, falling back to this window's own focus state", err);
    });
  }

  /** Best-effort signal for whether VS Code (any window) currently has OS focus. */
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

    await this.readSharedState();
    if (this.disposed) return;

    // Watch the directory, not the file, so this doesn't throw before any window has written it.
    const dirWatcher = fs.watch(this.lockDir, (_event, filename) => {
      if (this.disposed) return;
      if (filename === path.basename(this.lockFilePath)) {
        void this.readSharedState();
      }
    });
    if (this.disposed) {
      dirWatcher.close();
      return;
    }
    this.dirWatcher = dirWatcher;

    // Establish a baseline in case this is the only window open so far.
    await this.writeSharedState(this.focused);
  }

  private onLocalStateChange(focused: boolean): void {
    logInfo(`AppFocusTracker: local window focus changed to ${focused}`);
    // Trust our own local observation immediately; the write below reconciles it against siblings shortly after.
    this.focused = focused;
    void this.writeSharedState(focused);
  }

  private async readSharedState(): Promise<void> {
    try {
      const raw = await fs.promises.readFile(this.lockFilePath, "utf8");
      const data = JSON.parse(raw) as SharedFocusState;
      this.applySharedState(data);
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (err) {
      // File may not exist yet, or a write from another window may be in flight; keep current state.
    }
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

    const focused = holder !== null;
    if (focused !== this.focused) {
      logInfo(`AppFocusTracker: derived focus changed ${this.focused} -> ${focused} (holder ${holder ?? "none"})`);
    }
    this.focused = focused;
  }

  private writeSharedState(focused: boolean): Promise<void> {
    const timestamp = Date.now();

    // Chain writes so they land in call order, each merging with other windows' entries.
    this.writeQueue = this.writeQueue.then(async () => {
      try {
        let data: SharedFocusState = {};
        try {
          const raw = await fs.promises.readFile(this.lockFilePath, "utf8");
          data = JSON.parse(raw) as SharedFocusState;
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        } catch (err) {
          // No file yet.
        }

        data[this.windowId] = { focused, timestamp };
        await fs.promises.writeFile(this.lockFilePath, JSON.stringify(data));
      } catch (err) {
        logError("AppFocusTracker: failed to write shared focus state", err);
      }
    });
    return this.writeQueue;
  }
}
