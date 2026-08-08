import test from "node:test";
import assert from "node:assert/strict";
import type * as vscode from "vscode";
import { StatusViewProvider } from "../src/statusViewProvider";
import type { JavelinHidDevice } from "../src/javelinHidDevice";
import type { JavelinSettings } from "../src/settings";
import type { SuggestionEntry, SuggestionTracker } from "../src/suggestionTracker";

/** Stands in for JavelinHidDevice: records listeners and lets tests fire fake connection events. */
class FakeDevice {
  connected = false;
  private readonly listeners = new Map<string, Set<(ev: CustomEvent) => void>>();

  on(type: string, listener: (ev: CustomEvent) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }

  off(type: string, listener: (ev: CustomEvent) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  fire(type: string, detail: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(new CustomEvent(type, { detail }));
    }
  }
}

/** Stands in for JavelinSettings: enough surface for StatusViewProvider to subscribe to. */
class FakeSettings {
  showTimestamps = false;
  backgroundMonitoring = false;
  persistPerWindow = false;
  suggestionsBackgroundMonitoring = false;
  logLevel = "WARN";
  setLogLevelCalls: string[] = [];

  onDidChange(): vscode.Disposable {
    return { dispose() {} };
  }

  async setLogLevel(value: string): Promise<void> {
    this.setLogLevelCalls.push(value);
    this.logLevel = value;
  }
}

/** Stands in for SuggestionTracker: enough surface for StatusViewProvider to subscribe to. */
class FakeSuggestionTracker {
  private readonly listeners = new Set<(entry: SuggestionEntry) => void>();

  constructor(private readonly entries: SuggestionEntry[] = []) {}

  getEntries(): readonly SuggestionEntry[] {
    return this.entries;
  }

  onAppend(listener: (entry: SuggestionEntry) => void): vscode.Disposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  /** Simulates a new suggestion arriving from the device. */
  append(entry: SuggestionEntry): void {
    this.entries.push(entry);
    for (const listener of this.listeners) listener(entry);
  }
}

/** Stands in for vscode.WebviewView: records posted messages and lets tests simulate incoming ones. */
class FakeWebviewView {
  readonly messages: Record<string, unknown>[] = [];
  private disposeListener: (() => void) | undefined;
  private receiveMessageListener: ((message: Record<string, unknown>) => void) | undefined;

  webview = {
    options: undefined as unknown,
    html: "",
    cspSource: "vscode-resource:",
    asWebviewUri: (uri: unknown) => uri,
    postMessage: (msg: Record<string, unknown>) => {
      this.messages.push(msg);
      return Promise.resolve(true);
    },
    onDidReceiveMessage: (listener: (message: Record<string, unknown>) => void) => {
      this.receiveMessageListener = listener;
      return { dispose() {} };
    },
  };

  onDidDispose(listener: () => void): vscode.Disposable {
    this.disposeListener = listener;
    return { dispose() {} };
  }

  /** Simulates a message from the webview, e.g. `{ type: "ready" }`. */
  receiveMessage(message: Record<string, unknown>): void {
    this.receiveMessageListener?.(message);
  }

  lastStatusMessage(): Record<string, unknown> {
    const status = [...this.messages].reverse().find((m) => m.type === "status");
    assert.ok(status, "expected a status message to have been posted");
    return status!;
  }
}

function makeProvider(
  device: FakeDevice,
  suggestionTracker: FakeSuggestionTracker = new FakeSuggestionTracker(),
  settings: FakeSettings = new FakeSettings()
): {
  provider: StatusViewProvider;
  webviewView: FakeWebviewView;
  suggestionTracker: FakeSuggestionTracker;
  settings: FakeSettings;
} {
  const provider = new StatusViewProvider(
    { fsPath: "/ext" } as unknown as vscode.Uri,
    device as unknown as JavelinHidDevice,
    settings as unknown as JavelinSettings,
    suggestionTracker as unknown as SuggestionTracker
  );
  const webviewView = new FakeWebviewView();
  provider.resolveWebviewView(webviewView as unknown as vscode.WebviewView);
  return { provider, webviewView, suggestionTracker, settings };
}

test("a connection error is reported as disconnected with the error message", () => {
  const device = new FakeDevice();
  const { webviewView } = makeProvider(device);

  device.fire("connectionError", { message: "Permission denied opening HID device" });

  const status = webviewView.lastStatusMessage();
  assert.equal(status.connected, false);
  assert.equal(status.connectionError, "Permission denied opening HID device");
});

test("a connection error is cleared once the device connects successfully", () => {
  const device = new FakeDevice();
  const { webviewView } = makeProvider(device);

  device.fire("connectionError", { message: "Permission denied opening HID device" });
  device.connected = true;
  device.fire("connected", { product: "Javelin" });

  const status = webviewView.lastStatusMessage();
  assert.equal(status.connected, true);
  assert.equal(status.connectionError, undefined);
});

test("a plain disconnect (no prior error) does not report a connection error", () => {
  const device = new FakeDevice();
  const { webviewView } = makeProvider(device);

  device.connected = false;
  device.fire("disconnected", { product: "Javelin" });

  const status = webviewView.lastStatusMessage();
  assert.equal(status.connected, false);
  assert.equal(status.connectionError, undefined);
});

test("posts the tracker's buffered suggestions when the webview signals ready", () => {
  const device = new FakeDevice();
  const existing: SuggestionEntry = { id: 1, strokes: 1, translation: "good day", outlines: ["TKPW-D"], timestamp: 1 };
  const { webviewView } = makeProvider(device, new FakeSuggestionTracker([existing]));

  webviewView.receiveMessage({ type: "ready" });

  const message = [...webviewView.messages].reverse().find((m) => m.type === "suggestions");
  assert.ok(message, "expected a suggestions snapshot to have been posted");
  assert.deepEqual(message!.entries, [existing]);
});

test("posts a new suggestion as soon as the tracker appends one", () => {
  const device = new FakeDevice();
  const { webviewView, suggestionTracker } = makeProvider(device);

  const entry: SuggestionEntry = { id: 1, strokes: 1, translation: "good day", outlines: ["TKPW-D"], timestamp: 1 };
  suggestionTracker.append(entry);

  const message = [...webviewView.messages].reverse().find((m) => m.type === "suggestion");
  assert.ok(message, "expected a suggestion message to have been posted");
  assert.deepEqual(message!.entry, entry);
});

test("includes the current logLevel when posting settings", () => {
  const device = new FakeDevice();
  const settings = new FakeSettings();
  settings.logLevel = "DEBUG";
  const { webviewView } = makeProvider(device, undefined, settings);

  webviewView.receiveMessage({ type: "ready" });

  const message = [...webviewView.messages].reverse().find((m) => m.type === "settings");
  assert.ok(message, "expected a settings snapshot to have been posted");
  assert.equal(message!.logLevel, "DEBUG");
});

test("a setLogLevel message with a valid level updates the setting", () => {
  const device = new FakeDevice();
  const { webviewView, settings } = makeProvider(device);

  webviewView.receiveMessage({ type: "setLogLevel", logLevel: "ERROR" });

  assert.deepEqual(settings.setLogLevelCalls, ["ERROR"]);
});

test("a setLogLevel message with an invalid level is ignored", () => {
  const device = new FakeDevice();
  const { webviewView, settings } = makeProvider(device);

  webviewView.receiveMessage({ type: "setLogLevel", logLevel: "VERBOSE" });

  assert.deepEqual(settings.setLogLevelCalls, []);
});
