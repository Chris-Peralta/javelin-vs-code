import * as vscode from "vscode";
import { AppFocusTracker } from "./appFocusTracker";
import { isHidSupported, JavelinHidDevice } from "./javelinHidDevice";
import { logInfo, setLogLevel } from "./logger";
import { PaperTapePanel } from "./paperTapePanel";
import { PaperTapeRecorder } from "./paperTapeRecorder";
import { JavelinSettings } from "./settings";
import { StatusViewProvider } from "./statusViewProvider";
import { SuggestionTracker } from "./suggestionTracker";

let device: JavelinHidDevice | undefined;
let recorder: PaperTapeRecorder | undefined;
let suggestionTracker: SuggestionTracker | undefined;
let settings: JavelinSettings | undefined;
let focusTracker: AppFocusTracker | undefined;

export function activate(context: vscode.ExtensionContext) {
  const currentSettings = new JavelinSettings(context);
  settings = currentSettings;
  setLogLevel(currentSettings.logLevel);
  context.subscriptions.push(currentSettings.onDidChange((snapshot) => setLogLevel(snapshot.logLevel)));

  const folders = vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? [];
  logInfo(`Javelin extension activating, workspaceFolders: ${folders.length ? folders.join(", ") : "(none)"}`);

  if (isHidSupported()) {
    device = new JavelinHidDevice();
  }

  const currentFocusTracker = new AppFocusTracker(context);
  focusTracker = currentFocusTracker;

  recorder = new PaperTapeRecorder(
    device,
    currentSettings,
    () => currentFocusTracker.isFocused(),
    context.workspaceState
  );

  const currentSuggestionTracker = new SuggestionTracker(
    device,
    currentSettings,
    () => currentFocusTracker.isFocused()
  );
  suggestionTracker = currentSuggestionTracker;

  const statusViewProvider = new StatusViewProvider(
    context.extensionUri,
    device,
    currentSettings,
    currentSuggestionTracker
  );
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
  suggestionTracker?.dispose();
  settings?.dispose();
  focusTracker?.dispose();
  await device?.destroy();
}
