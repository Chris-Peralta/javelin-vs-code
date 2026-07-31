import * as vscode from "vscode";
import { AppFocusTracker } from "./appFocusTracker";
import { isHidSupported, JavelinHidDevice } from "./javelinHidDevice";
import { PaperTapePanel } from "./paperTapePanel";
import { PaperTapeRecorder } from "./paperTapeRecorder";
import { JavelinSettings } from "./settings";
import { StatusViewProvider } from "./statusViewProvider";

let device: JavelinHidDevice | undefined;
let recorder: PaperTapeRecorder | undefined;
let settings: JavelinSettings | undefined;
let focusTracker: AppFocusTracker | undefined;

export function activate(context: vscode.ExtensionContext) {
  if (isHidSupported()) {
    device = new JavelinHidDevice();
  }

  const currentSettings = new JavelinSettings(context);
  settings = currentSettings;

  const currentFocusTracker = new AppFocusTracker(context);
  focusTracker = currentFocusTracker;

  recorder = new PaperTapeRecorder(
    device,
    currentSettings,
    () => currentFocusTracker.isFocused(),
    context.workspaceState
  );

  const statusViewProvider = new StatusViewProvider(context.extensionUri, device, currentSettings);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(StatusViewProvider.viewType, statusViewProvider)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("javelin.showPaperTape", () => {
      PaperTapePanel.createOrShow(context.extensionUri, recorder, currentSettings);
    })
  );
}

export async function deactivate(): Promise<void> {
  PaperTapePanel.disposeCurrent();
  await recorder?.dispose();
  settings?.dispose();
  focusTracker?.dispose();
  await device?.destroy();
}
