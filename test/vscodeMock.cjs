"use strict";

// Minimal stand-in for the parts of the `vscode` API this extension's unit-tested
// modules touch. Not a general-purpose mock - extend as needed, but keep it honest
// about what real `vscode` guarantees (e.g. no cross-window sync - see settings.test.ts).

class Disposable {
  constructor(callback) {
    this._callback = callback;
  }
  dispose() {
    if (this._callback) {
      const cb = this._callback;
      this._callback = undefined;
      cb();
    }
  }
}

class EventEmitter {
  constructor() {
    this._listeners = new Set();
    this.event = (listener) => {
      this._listeners.add(listener);
      return new Disposable(() => this._listeners.delete(listener));
    };
  }
  fire(value) {
    for (const listener of [...this._listeners]) listener(value);
  }
  dispose() {
    this._listeners.clear();
  }
}

// Real vscode.window is one object shared by the whole extension host of a single
// window - fine for single-window tests, but do NOT use this to simulate multiple
// windows (they'd incorrectly share focus state). Prefer injecting a fake
// `getFocused` function instead, same as extension.ts does for AppFocusTracker.
const windowStateEmitter = new EventEmitter();
const window = {
  state: { focused: true },
  onDidChangeWindowState: windowStateEmitter.event,
  __setFocused(focused) {
    window.state = { focused };
    windowStateEmitter.fire({ focused });
  },
  createOutputChannel() {
    return { appendLine() {} };
  },
};

const Uri = {
  joinPath(base, ...segments) {
    return { fsPath: [base && base.fsPath, ...segments].filter(Boolean).join("/") };
  },
};

const commands = {
  executeCommand() {},
};

// vscode.workspace.workspaceFolders is undefined until a folder/workspace is open -
// default to that so tests reflect the "nothing open" starting state.
let workspaceFolders;
const workspaceFoldersEmitter = new EventEmitter();
const workspace = {
  get workspaceFolders() {
    return workspaceFolders;
  },
  onDidChangeWorkspaceFolders: workspaceFoldersEmitter.event,
  __setWorkspaceFolders(folders) {
    workspaceFolders = folders;
    workspaceFoldersEmitter.fire();
  },
};

module.exports = { Disposable, EventEmitter, window, Uri, commands, workspace };
