import * as vscode from "vscode";
import { logError, logWarn } from "./logger";

const CONFIG_SECTION = "javelin";
const LINE_HEIGHT_SETTING = "lineHeight";
const OCCURRENCES_HIGHLIGHT_SETTING = "occurrencesHighlight";

const EDITOR_SECTION = "editor";
const EDITOR_LINE_HEIGHT_KEY = "lineHeight";
const EDITOR_OCCURRENCES_HIGHLIGHT_KEY = "occurrencesHighlight";

const LINE_HEIGHT_UNSET = 0;
const OCCURRENCES_HIGHLIGHT_UNSET = "inherit";

// Memento keys - persisted so "what did we last push" survives a window reload or restart.
const LAST_PUSHED_LINE_HEIGHT_KEY = "javelin.editorOverride.lastPushed.lineHeight";
const LAST_PUSHED_OCCURRENCES_HIGHLIGHT_KEY = "javelin.editorOverride.lastPushed.occurrencesHighlight";

export type OverrideAction<T> = { kind: "write"; value: T } | { kind: "clear" } | { kind: "none" };

/** What to do to an `editor.*` setting given the desired `javelin.*` override; only clears a value we're still the last writer of. */
export function nextOverrideAction<T>(
  desired: T,
  unset: T,
  current: T,
  lastPushed: T | undefined
): OverrideAction<T> {
  if (desired !== unset) {
    return desired === current ? { kind: "none" } : { kind: "write", value: desired };
  }
  if (lastPushed !== undefined && current === lastPushed && current !== unset) {
    return { kind: "clear" };
  }
  return { kind: "none" };
}

interface PushedOverride<T> {
  value: T;
  target: vscode.ConfigurationTarget;
}

/** Mirrors javelin.lineHeight/occurrencesHighlight into VS Code settings, so they're adjustable from the Javelin settings section. */
export class EditorSettingOverrideSync implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly memento: vscode.Memento) {
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(`${CONFIG_SECTION}.${LINE_HEIGHT_SETTING}`)) void this.syncLineHeight();
        if (e.affectsConfiguration(`${CONFIG_SECTION}.${OCCURRENCES_HIGHLIGHT_SETTING}`))
          void this.syncOccurrencesHighlight();
      })
    );

    void this.syncLineHeight();
    void this.syncOccurrencesHighlight();
  }

  dispose(): void {
    while (this.disposables.length) this.disposables.pop()?.dispose();
  }

  private syncLineHeight(): Promise<void> {
    return this.syncOverride(
      LINE_HEIGHT_SETTING,
      EDITOR_LINE_HEIGHT_KEY,
      LINE_HEIGHT_UNSET,
      LAST_PUSHED_LINE_HEIGHT_KEY
    );
  }

  private syncOccurrencesHighlight(): Promise<void> {
    return this.syncOverride(
      OCCURRENCES_HIGHLIGHT_SETTING,
      EDITOR_OCCURRENCES_HIGHLIGHT_KEY,
      OCCURRENCES_HIGHLIGHT_UNSET,
      LAST_PUSHED_OCCURRENCES_HIGHLIGHT_KEY
    );
  }

  private async syncOverride<T>(javelinKey: string, editorKey: string, unset: T, mementoKey: string): Promise<void> {
    const editorConfig = vscode.workspace.getConfiguration(EDITOR_SECTION);
    const desired = vscode.workspace.getConfiguration(CONFIG_SECTION).get<T>(javelinKey, unset);
    const current = editorConfig.get<T>(editorKey, unset);
    const pushed = this.memento.get<PushedOverride<T>>(mementoKey);
    const action = nextOverrideAction(desired, unset, current, pushed?.value);
    if (action.kind === "none") return;

    try {
      if (action.kind === "clear") {
        if (!pushed) return;
        await editorConfig.update(editorKey, undefined, pushed.target);
        await this.memento.update(mementoKey, undefined);
        return;
      }

      await editorConfig.update(editorKey, action.value, vscode.ConfigurationTarget.Global);
      const toStore: PushedOverride<T> = { value: action.value, target: vscode.ConfigurationTarget.Global };
      await this.memento.update(mementoKey, toStore);

      // A workspace/folder-level editor.* setting outranks our Global write - the push above is a no-op in that case.
      const effective = vscode.workspace.getConfiguration(EDITOR_SECTION).get<T>(editorKey, unset);
      if (effective !== action.value) {
        logWarn(
          `EditorSettingOverrideSync: javelin.${javelinKey} could not override editor.${editorKey} - a workspace-level setting takes precedence`
        );
      }
    } catch (err) {
      logError(`EditorSettingOverrideSync: failed to update editor.${editorKey}`, err);
    }
  }
}
