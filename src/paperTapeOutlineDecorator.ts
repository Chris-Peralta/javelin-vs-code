import * as vscode from "vscode";
import { createDebouncer, type Debouncer } from "./debounce";
import { logError } from "./logger";
import type { PaperTapeEntry, PaperTapeRecorder } from "./paperTapeRecorder";
import type { PaperTapeWordTracker } from "./paperTapeWordTracker";

const REFRESH_DEBOUNCE_MS = 50;
const OPACITY = 0.6;
const LETTER_SPACING_EM = -0.06;

/** Scale outline font size */
function outlineFontSizeEm(wordLength: number, outlineLength: number): number {
  if (outlineLength <= 0) return 1;
  return Math.min(1, wordLength / outlineLength);
}

const CONFIG_SECTION = "javelin";
const SHOW_OUTLINE_SETTING = "showOutlineAboveWords";

function showOutlineAboveWordsEnabled(): boolean {
  return vscode.workspace.getConfiguration(CONFIG_SECTION).get<boolean>(SHOW_OUTLINE_SETTING, true);
}

/** Formatting for outline text decoration */
function outlineTextDecoration(fontSizeEm: number): string {
  return (
    `none; position: absolute; top: -1em; white-space: pre; pointer-events: none; ` +
    `font-size: ${fontSizeEm}em; opacity: ${OPACITY}; letter-spacing: ${LETTER_SPACING_EM}em;`
  );
}

// Decorates each word from the paper tape
export class PaperTapeOutlineDecorator implements vscode.Disposable {
  private readonly decorationType: vscode.TextEditorDecorationType;
  // Track words here because it needs the word grouper drops outlines.
  private readonly outlineStrokesByWordId = new Map<string, string[]>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly refresher: Debouncer = createDebouncer(REFRESH_DEBOUNCE_MS, async () => {
    try {
      this.refreshAllVisible();
    } catch (err) {
      logError("PaperTapeOutlineDecorator: failed to refresh outline decorations", err);
    }
  });

  constructor(
    private readonly recorder: PaperTapeRecorder,
    private readonly wordTracker: PaperTapeWordTracker
  ) {
    this.decorationType = vscode.window.createTextEditorDecorationType({
      before: {
        color: new vscode.ThemeColor("editorInlayHint.foreground"),
        fontStyle: "italic",
      },
    });

    // Backfills words appended before this decorator existed
    for (const entry of recorder.getEntries()) this.trackStroke(entry);

    this.disposables.push(
      recorder.onAppend(this.onEntryAppended),
      recorder.onClear(this.onClear),
      wordTracker.onAnchorsChanged(this.onAnchorsChanged),
      vscode.window.onDidChangeVisibleTextEditors(() => this.refresher.schedule()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(`${CONFIG_SECTION}.${SHOW_OUTLINE_SETTING}`)) this.refresher.schedule();
      })
    );

    this.refresher.schedule();
  }

  dispose(): void {
    this.refresher.cancel();
    while (this.disposables.length) this.disposables.pop()?.dispose();
    this.decorationType.dispose();
  }

  private trackStroke(entry: PaperTapeEntry): void {
    if (!entry.wordId || !entry.outline) return;
    const strokes = this.outlineStrokesByWordId.get(entry.wordId) ?? [];
    strokes.push(entry.outline);
    this.outlineStrokesByWordId.set(entry.wordId, strokes);
  }

  private onEntryAppended = (entry: PaperTapeEntry): void => {
    this.trackStroke(entry);
    this.refresher.schedule();
  };

  private onAnchorsChanged = (): void => {
    this.refresher.schedule();
  };

  private onClear = (): void => {
    this.outlineStrokesByWordId.clear();
    this.refresher.schedule();
  };

  private refreshAllVisible(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      this.refreshEditor(editor);
    }
  }

  private refreshEditor(editor: vscode.TextEditor): void {
    if (!showOutlineAboveWordsEnabled()) {
      editor.setDecorations(this.decorationType, []);
      return;
    }

    const documentUri = editor.document.uri.toString();
    const anchors = this.wordTracker.getAnchorsForDocument(documentUri);
    const docLength = editor.document.getText().length;
    const options: vscode.DecorationOptions[] = [];

    for (const anchor of anchors) {
      if (anchor.length === 0) continue; // deleted - nothing left to annotate
      // Skip anchors that would extend past the end of the document
      if (anchor.offset + anchor.length > docLength) continue;
      const strokes = this.outlineStrokesByWordId.get(anchor.wordId);
      if (!strokes || strokes.length === 0) continue;

      const outlineText = strokes.join("/");
      const fontSizeEm = outlineFontSizeEm(anchor.length, outlineText.length);
      const start = editor.document.positionAt(anchor.offset);
      options.push({
        range: new vscode.Range(start, start),
        renderOptions: {
          before: { contentText: outlineText, textDecoration: outlineTextDecoration(fontSizeEm) },
        },
      });
    }

    editor.setDecorations(this.decorationType, options);
  }
}
