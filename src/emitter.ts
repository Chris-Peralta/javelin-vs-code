import * as vscode from "vscode";

/** Minimal typed pub/sub: `event()` subscribes, `fire()` notifies. */
export class Emitter<T = void> {
  private readonly listeners = new Set<(value: T) => void>();

  event = (listener: (value: T) => void): vscode.Disposable => {
    this.listeners.add(listener);
    return new vscode.Disposable(() => this.listeners.delete(listener));
  };

  fire(value: T): void {
    for (const listener of this.listeners) listener(value);
  }

  /** Force-clears every listener, so a disposed owner can't keep them alive. */
  dispose(): void {
    this.listeners.clear();
  }
}
