import * as vscode from "vscode";
import type { Device as NodeHidDeviceInfo } from "node-hid";
import { JavelinHidDevice, type JavConnectionErrorEventDetail } from "./javelinHidDevice";
import { JavelinSettings } from "./settings";
import { getNonce } from "./nonce";

/**
 * Provides the "Javelin" activity bar view: shows whether a device is connected,
 * offers a button to open the paper tape panel, and hosts the persisted
 * timestamp/background-monitoring toggles.
 */
export class StatusViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = "javelin.statusView";

  private view: vscode.WebviewView | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private lastConnectionError: string | undefined;
  private lastUdevRule: string | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly device: JavelinHidDevice | undefined,
    private readonly settings: JavelinSettings
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
    };
    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(
      (message: { type: string; text?: string; requestId?: number; value?: boolean }) => {
        if (message.type === "ready") {
          this.postStatus();
          this.postSettings();
        } else if (message.type === "showPaperTape") {
          void vscode.commands.executeCommand("javelin.showPaperTape");
        } else if (message.type === "lookup") {
          void this.handleLookup(message.text ?? "", message.requestId ?? 0);
        } else if (message.type === "setShowTimestamps") {
          void this.settings.setShowTimestamps(!!message.value);
        } else if (message.type === "setBackgroundMonitoring") {
          void this.settings.setBackgroundMonitoring(!!message.value);
        } else if (message.type === "setPersistPerWindow") {
          void this.settings.setPersistPerWindow(!!message.value);
        }
      }
    );

    if (this.device) {
      this.device.on("connected", this.onConnected);
      this.device.on("disconnected", this.onDisconnected);
      this.device.on("connectionError", this.onConnectionError);
    }

    this.disposables.push(this.settings.onDidChange(() => this.postSettings()));

    webviewView.onDidDispose(() => {
      if (this.device) {
        this.device.off("connected", this.onConnected);
        this.device.off("disconnected", this.onDisconnected);
        this.device.off("connectionError", this.onConnectionError);
      }
      while (this.disposables.length) {
        this.disposables.pop()?.dispose();
      }
      if (this.view === webviewView) {
        this.view = undefined;
      }
    });
  }

  private postSettings() {
    if (!this.view) return;
    void this.view.webview.postMessage({
      type: "settings",
      showTimestamps: this.settings.showTimestamps,
      backgroundMonitoring: this.settings.backgroundMonitoring,
      persistPerWindow: this.settings.persistPerWindow,
    });
  }

  private async handleLookup(text: string, requestId: number) {
    if (!this.view) return;

    const trimmed = text.trim();
    if (!trimmed) {
      void this.view.webview.postMessage({ type: "lookupResults", requestId, results: [] });
      return;
    }

    if (!this.device || !this.device.connected) {
      void this.view.webview.postMessage({
        type: "lookupResults",
        requestId,
        error: "Connect a device to look up words.",
      });
      return;
    }

    try {
      const results = await this.device.lookup(trimmed);
      void this.view.webview.postMessage({ type: "lookupResults", requestId, results });
    } catch (err) {
      void this.view.webview.postMessage({
        type: "lookupResults",
        requestId,
        error: err instanceof Error ? err.message : "Lookup failed.",
      });
    }
  }

  private onConnected = (ev: CustomEvent<NodeHidDeviceInfo>) => {
    this.lastConnectionError = undefined;
    this.lastUdevRule = undefined;
    this.postStatus(true, ev.detail.product ?? ev.detail.manufacturer);
  };

  private onDisconnected = () => {
    this.postStatus(false);
  };

  private onConnectionError = (ev: CustomEvent<JavConnectionErrorEventDetail>) => {
    this.lastConnectionError = ev.detail.message;
    this.lastUdevRule = ev.detail.udevRule;
    this.postStatus(false);
  };

  private postStatus(connectedOverride?: boolean, deviceName?: string) {
    if (!this.view) return;

    if (!this.device) {
      void this.view.webview.postMessage({
        type: "status",
        connected: false,
        error: "HID access is not supported on this platform.",
      });
      return;
    }

    void this.view.webview.postMessage({
      type: "status",
      connected: connectedOverride ?? this.device.connected,
      deviceName,
      connectionError: this.lastConnectionError,
      udevRule: this.lastUdevRule,
    });
  }

  private getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "statusView.js")
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "statusView.css")
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
  <title>Javelin</title>
</head>
<body>
  <div id="status" class="disconnected">
    <span id="statusDot" class="dot"></span>
    <span id="statusText">Disconnected</span>
  </div>
  <div id="troubleshooting" class="troubleshooting" hidden>
    <div id="connectionErrorText" class="connectionErrorText"></div>
    <div id="udevRuleRow" class="udevRuleRow" hidden>
      <code id="udevRuleText" class="udevRuleText"></code>
      <button id="copyUdevRule" class="copyButton" title="Copy udev rule">Copy</button>
    </div>
    <div>See the <a href="https://github.com/Chris-Peralta/javelin-vs-code#connection-issues" target="_blank" rel="noopener">README</a> for full setup instructions.</div>
  </div>
  <button id="showPaperTape">Show Paper Tape</button>
  <details id="lookup" class="accordion">
    <summary>Look Up</summary>
    <div class="accordionBody">
      <input id="lookupInput" type="text" placeholder="Look up a word…" autocomplete="off" />
      <div id="lookupResults"></div>
    </div>
  </details>
  <details id="settings" class="accordion">
    <summary>Settings</summary>
    <div class="accordionBody">
      <label class="settingRow">
        <input type="checkbox" id="toggleTimestamps" />
        Show timestamps in paper tape
      </label>
      <label class="settingRow">
        <input type="checkbox" id="toggleBackgroundMonitoring" />
        Record paper tape while VS Code is in the background (requires per-window paper tape off)
      </label>
      <label class="settingRow">
        <input type="checkbox" id="togglePersistPerWindow" />
        Save a separate paper tape per window (requires background recording off)
      </label>
    </div>
  </details>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
