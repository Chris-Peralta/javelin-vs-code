import * as vscode from "vscode";

const SHOW_TIMESTAMPS_KEY = "javelin.showTimestamps";
const BACKGROUND_MONITORING_KEY = "javelin.backgroundMonitoring";

export interface JavelinSettingsSnapshot {
  showTimestamps: boolean;
  backgroundMonitoring: boolean;
}

/**
 * Persisted (survives closing/reopening VS Code) user-toggleable settings for the
 * Javelin views, backed by `ExtensionContext.globalState`.
 */
export class JavelinSettings {
  private readonly _onDidChange = new vscode.EventEmitter<JavelinSettingsSnapshot>();
  readonly onDidChange = this._onDidChange.event;

  constructor(private readonly context: vscode.ExtensionContext) {}

  get showTimestamps(): boolean {
    return this.context.globalState.get<boolean>(SHOW_TIMESTAMPS_KEY, false);
  }

  async setShowTimestamps(value: boolean): Promise<void> {
    await this.context.globalState.update(SHOW_TIMESTAMPS_KEY, value);
    this._onDidChange.fire(this.snapshot());
  }

  get backgroundMonitoring(): boolean {
    return this.context.globalState.get<boolean>(BACKGROUND_MONITORING_KEY, false);
  }

  async setBackgroundMonitoring(value: boolean): Promise<void> {
    await this.context.globalState.update(BACKGROUND_MONITORING_KEY, value);
    this._onDidChange.fire(this.snapshot());
  }

  snapshot(): JavelinSettingsSnapshot {
    return { showTimestamps: this.showTimestamps, backgroundMonitoring: this.backgroundMonitoring };
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}
