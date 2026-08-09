import type { PaperTapeEntry } from "./paperTapeRecorder";

export function formatPaperTapeExport(entries: readonly PaperTapeEntry[]): string {
  return JSON.stringify(entries, null, 2) + "\n";
}
