import * as vscode from "vscode";
import { JavelinHidDevice, type JavPaperTapeEventDetail } from "./javelinHidDevice";
import { JavelinSettings } from "./settings";

export interface PaperTapeEntry {
  id: number;
  outline: string;
  dictionary: string;
  translation: string;
  undo: number;
  timestamp: number;
}

/**
 * Buffers paper_tape strokes as they arrive from the device, independent of whether
 * the Paper Tape panel is open, so reopening the panel shows everything recorded
 * while VS Code had focus in the meantime.
 */
export class PaperTapeRecorder {
  private static readonly MAX_ENTRIES = 5000;

  private readonly entries: PaperTapeEntry[] = [];
  private nextId = 1;
  private readonly listeners = new Set<(entry: PaperTapeEntry) => void>();

  constructor(
    private readonly device: JavelinHidDevice | undefined,
    private readonly settings: JavelinSettings
  ) {
    if (this.device) {
      this.device.on("paper_tape", this.onPaperTape);
    }
  }

  getEntries(): readonly PaperTapeEntry[] {
    return this.entries;
  }

  onAppend(listener: (entry: PaperTapeEntry) => void): vscode.Disposable {
    this.listeners.add(listener);
    return new vscode.Disposable(() => this.listeners.delete(listener));
  }

  clear(): void {
    this.entries.length = 0;
  }

  dispose(): void {
    if (this.device) {
      this.device.off("paper_tape", this.onPaperTape);
    }
    this.listeners.clear();
  }

  private onPaperTape = (ev: CustomEvent<JavPaperTapeEventDetail>) => {
    // Unless background monitoring is enabled, only record strokes while VS Code is focused.
    if (!this.settings.backgroundMonitoring && !vscode.window.state.focused) return;

    const detail = ev.detail;
    const entry: PaperTapeEntry = {
      id: this.nextId++,
      outline: detail.outline ?? "",
      dictionary: detail.dictionary ?? "",
      translation: detail.translation ?? "",
      undo: detail.undo ?? 0,
      timestamp: Date.now(),
    };

    this.entries.push(entry);
    if (this.entries.length > PaperTapeRecorder.MAX_ENTRIES) {
      this.entries.shift();
    }

    for (const listener of this.listeners) {
      listener(entry);
    }
  };
}
