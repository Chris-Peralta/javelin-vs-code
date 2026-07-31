import * as vscode from "vscode";
import { AppFocusTracker } from "./appFocusTracker";
import { isHidSupported, JavelinHidDevice } from "./javelinHidDevice";
import { logInfo } from "./logger";
import { PaperTapePanel } from "./paperTapePanel";
import { PaperTapeRecorder } from "./paperTapeRecorder";
import { JavelinSettings } from "./settings";
import { StatusViewProvider } from "./statusViewProvider";

let device: JavelinHidDevice | undefined;
let recorder: PaperTapeRecorder | undefined;
let settings: JavelinSettings | undefined;
let focusTracker: AppFocusTracker | undefined;

export function activate(context: vscode.ExtensionContext) {
  const folders = vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? [];
  logInfo(`Javelin extension activating, workspaceFolders: ${folders.length ? folders.join(", ") : "(none)"}`);

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
