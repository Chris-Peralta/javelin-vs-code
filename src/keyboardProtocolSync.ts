import * as vscode from "vscode";
import type { JavelinHidDevice } from "./javelinHidDevice";
import { logError } from "./logger";

const CONFIG_SECTION = "javelin";
const COMPATIBILITY_MODE_SETTING = "compatibilityMode";

/** Pushes `javelin.compatibilityMode` to the device on connect and on setting change. */
export class KeyboardProtocolSync implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly device: JavelinHidDevice | undefined) {
    if (!this.device) return;

    this.device.on("connected", this.onConnected);
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(`${CONFIG_SECTION}.${COMPATIBILITY_MODE_SETTING}`)) void this.push();
      })
    );
  }

  dispose(): void {
    this.device?.off("connected", this.onConnected);
    while (this.disposables.length) this.disposables.pop()?.dispose();
  }

  private onConnected = () => {
    void this.push();
  };

  private async push(): Promise<void> {
    if (!this.device?.connected) return;

    const compatibilityId = vscode.workspace
      .getConfiguration(CONFIG_SECTION)
      .get<number>(COMPATIBILITY_MODE_SETTING, 0);
    const command = compatibilityId > 0
      ? `set_keyboard_protocol ${compatibilityId} compatibility`
      : "set_keyboard_protocol default";

    try {
      const response = await this.device.sendCommand(command);
      if (!response.startsWith("OK")) {
        logError("KeyboardProtocolSync: device rejected keyboard protocol command", command, response);
      }
    } catch (err) {
      logError("KeyboardProtocolSync: failed to set keyboard protocol", err);
    }
  }
}
