import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { logError } from "./logger";

/**
 * WORKAROUND - when a second
 * VS Code window is opened, `vscode.window.state.focused` can get stuck reporting
 * `true` for a window that has since lost real OS focus (e.g. to a non-VS Code app),
 * because that window never receives the corresponding blur event.
 *
 * This file fixes that.
 * 
 * To reproduce, revert this commit and open a second VS Code window, then switch to
 * another app. The paper tape will get logged to in the non-VS Code app.
 */
/** Older shared state is assumed to be leftover from a dead session, not a live sibling window. */
const MAX_SHARED_STATE_AGE_MS = 5000;

export class AppFocusTracker implements vscode.Disposable {
  private readonly lockFilePath: string;
  private readonly lockDir: string;
  private focused: boolean;
  private lastKnownTimestamp = 0;
  private readonly disposables: vscode.Disposable[] = [];
  private dirWatcher: fs.FSWatcher | undefined;
  private disposed = false;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(context: vscode.ExtensionContext) {
    this.focused = vscode.window.state.focused;
    this.lockDir = context.globalStorageUri.fsPath;
    this.lockFilePath = path.join(this.lockDir, "focus-state.json");

    this.disposables.push(
      vscode.window.onDidChangeWindowState((e) => this.onLocalStateChange(e.focused))
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

    // Watch the directory (rather than the file directly) so this doesn't throw if
    // no window has written the lock file yet.
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

    // Establish a baseline immediately, mainly for the case where this is the only
    // window open so far and it already has focus.
    await this.writeSharedState(this.focused);
  }

  private onLocalStateChange(focused: boolean): void {
    // Trust our own observation of our own window's focus unconditionally - it's
    // only *other* windows that can get stuck per the bug above.
    this.focused = focused;
    void this.writeSharedState(focused);
  }

  private async readSharedState(): Promise<void> {
    try {
      const raw = await fs.promises.readFile(this.lockFilePath, "utf8");
      const data = JSON.parse(raw) as { focused: boolean; timestamp: number };
      if (typeof data.focused !== "boolean" || data.timestamp < this.lastKnownTimestamp) return;

      // Don't let a stale leftover file (e.g. from a force-quit) beat lastKnownTimestamp's initial 0.
      if (Date.now() - data.timestamp > MAX_SHARED_STATE_AGE_MS) return;

      this.lastKnownTimestamp = data.timestamp;
      this.focused = data.focused;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (err) {
      // File may not exist yet, or a write from another window may be in flight; keep current state.
    }
  }

  private writeSharedState(focused: boolean): Promise<void> {
    const timestamp = Date.now();
    this.lastKnownTimestamp = timestamp;

    // Chain writes so they always land on disk in call order.
    this.writeQueue = this.writeQueue.then(async () => {
      try {
        await fs.promises.writeFile(this.lockFilePath, JSON.stringify({ focused, timestamp }));
      } catch (err) {
        logError("AppFocusTracker: failed to write shared focus state", err);
      }
    });
    return this.writeQueue;
  }
}
