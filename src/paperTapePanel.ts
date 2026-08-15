import * as vscode from "vscode";
import { logError } from "./logger";
import { PaperTapeRecorder, type PaperTapeEntry } from "./paperTapeRecorder";
import { PaperTapeWordTracker } from "./paperTapeWordTracker";
import { JavelinSettings } from "./settings";
import { getNonce } from "./nonce";

/** Context key the paper tape editing commands' keybindings are scoped to, so they only fire while this panel is the focused tab. */
const FOCUSED_CONTEXT_KEY = "javelinPaperTapeFocused";
/** Entries per page for the initial load and each infinite-scroll "load older" batch. */
const PAGE_SIZE = 200;

/**
 * Manages the single "Javelin Paper Tape" webview panel. Strokes are recorded by the
 * shared PaperTapeRecorder (owned by the extension, see extension.ts) regardless of
 * whether this panel is open; this class just displays the buffered history and
 * live-streams new entries while it's open.
 *
 * Only the most recent page loads up front; older history is fetched a page at a time as the webview scrolls up.
 *
 * Filtering (hiding rows, and pausing new rows while any part of the panel is focused)
 * is handled entirely client-side in media/main.js.
 */
export class PaperTapePanel {
  private static current: PaperTapePanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private selectedWordId: string | undefined;
  // Gates the command handlers themselves, since the same commands are also Command Palette-reachable regardless of keybinding focus.
  private focused = false;
  // The oldest entry currently loaded into the webview - the cursor for the next "load older" page.
  private oldestLoadedEntry: PaperTapeEntry | undefined;

  static createOrShow(
    extensionUri: vscode.Uri,
    recorder: PaperTapeRecorder | undefined,
    wordTracker: PaperTapeWordTracker | undefined,
    settings: JavelinSettings
  ) {
    const column = vscode.window.activeTextEditor?.viewColumn;

    if (PaperTapePanel.current) {
      PaperTapePanel.current.panel.reveal(column);
      PaperTapePanel.current.focusLastRow();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      "javelinPaperTape",
      "Paper Tape",
      column ?? vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media")],
      }
    );

    PaperTapePanel.current = new PaperTapePanel(panel, extensionUri, recorder, wordTracker, settings);
  }

  static disposeCurrent(): void {
    PaperTapePanel.current?.dispose();
  }

  // Delegates for the paper tape editing commands; each acts on the last row the webview reported as selected.
  static jumpToSelected(): void {
    PaperTapePanel.current?.jumpToSelected();
  }
  static peekSelected(): void {
    PaperTapePanel.current?.peekSelected();
  }
  static editSelected(): void {
    PaperTapePanel.current?.editSelected();
  }
  static deleteSelected(): void {
    PaperTapePanel.current?.deleteSelected();
  }
  static insertBeforeSelected(): void {
    PaperTapePanel.current?.insertBeforeSelected();
  }
  static insertAfterSelected(): void {
    PaperTapePanel.current?.insertAfterSelected();
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    private readonly recorder: PaperTapeRecorder | undefined,
    private readonly wordTracker: PaperTapeWordTracker | undefined,
    private readonly settings: JavelinSettings
  ) {
    this.panel = panel;
    this.panel.webview.html = this.getHtml(panel.webview, extensionUri);

    if (this.recorder) {
      this.disposables.push(this.recorder.onAppend(this.onAppend));
      this.disposables.push(this.recorder.onClear(this.onClear));
    }

    if (this.wordTracker) {
      this.disposables.push(this.wordTracker.onAnchorsChanged((wordIds) => this.postWordStatuses(wordIds)));
    }

    this.disposables.push(this.settings.onDidChange(() => this.postSettings()));

    this.disposables.push(
      this.panel.onDidChangeViewState((e) => void this.setFocusedContext(e.webviewPanel.active))
    );
    void this.setFocusedContext(this.panel.active);

    this.panel.webview.onDidReceiveMessage(
      (message) => this.onMessage(message),
      undefined,
      this.disposables
    );

    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);
  }

  private onAppend = (entry: PaperTapeEntry) => {
    void this.panel.webview.postMessage({ type: "append", entry });
  };

  private onClear = () => {
    this.oldestLoadedEntry = undefined;
    void this.panel.webview.postMessage({ type: "clear" });
  };

  private focusLastRow(): void {
    void this.panel.webview.postMessage({ type: "focusLast" });
  }

  private postSettings() {
    void this.panel.webview.postMessage({
      type: "settings",
      showTimestamps: this.settings.showTimestamps,
    });
  }

  private postWordStatuses(wordIds: readonly string[]): void {
    const tracker = this.wordTracker;
    if (!tracker) return;

    const updates = wordIds
      .map((wordId) => {
        const status = tracker.getWordStatus(wordId);
        if (!status) return undefined;
        return { wordId, ...status, originalText: tracker.getAnchor(wordId)?.originalText };
      })
      .filter((u): u is NonNullable<typeof u> => !!u);
    if (updates.length === 0) return;
    void this.panel.webview.postMessage({ type: "wordStatus", updates });
  }

  /** Seeds status for words in a newly loaded page, since a reopened/scrolled-into page shows no decoration until a future edit touches the anchor. */
  private seedWordStatuses(entries: readonly PaperTapeEntry[]): void {
    const wordIds = [...new Set(entries.map((e) => e.wordId).filter((id): id is string => !!id))];
    this.postWordStatuses(wordIds);
  }

  private onMessage(message: {
    type: string;
    action?: string;
    wordId?: string | null;
    mode?: string;
    text?: string;
  }) {
    if (message.type === "ready") {
      const page = this.recorder?.getRecentEntries(PAGE_SIZE) ?? { entries: [], hasMore: false };
      this.oldestLoadedEntry = page.entries[0];
      void this.panel.webview.postMessage({
        type: "init",
        entries: page.entries,
        hasMore: page.hasMore,
        showTimestamps: this.settings.showTimestamps,
      });
      this.seedWordStatuses(page.entries);
    } else if (message.type === "loadOlder") {
      const page = this.oldestLoadedEntry
        ? (this.recorder?.getOlderEntries(this.oldestLoadedEntry, PAGE_SIZE) ?? { entries: [], hasMore: false })
        : { entries: [], hasMore: false };
      if (page.entries[0]) this.oldestLoadedEntry = page.entries[0];
      void this.panel.webview.postMessage({
        type: "olderEntries",
        entries: page.entries,
        hasMore: page.hasMore,
      });
      this.seedWordStatuses(page.entries);
    } else if (message.type === "selectionChanged") {
      this.selectedWordId = message.wordId ?? undefined;
    } else if (message.type === "wordAction" && message.wordId) {
      // Mouse-triggered actions only - keyboard actions go through the commands in extension.ts instead.
      if (message.action === "peek") void this.jumpToWord(message.wordId, false);
      else if (message.action === "edit") this.beginEdit(message.wordId);
    } else if (message.type === "commitEdit" && message.wordId && typeof message.text === "string") {
      void this.applyEdit(message.wordId, message.text);
    } else if (
      message.type === "commitInsert" &&
      message.wordId &&
      (message.mode === "before" || message.mode === "after") &&
      typeof message.text === "string"
    ) {
      void this.applyInsert(message.wordId, message.mode, message.text);
    }
  }

  jumpToSelected(): void {
    if (this.focused && this.selectedWordId) void this.jumpToWord(this.selectedWordId, true);
  }

  peekSelected(): void {
    if (this.focused && this.selectedWordId) void this.jumpToWord(this.selectedWordId, false);
  }

  editSelected(): void {
    if (this.focused && this.selectedWordId) this.beginEdit(this.selectedWordId);
  }

  deleteSelected(): void {
    if (this.focused && this.selectedWordId) void this.deleteWord(this.selectedWordId);
  }

  insertBeforeSelected(): void {
    if (this.focused && this.selectedWordId) this.beginInsert(this.selectedWordId, "before");
  }

  insertAfterSelected(): void {
    if (this.focused && this.selectedWordId) this.beginInsert(this.selectedWordId, "after");
  }

  /** Reveals and selects a word's live document position. `moveFocus` false keeps focus on the tape ("peek"). */
  private async jumpToWord(wordId: string, moveFocus: boolean): Promise<void> {
    const anchor = this.wordTracker?.getAnchor(wordId);
    if (!anchor) return;

    const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(anchor.documentUri));
    const start = doc.positionAt(anchor.offset);
    const end = doc.positionAt(anchor.offset + anchor.length);

    const editor = await vscode.window.showTextDocument(doc, {
      viewColumn: this.documentColumn(),
      preserveFocus: !moveFocus,
      preview: true,
    });
    // Jump moves the cursor to the word's end; peek highlights the whole word.
    editor.selection = moveFocus ? new vscode.Selection(end, end) : new vscode.Selection(start, end);
    editor.revealRange(new vscode.Range(start, end), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }

  /** Tells the webview to open an inline editor on wordId's row, pre-filled with its current document text. */
  private beginEdit(wordId: string): void {
    const currentText = this.currentTextFor(wordId);
    if (currentText === undefined) return; // e.g. already deleted - nothing to edit
    void this.panel.webview.postMessage({ type: "beginEdit", wordId, currentText });
  }

  /** Tells the webview to open an inline editor for a new interlineation before/after wordId. */
  private beginInsert(wordId: string, mode: "before" | "after"): void {
    if (!this.wordTracker?.getAnchor(wordId)) return;
    void this.panel.webview.postMessage({ type: "beginInsert", wordId, mode });
  }

  private currentTextFor(wordId: string): string | undefined {
    const status = this.wordTracker?.getWordStatus(wordId);
    if (status?.state === "deleted") return undefined;
    if (status?.state === "edited") return status.currentText;
    return this.wordTracker?.getAnchor(wordId)?.originalText;
  }

  private async applyEdit(wordId: string, newText: string): Promise<void> {
    const anchor = this.wordTracker?.getAnchor(wordId);
    const trimmed = newText.trim();
    if (!anchor || !trimmed) return;

    const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(anchor.documentUri));
    const range = new vscode.Range(doc.positionAt(anchor.offset), doc.positionAt(anchor.offset + anchor.length));
    const edit = new vscode.WorkspaceEdit();
    edit.replace(doc.uri, range, trimmed);
    // applyEdit never opens/focuses an editor, keeping focus on the tape webview as F2 is supposed to.
    const applied = await vscode.workspace.applyEdit(edit);
    if (!applied) logError(`PaperTapePanel: edit of word ${wordId} was rejected by the workspace`);
  }

  private async deleteWord(wordId: string): Promise<void> {
    const anchor = this.wordTracker?.getAnchor(wordId);
    if (!anchor || anchor.length === 0) return; // already deleted (collapsed span) - nothing to consume

    const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(anchor.documentUri));
    const text = doc.getText();
    let start = anchor.offset;
    let end = anchor.offset + anchor.length;
    // Consume one adjacent space (preferring the trailing one) so deleting a word doesn't leave a double space behind.
    if (text[end] === " ") end += 1;
    else if (text[start - 1] === " ") start -= 1;

    const edit = new vscode.WorkspaceEdit();
    edit.delete(doc.uri, new vscode.Range(doc.positionAt(start), doc.positionAt(end)));
    const applied = await vscode.workspace.applyEdit(edit);
    if (!applied) logError(`PaperTapePanel: delete of word ${wordId} was rejected by the workspace`);
  }

  private async applyInsert(refWordId: string, mode: "before" | "after", text: string): Promise<void> {
    const anchor = this.wordTracker?.getAnchor(refWordId);
    const trimmed = text.trim();
    if (!anchor || !trimmed || !this.recorder || !this.wordTracker) return;

    const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(anchor.documentUri));
    const insertOffset = mode === "before" ? anchor.offset : anchor.offset + anchor.length;
    // "before" pads with a trailing space; "after" pads with a leading space and relies on whatever already follows.
    const insertText = mode === "before" ? `${trimmed} ` : ` ${trimmed}`;

    const edit = new vscode.WorkspaceEdit();
    edit.insert(doc.uri, doc.positionAt(insertOffset), insertText);
    const applied = await vscode.workspace.applyEdit(edit);
    if (!applied) {
      logError(`PaperTapePanel: insert ${mode} word ${refWordId} was rejected by the workspace`);
      return;
    }

    const newEntry = this.recorder.appendSynthetic(trimmed, anchor.documentUri);
    if (newEntry.wordId) {
      const newWordOffset = mode === "before" ? insertOffset : insertOffset + 1; // +1 skips our own leading space
      this.wordTracker.registerInsertedAnchor(newEntry.wordId, anchor.documentUri, newWordOffset, trimmed);
    }
  }

  private async setFocusedContext(focused: boolean): Promise<void> {
    this.focused = focused;
    await vscode.commands.executeCommand("setContext", FOCUSED_CONTEXT_KEY, focused);
  }

  /** A column that's never the tape panel's own, so jump/peek never covers it. */
  private documentColumn(): vscode.ViewColumn {
    return this.panel.viewColumn === vscode.ViewColumn.One ? vscode.ViewColumn.Two : vscode.ViewColumn.One;
  }

  private dispose(): void {
    if (PaperTapePanel.current === this) {
      PaperTapePanel.current = undefined;
    }

    void this.setFocusedContext(false);
    this.panel.dispose();
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }

  private getHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(extensionUri, "media", "main.js")
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(extensionUri, "media", "main.css")
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
  <title>Paper Tape</title>
</head>
<body>
  <div id="toolbar">
    <input id="filter" type="text" placeholder="Filter paper tape (outline, translation)…" autocomplete="off" />
  </div>
  <div id="pausedBanner" class="hidden">
    This panel has focus — new strokes are not being written to the tape.
  </div>
  <div id="tapeHeader">
    <span class="col-timestamp">Time</span>
    <span class="col-outline">Outline</span>
    <span class="col-translation">Translation</span>
  </div>
  <div id="tape" tabindex="0" role="listbox" aria-label="Paper tape entries"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
