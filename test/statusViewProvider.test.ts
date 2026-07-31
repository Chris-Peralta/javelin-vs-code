import test from "node:test";
import assert from "node:assert/strict";
import type * as vscode from "vscode";
import { StatusViewProvider } from "../src/statusViewProvider";
import { JavelinSettings } from "../src/settings";
import { FakeMemento } from "./fakeMemento";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const vscodeMock = require("./vscodeMock.cjs") as {
  workspace: {
    __setWorkspaceFolders: (folders: unknown[] | undefined) => void;
  };
};

/** Stands in for vscode.WebviewView: records posted messages and lets tests simulate incoming ones. */
class FakeWebviewView {
  readonly messages: Array<Record<string, unknown>> = [];
  readonly webview = {
    options: undefined as unknown,
    html: "",
    cspSource: "vscode-webview://test",
    asWebviewUri: (uri: unknown) => uri,
    postMessage: async (message: Record<string, unknown>) => {
      this.messages.push(message);
      return true;
    },
    onDidReceiveMessage: (handler: (message: unknown) => void) => {
      this.receiveHandler = handler;
      return { dispose() {} };
    },
  };
  private receiveHandler: ((message: unknown) => void) | undefined;
  private disposeHandler: (() => void) | undefined;

  onDidDispose(handler: () => void): vscode.Disposable {
    this.disposeHandler = handler;
    return { dispose() {} } as vscode.Disposable;
  }

  receive(message: unknown): void {
    this.receiveHandler?.(message);
  }

  disposeView(): void {
    this.disposeHandler?.();
  }

  workspaceMessages(): Array<{ type: string; hasFolder: boolean }> {
    return this.messages.filter((m) => m.type === "workspace") as Array<{ type: string; hasFolder: boolean }>;
  }
}

function makeSettings(): JavelinSettings {
  return new JavelinSettings({ globalState: new FakeMemento() } as unknown as vscode.ExtensionContext);
}

function makeProvider(): StatusViewProvider {
  return new StatusViewProvider({ fsPath: "/ext" } as unknown as vscode.Uri, undefined, makeSettings());
}

test("tells the webview no folder is open when there are no workspace folders", () => {
  vscodeMock.workspace.__setWorkspaceFolders(undefined);
  const view = new FakeWebviewView();
  makeProvider().resolveWebviewView(view as unknown as vscode.WebviewView);

  view.receive({ type: "ready" });

  const messages = view.workspaceMessages();
  assert.equal(messages.length, 1);
  assert.equal(messages[0].hasFolder, false);
});

test("tells the webview a folder is open when a workspace folder exists", () => {
  vscodeMock.workspace.__setWorkspaceFolders([{ uri: { fsPath: "/repo" }, name: "repo", index: 0 }]);
  const view = new FakeWebviewView();
  makeProvider().resolveWebviewView(view as unknown as vscode.WebviewView);

  view.receive({ type: "ready" });

  const messages = view.workspaceMessages();
  assert.equal(messages.length, 1);
  assert.equal(messages[0].hasFolder, true);
});

test("posts an updated workspace message when a folder is opened after the view is already ready", () => {
  vscodeMock.workspace.__setWorkspaceFolders(undefined);
  const view = new FakeWebviewView();
  makeProvider().resolveWebviewView(view as unknown as vscode.WebviewView);
  view.receive({ type: "ready" });

  vscodeMock.workspace.__setWorkspaceFolders([{ uri: { fsPath: "/repo" }, name: "repo", index: 0 }]);

  const messages = view.workspaceMessages();
  assert.equal(messages.length, 2);
  assert.equal(messages[1].hasFolder, true);

  view.disposeView();
});

test("stops posting workspace updates once the view is disposed", () => {
  vscodeMock.workspace.__setWorkspaceFolders(undefined);
  const view = new FakeWebviewView();
  makeProvider().resolveWebviewView(view as unknown as vscode.WebviewView);
  view.receive({ type: "ready" });
  view.disposeView();

  vscodeMock.workspace.__setWorkspaceFolders([{ uri: { fsPath: "/repo" }, name: "repo", index: 0 }]);

  assert.equal(view.workspaceMessages().length, 1, "no new message should arrive after dispose");
});
