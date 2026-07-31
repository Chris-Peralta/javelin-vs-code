/** Minimal stand-in for `vscode.Memento` (what `globalState`/`workspaceState` implement). */
export class FakeMemento {
  private readonly store = new Map<string, unknown>();

  constructor(initial: Record<string, unknown> = {}) {
    for (const [key, value] of Object.entries(initial)) {
      this.store.set(key, value);
    }
  }

  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  get<T>(key: string, defaultValue?: T): T | undefined {
    return this.store.has(key) ? (this.store.get(key) as T) : defaultValue;
  }

  update(key: string, value: unknown): Thenable<void> {
    this.store.set(key, value);
    return Promise.resolve();
  }

  keys(): readonly string[] {
    return [...this.store.keys()];
  }

  /** Snapshot the current contents, e.g. to seed a second window's independent copy. */
  snapshot(): Record<string, unknown> {
    return Object.fromEntries(this.store);
  }
}
