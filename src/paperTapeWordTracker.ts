import * as vscode from "vscode";
import { createDebouncedPersister, type DebouncedPersister } from "./debouncedPersist";
import { logDebug, logError, logInfo } from "./logger";
import { PaperTapeRecorder, type PaperTapeEntry } from "./paperTapeRecorder";
import { WordGrouper } from "./paperTapeWordGrouping";
import { JavelinSettings } from "./settings";

export type WordStatus =
  | { state: "unmodified" }
  | { state: "edited"; currentText: string }
  | { state: "deleted" };

export interface PaperTapeWordAnchor {
  wordId: string;
  documentUri: string;
  origin: "stroke" | "inserted";
  offset: number;
  length: number;
  originalText: string;
}

/** The slice of `vscode.TextDocument` this module needs - kept minimal so tests can use a plain fake. */
export interface TrackedDocument {
  readonly uri: string;
  getText(): string;
}

export interface TrackedDocumentChange {
  documentUri: string;
  rangeOffset: number;
  rangeLength: number;
  text: string;
}

const PERSISTED_ANCHORS_KEY = "javelin.paperTapeAnchors";
const PERSIST_DEBOUNCE_MS = 500;
const ANCHOR_SETTLE_MS = 200;

/** Schedules `run` and returns a function that cancels it, if still pending. */
export type Scheduler = (run: () => void) => () => void;

function defaultScheduler(run: () => void): () => void {
  const timer = setTimeout(run, ANCHOR_SETTLE_MS);
  return () => clearTimeout(timer);
}

/** True once whitespace/word-boundary matching treats it as "outside a word". */
function isWordChar(ch: string | undefined): boolean {
  return !!ch && !/\s/.test(ch);
}

/** The `length`-character span ending at (or just before, if `offset` sits in whitespace) `offset`. */
function spanEndingNear(text: string, offset: number, length: number): { offset: number; length: number; text: string } | undefined {
  let end = offset;
  while (end > 0 && !isWordChar(text[end - 1])) end--;
  const start = Math.max(0, end - length);
  if (start === end) return undefined;
  return { offset: start, length: end - start, text: text.slice(start, end) };
}

/** The exact `length`-character span ending at `offset`, with no word-boundary hunting - for content that's itself whitespace (e.g. a bare newline), where there's no word char to search for. */
function exactSpanEndingAt(text: string, offset: number, length: number): { offset: number; length: number; text: string } | undefined {
  const start = Math.max(0, offset - length);
  if (start === offset) return undefined;
  return { offset: start, length: offset - start, text: text.slice(start, offset) };
}

function defaultGetActiveEditor(): { documentUri: string; cursorOffset: number } | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return undefined;
  return {
    documentUri: editor.document.uri.toString(),
    cursorOffset: editor.document.offsetAt(editor.selection.active),
  };
}

function defaultGetOpenDocument(uri: string): TrackedDocument | undefined {
  const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri);
  return doc ? { uri: doc.uri.toString(), getText: () => doc.getText() } : undefined;
}

function defaultOnDidChangeTextDocument(listener: (e: TrackedDocumentChange[]) => void): vscode.Disposable {
  return vscode.workspace.onDidChangeTextDocument((e) => {
    listener(
      e.contentChanges.map((c) => ({
        documentUri: e.document.uri.toString(),
        rangeOffset: c.rangeOffset,
        rangeLength: c.rangeLength,
        text: c.text,
      }))
    );
  });
}

interface PendingAnchor {
  entries: readonly PaperTapeEntry[];
  documentUri: string | undefined;
  /** Cursor offset frozen when a different word's update superseded this one; see `freezeSupersededPending`. */
  frozenCursorOffset: number | undefined;
  cancel: () => void;
}

/** Anchors paper tape words to their live document position, so the tape can jump/peek to a stroke's output and show if it's been edited or deleted. */
export class PaperTapeWordTracker implements vscode.Disposable {
  private readonly anchors = new Map<string, PaperTapeWordAnchor>();
  // Indexes anchors by document so onDocumentChanged only walks anchors touched by that document's edit.
  private readonly anchorsByDocument = new Map<string, Set<string>>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly anchorListeners = new Set<(wordIds: readonly string[]) => void>();
  private readonly pendingAnchors = new Map<string, PendingAnchor>();
  private readonly persister: DebouncedPersister = createDebouncedPersister(PERSIST_DEBOUNCE_MS, () =>
    this.persistAnchors()
  );

  constructor(
    recorder: PaperTapeRecorder,
    private readonly settings: JavelinSettings | undefined,
    private readonly workspaceState?: vscode.Memento,
    private readonly getActiveEditor: () => { documentUri: string; cursorOffset: number } | undefined = defaultGetActiveEditor,
    private readonly getOpenDocument: (uri: string) => TrackedDocument | undefined = defaultGetOpenDocument,
    onDidChangeTextDocument: (
      listener: (changes: TrackedDocumentChange[]) => void
    ) => vscode.Disposable = defaultOnDidChangeTextDocument,
    private readonly scheduleAnchorSettle: Scheduler = defaultScheduler
  ) {
    if (this.persistenceEnabled()) {
      this.loadPersistedAnchors();
    }

    this.disposables.push(recorder.onWordUpdated(this.onWordUpdated));
    this.disposables.push(onDidChangeTextDocument(this.onDocumentChanged));

    if (this.settings) {
      this.disposables.push(
        this.settings.onDidChange((snapshot) => {
          // Turning the setting on mid-session persists what's already tracked, not just anchors created from now on.
          if (snapshot.persistPerWindow) this.schedulePersist();
        })
      );
    }
  }

  /** Current status of a word, derived by comparing its anchor against the live document. `undefined` if never anchored. */
  getWordStatus(wordId: string): WordStatus | undefined {
    const anchor = this.anchors.get(wordId);
    if (!anchor) return undefined;

    const doc = this.getOpenDocument(anchor.documentUri);
    if (!doc) return { state: "unmodified" }; // can't verify while the document isn't open - assume unchanged
    if (anchor.length === 0) return { state: "deleted" };

    const live = doc.getText().slice(anchor.offset, anchor.offset + anchor.length);
    if (live === anchor.originalText) return { state: "unmodified" };
    if (live.trim() === "") return { state: "deleted" };
    return { state: "edited", currentText: live };
  }

  getAnchor(wordId: string): Readonly<PaperTapeWordAnchor> | undefined {
    return this.anchors.get(wordId);
  }

  /** Directly anchors a word inserted via the paper tape's insert-before/after commands, at a position the caller already knows exactly. */
  registerInsertedAnchor(wordId: string, documentUri: string, offset: number, text: string): void {
    // Cancels the stale settle onWordUpdated already scheduled for this wordId's synthetic entry, so it can't clobber this anchor later.
    this.pendingAnchors.get(wordId)?.cancel();
    this.pendingAnchors.delete(wordId);

    this.setAnchor({ wordId, documentUri, origin: "inserted", offset, length: text.length, originalText: text });
    this.schedulePersist();
    this.notifyAnchorsChanged([wordId]);
  }

  /** Fires with the wordIds whose anchor (and so, possibly, `getWordStatus`) just changed. */
  onAnchorsChanged(listener: (wordIds: readonly string[]) => void): vscode.Disposable {
    this.anchorListeners.add(listener);
    return new vscode.Disposable(() => this.anchorListeners.delete(listener));
  }

  async dispose(): Promise<void> {
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
    for (const pending of this.pendingAnchors.values()) pending.cancel();
    this.pendingAnchors.clear();
    await this.persister.flush();
  }

  private persistenceEnabled(): boolean {
    return !!this.workspaceState && (!this.settings || this.settings.persistPerWindow);
  }

  private setAnchor(anchor: PaperTapeWordAnchor): void {
    const existing = this.anchors.get(anchor.wordId);
    if (existing && existing.documentUri !== anchor.documentUri) {
      this.anchorsByDocument.get(existing.documentUri)?.delete(anchor.wordId);
    }
    this.anchors.set(anchor.wordId, anchor);
    if (!this.anchorsByDocument.has(anchor.documentUri)) {
      this.anchorsByDocument.set(anchor.documentUri, new Set());
    }
    this.anchorsByDocument.get(anchor.documentUri)!.add(anchor.wordId);
  }

  /** Adjusts one anchor's offset/length for one content change, in place. */
  private applyChangeToAnchor(anchor: PaperTapeWordAnchor, change: TrackedDocumentChange): void {
    const anchorEnd = anchor.offset + anchor.length;
    const changeEnd = change.rangeOffset + change.rangeLength;
    const delta = change.text.length - change.rangeLength;
    const overlaps = change.rangeOffset < anchorEnd && changeEnd > anchor.offset;

    if (!overlaps) {
      if (change.rangeOffset <= anchor.offset) anchor.offset = Math.max(0, anchor.offset + delta);
      return;
    }

    if (change.rangeOffset <= anchor.offset && changeEnd >= anchorEnd) {
      // The change fully covers the anchor's span - its old content is entirely gone.
      anchor.offset = change.rangeOffset;
      anchor.length = change.text.length;
      return;
    }

    // Partial overlap - approximate with the union of the two spans; getWordStatus's string compare sorts out the rest.
    const newStart = Math.min(anchor.offset, change.rangeOffset);
    const newEnd = Math.max(anchorEnd, changeEnd) + delta;
    anchor.offset = newStart;
    anchor.length = Math.max(0, newEnd - newStart);
  }

  private onWordUpdated = (wordId: string, entries: readonly PaperTapeEntry[]): void => {
    this.pendingAnchors.get(wordId)?.cancel();
    const documentUri = entries[entries.length - 1]?.documentUri;
    this.freezeSupersededPending(wordId, documentUri);

    const cancel = this.scheduleAnchorSettle(() => {
      const pending = this.pendingAnchors.get(wordId);
      this.pendingAnchors.delete(wordId);
      try {
        // An uncaught exception here is a bare setTimeout callback with nothing above it to catch it - never let a best-effort anchor update take down the extension host.
        this.settleAnchor(wordId, entries, pending?.frozenCursorOffset);
      } catch (err) {
        logError(`PaperTapeWordTracker: failed to settle anchor for word ${wordId}`, err);
      }
    });
    this.pendingAnchors.set(wordId, { entries, documentUri, frozenCursorOffset: undefined, cancel });
  };

  /** Freezes an older still-pending word's cursor position now, before a newer word's update makes the live cursor stale for it. */
  private freezeSupersededPending(newWordId: string, documentUri: string | undefined): void {
    if (!documentUri) return;
    let editor: { documentUri: string; cursorOffset: number } | undefined;
    for (const [otherWordId, pending] of this.pendingAnchors) {
      if (otherWordId === newWordId || pending.documentUri !== documentUri || pending.frozenCursorOffset !== undefined) {
        continue;
      }
      editor ??= this.getActiveEditor();
      if (editor && editor.documentUri === documentUri) {
        pending.frozenCursorOffset = editor.cursorOffset;
      }
    }
  }

  /** Reads the (by now settled) cursor/document position for a word and (re)anchors it. */
  private settleAnchor(wordId: string, entries: readonly PaperTapeEntry[], frozenCursorOffset?: number): void {
    const text = WordGrouper.resolveText(entries);
    if (!text) return; // fully cancelled (e.g. "today" undone before "day") - nothing to anchor
    const trimmed = text.trim();

    const editor = this.getActiveEditor();
    const lastEntry = entries[entries.length - 1];
    if (!editor || editor.documentUri !== lastEntry?.documentUri) return; // best-effort: only while the target doc is active

    const doc = this.getOpenDocument(editor.documentUri);
    if (!doc) return;

    const cursorOffset = frozenCursorOffset ?? editor.cursorOffset;
    // Whitespace-only content (e.g. a bare newline stroke) has no word char to hunt for, so anchor the
    // exact span instead of searching backward past "trailing whitespace" the way a real word would.
    const word =
      trimmed.length > 0
        ? spanEndingNear(doc.getText(), cursorOffset, trimmed.length)
        : exactSpanEndingAt(doc.getText(), cursorOffset, text.length);
    if (!word) return;

    this.setAnchor({
      wordId,
      documentUri: editor.documentUri,
      origin: "stroke",
      offset: word.offset,
      length: word.length,
      originalText: word.text,
    });
    this.schedulePersist();
    this.notifyAnchorsChanged([wordId]);
  }

  private onDocumentChanged = (changes: TrackedDocumentChange[]): void => {
    if (changes.length === 0) return;
    const touchedWordIds: string[] = [];
    for (const change of changes) {
      const wordIds = this.anchorsByDocument.get(change.documentUri);
      if (!wordIds) continue;
      for (const wordId of wordIds) {
        const anchor = this.anchors.get(wordId);
        if (!anchor) continue;
        this.applyChangeToAnchor(anchor, change);
        touchedWordIds.push(wordId);
      }
    }
    if (touchedWordIds.length > 0) {
      this.schedulePersist();
      this.notifyAnchorsChanged(touchedWordIds);
    }
  };

  private notifyAnchorsChanged(wordIds: readonly string[]): void {
    for (const listener of this.anchorListeners) listener(wordIds);
  }

  private loadPersistedAnchors(): void {
    if (!this.workspaceState) return;
    const saved = this.workspaceState.get<PaperTapeWordAnchor[]>(PERSISTED_ANCHORS_KEY, []);
    logInfo(`Loaded ${saved.length} persisted paper tape word anchors from workspaceState`);
    for (const anchor of saved) {
      this.setAnchor(anchor);
    }
  }

  private schedulePersist(): void {
    if (!this.persistenceEnabled()) return;
    this.persister.schedule();
  }

  private async persistAnchors(): Promise<void> {
    if (!this.workspaceState) return;

    // Merge with disk by wordId (last writer wins) rather than overwrite, so this window's anchors don't clobber another window's.
    const onDisk = this.workspaceState.get<PaperTapeWordAnchor[]>(PERSISTED_ANCHORS_KEY, []);
    const merged = new Map(onDisk.map((a) => [a.wordId, a]));
    for (const [wordId, anchor] of this.anchors) {
      merged.set(wordId, anchor);
    }

    const all = [...merged.values()];
    await this.workspaceState.update(PERSISTED_ANCHORS_KEY, all);
    logDebug(`Persisted ${all.length} paper tape word anchors to workspaceState`);
  }
}
