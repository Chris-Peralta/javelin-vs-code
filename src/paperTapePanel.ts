import * as vscode from "vscode";
import { PaperTapeRecorder, type PaperTapeEntry } from "./paperTapeRecorder";
import { JavelinSettings } from "./settings";
import { getNonce } from "./nonce";

/**
 * Manages the single "Javelin Paper Tape" webview panel. Strokes are recorded by the
 * shared PaperTapeRecorder (owned by the extension, see extension.ts) regardless of
 * whether this panel is open; this class just displays the buffered history and
 * live-streams new entries while it's open.
 *
 * Filtering (hiding rows, and pausing new rows while the filter box is focused) is
 * handled entirely client-side in media/main.js - this class just streams every entry.
 */
export class PaperTapePanel {
  private static current: PaperTapePanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];

  static createOrShow(
    extensionUri: vscode.Uri,
    recorder: PaperTapeRecorder | undefined,
    settings: JavelinSettings
  ) {
    const column = vscode.window.activeTextEditor?.viewColumn;

    if (PaperTapePanel.current) {
      PaperTapePanel.current.panel.reveal(column);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      "javelinPaperTape",
      "Paper Tape",
      column ?? vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media")],
      }
    );

    PaperTapePanel.current = new PaperTapePanel(panel, extensionUri, recorder, settings);
  }

  static disposeCurrent(): void {
    PaperTapePanel.current?.dispose();
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    private readonly recorder: PaperTapeRecorder | undefined,
    private readonly settings: JavelinSettings
  ) {
    this.panel = panel;
    this.panel.webview.html = this.getHtml(panel.webview, extensionUri);

    if (this.recorder) {
      this.disposables.push(this.recorder.onAppend(this.onAppend));
    }

    this.disposables.push(this.settings.onDidChange(() => this.postSettings()));

    this.panel.webview.onDidReceiveMessage(
      (message) => this.onMessage(message),
      undefined,
      this.disposables
    );

    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);
  }

  private onAppend = (entry: PaperTapeEntry) => {
    void this.panel.webview.postMessage({ type: "append", entry });
  };

  private postSettings() {
    void this.panel.webview.postMessage({
      type: "settings",
      showTimestamps: this.settings.showTimestamps,
    });
  }

  private onMessage(message: { type: string }) {
    if (message.type === "ready") {
      void this.panel.webview.postMessage({
        type: "init",
        entries: this.recorder?.getEntries() ?? [],
        showTimestamps: this.settings.showTimestamps,
      });
    } else if (message.type === "clear") {
      this.recorder?.clear();
    }
  }

  private dispose(): void {
    if (PaperTapePanel.current === this) {
      PaperTapePanel.current = undefined;
    }

    this.panel.dispose();
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }

  private getHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(extensionUri, "media", "main.js")
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(extensionUri, "media", "main.css")
    );
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta
    http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';"
  />
  <link href="${styleUri}" rel="stylesheet" />
  <title>Paper Tape</title>
</head>
<body>
  <div id="toolbar">
    <input id="filter" type="text" placeholder="Filter paper tape (outline, translation)…" autocomplete="off" />
    <button id="clear" title="Clear paper tape">Clear</button>
  </div>
  <div id="pausedBanner" class="hidden">
    Filter box is focused — new strokes are not being written to the tape.
  </div>
  <div id="tapeHeader">
    <span class="col-timestamp">Time</span>
    <span class="col-outline">Outline</span>
    <span class="col-translation">Translation</span>
  </div>
  <div id="tape"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
