import * as vscode from "vscode";
import { JavelinHidDevice, type JavSuggestionEventDetail } from "./javelinHidDevice";
import { logInfo } from "./logger";
import { JavelinSettings } from "./settings";

export interface SuggestionEntry {
  id: number;
  strokes: number;
  translation: string;
  outlines: string[];
  timestamp: number;
}

const MAX_ENTRIES = 200;

/**
 * Buffers `suggestion` events from the device in memory only - never persisted to disk,
 * unlike `PaperTapeRecorder` - so the sidebar's Suggestions list survives the webview
 * being hidden/recreated within a session.
 */
export class SuggestionTracker {
  private readonly entries: SuggestionEntry[] = [];
  private nextId = 1;
  private readonly listeners = new Set<(entry: SuggestionEntry) => void>();

  constructor(
    private readonly device: JavelinHidDevice | undefined,
    private readonly settings: JavelinSettings,
    private readonly getFocused: () => boolean = () => vscode.window.state.focused
  ) {
    if (this.device) {
      this.device.on("suggestion", this.onSuggestion);
    }
  }

  getEntries(): readonly SuggestionEntry[] {
    return this.entries;
  }

  onAppend(listener: (entry: SuggestionEntry) => void): vscode.Disposable {
    this.listeners.add(listener);
    return new vscode.Disposable(() => this.listeners.delete(listener));
  }

  dispose(): void {
    if (this.device) {
      this.device.off("suggestion", this.onSuggestion);
    }
    this.listeners.clear();
  }

  private onSuggestion = (ev: CustomEvent<JavSuggestionEventDetail>) => {
    const detail = ev.detail;

    // Unless background monitoring is enabled, only record suggestions while VS Code is focused.
    if (!this.settings.suggestionsBackgroundMonitoring && !this.getFocused()) {
      logInfo(`Dropped suggestion event (window not focused): translation="${detail.translation ?? ""}"`);
      return;
    }

    const entry: SuggestionEntry = {
      id: this.nextId++,
      strokes: detail.strokes ?? 0,
      translation: detail.translation ?? "",
      outlines: detail.outlines ?? [],
      timestamp: Date.now(),
    };

    logInfo(`Recorded suggestion event: translation="${entry.translation}" outlines=${entry.outlines.join(",")}`);
    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.shift();
    }

    for (const listener of this.listeners) {
      listener(entry);
    }
  };
}
