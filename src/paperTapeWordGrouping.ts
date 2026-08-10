import type { PaperTapeEntry } from "./paperTapeRecorder";

const COMMAND_PATTERN = /\{:[^}]*\}/;
const KEYBOARD_PATTERN = /\{#[^}]*\}/;
const GLUE_PREFIX_PATTERN = /^\{\^[^}]*\}/;
// A {#...} key combo that presses Return/Enter - unlike other key combos (Escape, Tab, ...) this one
// inserts a real newline into the document, so it's tracked as a word like any other dictated text.
const RETURN_KEY_PATTERN = /^\{#[^}]*\b(?:Return|Enter)\b[^}]*\}/i;

/** Identifies an entry by content, since `id` gets renumbered whenever entries are merged/persisted. */
export function entryIdentity(entry: PaperTapeEntry): string {
  return `${entry.timestamp}|${entry.outline}|${entry.dictionary}|${entry.translation}|${entry.undo}`;
}

/** Classifies a stroke's translation for paper tape display and word grouping. */
export function classifyEntry(outline: string, translation: string): PaperTapeEntry["kind"] {
  if (outline === "*") return "undo";
  if (COMMAND_PATTERN.test(translation) || translation.startsWith("=")) return "command";
  if (RETURN_KEY_PATTERN.test(translation)) return "text";
  if (KEYBOARD_PATTERN.test(translation)) return "keyboard";
  return "text";
}

const ATOM_PATTERN = /\{[^}]*\}/g;

/** Resolves one `{...}` atom to its literal document output - e.g. a blank-line stroke can chain several of these (`{#Return}{#Return}` or `{^~|\n^}{^~|\n^}`), so each one is expanded independently. */
function resolveAtom(atom: string): string {
  if (GLUE_PREFIX_PATTERN.test(atom)) {
    let inner = atom.slice(2, -1);
    // "~|" flags a formatting atom (e.g. the newline in {^~|\n^}) rather than literal dictated text.
    if (inner.startsWith("~|")) inner = inner.slice(2);
    // A trailing "^" marks glue-on-both-sides (e.g. {^\n^}), not literal content.
    if (inner.endsWith("^")) inner = inner.slice(0, -1);
    return inner;
  }

  if (RETURN_KEY_PATTERN.test(atom)) return "\n";

  // Not a recognized glue/key-combo atom (e.g. {-|}, {.}) - keep it as literal text, unresolved.
  return atom;
}

/** Resolves a single entry's translation to its literal document output, expanding every glue/key-combo atom it contains. */
function resolveLiteral(translation: string): string {
  return translation.replace(ATOM_PATTERN, resolveAtom);
}

/** Groups a stream of tape entries into words, assigning each entry a `wordId`. */
export class WordGrouper {
  private openRun: PaperTapeEntry[] = [];
  private openWordId: string | undefined;
  private readonly listeners = new Set<(wordId: string, entries: readonly PaperTapeEntry[]) => void>();

  /** Fires with a word's current resolved entries whenever they change, including on its final update - there's no separate "closed" signal. */
  onWordUpdated(listener: (wordId: string, entries: readonly PaperTapeEntry[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Classifies `entry` and assigns its `wordId` in place, based on prior entries seen by this grouper. */
  onEntry(entry: PaperTapeEntry): void {
    if (entry.synthetic) {
      // A manual insert is never part of the live dictation stream, so it skips classification and must not touch openRun/openWordId.
      entry.kind = "text";
      entry.wordId = `w${entryIdentity(entry)}`;
      this.emit(entry.wordId, [entry]);
      return;
    }

    entry.kind = classifyEntry(entry.outline, entry.translation);

    if (entry.kind === "undo") {
      entry.wordId = this.openWordId;
      this.popFromOpenRun(entry.undo);
      this.notify();
      return;
    }

    if (entry.kind !== "text") {
      entry.wordId = undefined;
      this.openRun = [];
      this.openWordId = undefined;
      return;
    }

    const glued = GLUE_PREFIX_PATTERN.test(entry.translation);
    // A bare newline (e.g. {^~|\n^} or {#Return}) has no dictated word chars of its own, so it must
    // neither continue a run nor stay open for a later stroke to glue onto - otherwise deleting/editing
    // it would consume the neighboring word instead.
    const isBareNewline = /^\n+$/.test(resolveLiteral(entry.translation));
    const continuesRun = this.openRun.length > 0 && !isBareNewline && (entry.undo > 0 || glued);
    if (!continuesRun) {
      this.openRun = [];
      // Derived from the run's starting entry, not a counter - counters collide once wordIds are shared/persisted across windows.
      this.openWordId = `w${entryIdentity(entry)}`;
    }
    this.popFromOpenRun(entry.undo);

    entry.wordId = this.openWordId;
    this.openRun.push(entry);
    this.notify();

    if (isBareNewline) {
      this.openRun = [];
      this.openWordId = undefined;
    }
  }

  /** Resolves a word's current text by replaying its still-live (non-folded-away) entries in order. */
  static resolveText(entries: readonly PaperTapeEntry[]): string {
    return entries.map((e) => resolveLiteral(e.translation)).join("");
  }

  private popFromOpenRun(count: number): void {
    const popCount = Math.min(count, this.openRun.length);
    if (popCount > 0) this.openRun.splice(this.openRun.length - popCount, popCount);
  }

  private notify(): void {
    if (!this.openWordId) return;
    this.emit(this.openWordId, this.openRun);
  }

  private emit(wordId: string, entries: readonly PaperTapeEntry[]): void {
    for (const listener of this.listeners) listener(wordId, [...entries]);
  }
}
