import * as vscode from "vscode";

const SHOW_TIMESTAMPS_KEY = "javelin.showTimestamps";
const BACKGROUND_MONITORING_KEY = "javelin.backgroundMonitoring";
const PERSIST_PER_WINDOW_KEY = "javelin.persistPerWindow";

export interface JavelinSettingsSnapshot {
  showTimestamps: boolean;
  backgroundMonitoring: boolean;
  persistPerWindow: boolean;
}

/**
 * Persisted (survives closing/reopening VS Code) user-toggleable settings for the
 * Javelin views, backed by `ExtensionContext.globalState`.
 */
export class JavelinSettings {
  private readonly _onDidChange = new vscode.EventEmitter<JavelinSettingsSnapshot>();
  readonly onDidChange = this._onDidChange.event;

  // Serializes the read-then-write setters below, so concurrent calls can't both read stale state.
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly context: vscode.ExtensionContext) {}

  get showTimestamps(): boolean {
    return this.context.globalState.get<boolean>(SHOW_TIMESTAMPS_KEY, false);
  }

  async setShowTimestamps(value: boolean): Promise<void> {
    await this.enqueueWrite(async () => {
      await this.context.globalState.update(SHOW_TIMESTAMPS_KEY, value);
      return true;
    });
  }

  /** Only settable while `persistPerWindow` is off - see `setPersistPerWindow`. */
  get backgroundMonitoring(): boolean {
    return this.context.globalState.get<boolean>(BACKGROUND_MONITORING_KEY, false);
  }

  async setBackgroundMonitoring(value: boolean): Promise<void> {
    await this.enqueueWrite(async () => {
      if (value && this.persistPerWindow) {
        // Rejected, not auto-cleared, so the user has to explicitly untick
        // persistPerWindow first rather than have it vanish out from under them.
        return false;
      }
      await this.context.globalState.update(BACKGROUND_MONITORING_KEY, value);
      return true;
    });
  }

  /**
   * When enabled, each VS Code window persists its own paper tape (via
   * `workspaceState`, scoped to that window) instead of the tape living only in
   * memory for the session. Only settable while `backgroundMonitoring` is off - see
   * `setBackgroundMonitoring`.
   */
  get persistPerWindow(): boolean {
    return this.context.globalState.get<boolean>(PERSIST_PER_WINDOW_KEY, false);
  }

  async setPersistPerWindow(value: boolean): Promise<void> {
    await this.enqueueWrite(async () => {
      if (value && this.backgroundMonitoring) {
        return false;
      }
      await this.context.globalState.update(PERSIST_PER_WINDOW_KEY, value);
      return true;
    });
  }

  /** Runs `mutate` after any already-queued write, so reads inside it see a fully-settled prior state. */
  private async enqueueWrite(mutate: () => Promise<boolean>): Promise<void> {
    const run = this.writeQueue.then(mutate);
    this.writeQueue = run.then(
      () => undefined,
      () => undefined
    );

    const shouldFire = await run;
    if (shouldFire) {
      this._onDidChange.fire(this.snapshot());
    }
  }

  snapshot(): JavelinSettingsSnapshot {
    return {
      showTimestamps: this.showTimestamps,
      backgroundMonitoring: this.backgroundMonitoring,
      persistPerWindow: this.persistPerWindow,
    };
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}
