import test from "node:test";
import assert from "node:assert/strict";
import { classifyEntry, WordGrouper } from "../src/paperTapeWordGrouping";
import type { PaperTapeEntry } from "../src/paperTapeRecorder";

let nextId = 1;
let nextTimestamp = 1;

function makeEntry(outline: string, translation: string, undo = 0, dictionary = "lapwing-base.json"): PaperTapeEntry {
  return {
    id: nextId++,
    outline,
    dictionary,
    translation,
    undo,
    timestamp: nextTimestamp++,
    kind: "text",
  };
}

test("classifyEntry", async (t) => {
  await t.test("a bare star is undo", () => {
    assert.equal(classifyEntry("*", ""), "undo");
  });

  await t.test("a javelin {:...} command is command", () => {
    assert.equal(classifyEntry("+-P", "{:retro_title:1}{:retro_replace_space:1:}"), "command");
  });

  await t.test("a leading = is command", () => {
    assert.equal(classifyEntry("ABC", "=someCommand"), "command");
  });

  await t.test("a {#...} key combo is keyboard", () => {
    assert.equal(classifyEntry("EFBG", "{#Escape}{^}"), "keyboard");
  });

  await t.test("plain punctuation braces like {.} are text, not commands", () => {
    assert.equal(classifyEntry("TP-PL", "{.}"), "text");
  });

  await t.test("a glued newline stroke like {^~|\\n^} is text, so it stays deletable/editable", () => {
    assert.equal(classifyEntry("R-R", "{^~|\n^}"), "text");
  });

  await t.test("a {#Return} key combo is text, unlike other key combos - it produces a real newline", () => {
    assert.equal(classifyEntry("R-R", "{#Return}"), "text");
  });

  await t.test("an untranslated raw-outline fallback is text", () => {
    assert.equal(classifyEntry("SKWR-PT", "SKWR-PT"), "text");
  });

  await t.test("a plain word is text", () => {
    assert.equal(classifyEntry("HOU", "how"), "text");
  });
});

test("WordGrouper", async (t) => {
  await t.test("a single-stroke word gets its own wordId and resolves to its translation", () => {
    const grouper = new WordGrouper();
    const updates: { wordId: string; text: string }[] = [];
    grouper.onWordUpdated((wordId, entries) => updates.push({ wordId, text: WordGrouper.resolveText(entries) }));

    const how = makeEntry("HOU", "how");
    grouper.onEntry(how);

    assert.equal(how.kind, "text");
    assert.ok(how.wordId);
    assert.deepEqual(updates, [{ wordId: how.wordId, text: "how" }]);
  });

  await t.test("two plain words in a row get different wordIds", () => {
    const grouper = new WordGrouper();
    const how = makeEntry("HOU", "how");
    const are = makeEntry("-R", "are");
    grouper.onEntry(how);
    grouper.onEntry(are);

    assert.notEqual(how.wordId, are.wordId);
  });

  await t.test("a command or keyboard entry closes the run - it doesn't merge adjacent words", () => {
    const grouper = new WordGrouper();
    const how = makeEntry("HOU", "how");
    const escape = makeEntry("EFBG", "{#Escape}{^}");
    const are = makeEntry("-R", "are");
    grouper.onEntry(how);
    grouper.onEntry(escape);
    grouper.onEntry(are);

    assert.equal(escape.kind, "keyboard");
    assert.equal(escape.wordId, undefined);
    assert.notEqual(how.wordId, are.wordId);
  });

  await t.test("a glued newline stroke gets its own word instead of merging into a neighboring word", () => {
    const grouper = new WordGrouper();
    const updates: { wordId: string; text: string }[] = [];
    grouper.onWordUpdated((wordId, entries) => updates.push({ wordId, text: WordGrouper.resolveText(entries) }));

    const how = makeEntry("HOU", "how");
    const newline = makeEntry("R-R", "{^~|\n^}");
    const are = makeEntry("-R", "are");
    grouper.onEntry(how);
    grouper.onEntry(newline);
    grouper.onEntry(are);

    assert.equal(newline.kind, "text");
    assert.ok(newline.wordId, "a bare newline is still deletable/editable on its own");
    assert.notEqual(newline.wordId, how.wordId);
    assert.notEqual(newline.wordId, are.wordId);
    assert.notEqual(how.wordId, are.wordId);

    const newlineUpdate = updates.find((u) => u.wordId === newline.wordId);
    assert.equal(newlineUpdate?.text, "\n");
  });

  await t.test("a {#Return} stroke behaves the same as a glued newline: its own word, not merged", () => {
    const grouper = new WordGrouper();
    const how = makeEntry("HOU", "how");
    const returnKey = makeEntry("R-R", "{#Return}");
    const are = makeEntry("-R", "are");
    grouper.onEntry(how);
    grouper.onEntry(returnKey);
    grouper.onEntry(are);

    assert.equal(returnKey.kind, "text");
    assert.ok(returnKey.wordId);
    assert.notEqual(returnKey.wordId, how.wordId);
    assert.notEqual(returnKey.wordId, are.wordId);
    assert.equal(WordGrouper.resolveText([returnKey]), "\n");
  });

  await t.test("a later glued stroke does not fold onto an earlier newline word", () => {
    // A glued stroke right after a newline must start its own word, not attach to the newline.
    const grouper = new WordGrouper();
    const newline = makeEntry("R-R", "{^~|\n^}");
    const world = makeEntry("WORLD", "{^world}");
    grouper.onEntry(newline);
    grouper.onEntry(world);

    assert.notEqual(world.wordId, newline.wordId);
  });

  await t.test("real text glued alongside a newline in the same stroke stays one editable unit", () => {
    // A single stroke can combine a line break with dictated text, e.g. "{^~|\n^}World".
    const grouper = new WordGrouper();
    const combined = makeEntry("R-R", "{^~|\n^}World");
    grouper.onEntry(combined);

    assert.equal(combined.kind, "text");
    assert.ok(combined.wordId);
    assert.equal(WordGrouper.resolveText([combined]), "\nWorld");
  });

  await t.test("a blank-line stroke chaining two glued newline atoms resolves both, not just the first", () => {
    // e.g. a dedicated "blank line" stroke defined as two back-to-back glue atoms in one translation.
    const blankLine = makeEntry("R-R", "{^~|\n^}{^~|\n^}");
    assert.equal(WordGrouper.resolveText([blankLine]), "\n\n");
    assert.equal(classifyEntry(blankLine.outline, blankLine.translation), "text");
  });

  await t.test("a blank-line stroke chaining two {#Return} key combos resolves both, not just the first", () => {
    const blankLine = makeEntry("R-R", "{#Return}{#Return}");
    assert.equal(WordGrouper.resolveText([blankLine]), "\n\n");
    assert.equal(classifyEntry(blankLine.outline, blankLine.translation), "text");
  });

  await t.test("multiple newlines packed into a single glue atom resolve together", () => {
    // e.g. "{^~|\n\n^}" - one atom carrying two newlines, rather than two chained atoms.
    const blankLine = makeEntry("R-R", "{^~|\n\n^}");
    assert.equal(WordGrouper.resolveText([blankLine]), "\n\n");
  });

  await t.test("a chained multi-newline stroke still gets its own word, isolated from neighbors", () => {
    const grouper = new WordGrouper();
    const how = makeEntry("HOU", "how");
    const blankLine = makeEntry("R-R", "{#Return}{#Return}");
    const are = makeEntry("-R", "are");
    grouper.onEntry(how);
    grouper.onEntry(blankLine);
    grouper.onEntry(are);

    assert.ok(blankLine.wordId);
    assert.notEqual(blankLine.wordId, how.wordId);
    assert.notEqual(blankLine.wordId, are.wordId);
    assert.notEqual(how.wordId, are.wordId);
  });

  await t.test("a word fully cancelled by a star does not carry into the next word", () => {
    // Mirrors the "today" -> "*" -> "day" sequence.
    const grouper = new WordGrouper();
    const updates: { wordId: string; text: string }[] = [];
    grouper.onWordUpdated((wordId, entries) => updates.push({ wordId, text: WordGrouper.resolveText(entries) }));

    const today = makeEntry("TKA*EU", "today", 1);
    const star = makeEntry("*", "", 1);
    const day = makeEntry("TKAEU", "day", 0);
    grouper.onEntry(today);
    grouper.onEntry(star);
    grouper.onEntry(day);

    assert.equal(star.kind, "undo");
    assert.equal(star.wordId, today.wordId, "the star is tagged into the word it undid, for audit grouping");
    assert.notEqual(day.wordId, today.wordId, "a fresh word starts once the cancelled run resolves to nothing");

    const lastUpdateForCancelledWord = [...updates].reverse().find((u) => u.wordId === today.wordId);
    assert.equal(lastUpdateForCancelledWord?.text, "", "the cancelled word's live text resolves to empty");

    const dayUpdate = updates.find((u) => u.wordId === day.wordId);
    assert.equal(dayUpdate?.text, "day");
  });

  await t.test("an undo-fold plus glue-suffix chain groups into one word (the documentation case)", () => {
    // dock -> document (undo 1) -> {^iate} -> * (undo 1, cancels iate) -> {^ation}, resolving to "documentation".
    const grouper = new WordGrouper();
    let lastUpdate: { wordId: string; entries: readonly PaperTapeEntry[] } | undefined;
    grouper.onWordUpdated((wordId, entries) => (lastUpdate = { wordId, entries }));

    const dock = makeEntry("TKOBG", "dock", 0);
    const document = makeEntry("-PLT", "document", 1);
    const iate = makeEntry("KWRAEUT", "{^iate}", 0);
    const star = makeEntry("*", "", 1);
    const ation = makeEntry("KWRAEUGS", "{^ation}", 0);
    grouper.onEntry(dock);
    grouper.onEntry(document);
    grouper.onEntry(iate);
    grouper.onEntry(star);
    grouper.onEntry(ation);

    for (const e of [dock, document, iate, star, ation]) {
      assert.equal(e.wordId, dock.wordId, `${e.outline} should share the run's wordId`);
    }

    assert.ok(lastUpdate);
    assert.equal(WordGrouper.resolveText(lastUpdate!.entries), "documentation");
    // "dock" and "iate" were folded away - they keep their wordId but are excluded from the word's live resolved text.
    assert.equal(lastUpdate!.entries.includes(dock), false);
    assert.equal(lastUpdate!.entries.includes(iate), false);
    assert.equal(lastUpdate!.entries.includes(document), true);
    assert.equal(lastUpdate!.entries.includes(ation), true);
  });

  await t.test("fires an update for the very last entry of the tape, with no trailing entry needed", () => {
    const grouper = new WordGrouper();
    let fired = false;
    grouper.onWordUpdated(() => (fired = true));

    grouper.onEntry(makeEntry("HOU", "how"));

    assert.equal(fired, true);
  });

  await t.test("resolveText keeps content that follows a glue prefix instead of dropping it", () => {
    // "{^}" is a no-op glue marker followed by unrelated content that must survive.
    const noOpGlueWithTrailer = makeEntry("KPA*", "{^}{-|}");
    assert.equal(WordGrouper.resolveText([noOpGlueWithTrailer]), "{-|}");

    // A glue prefix that does carry text still resolves to just that text.
    const ation = makeEntry("KWRAEUGS", "{^ation}");
    assert.equal(WordGrouper.resolveText([ation]), "ation");
  });

  await t.test("a synthetic insert is always classified as text, even if it looks like a command/keyboard entry", () => {
    const grouper = new WordGrouper();
    const insert = makeEntry("", "={#Escape}{^}", 0, "");
    insert.synthetic = true;

    grouper.onEntry(insert);

    assert.equal(insert.kind, "text");
    assert.ok(insert.wordId);
  });

  await t.test("a synthetic insert does not touch the in-progress run of a live dictation word", () => {
    const grouper = new WordGrouper();
    const updates: { wordId: string; text: string }[] = [];
    grouper.onWordUpdated((wordId, entries) => updates.push({ wordId, text: WordGrouper.resolveText(entries) }));

    // "dock" is mid correction-chain when a manual insert lands before the correcting stroke arrives.
    const dock = makeEntry("TKOBG", "dock", 0);
    grouper.onEntry(dock);

    const insert = makeEntry("", "official", 0, "");
    insert.synthetic = true;
    grouper.onEntry(insert);

    const document = makeEntry("-PLT", "document", 1);
    grouper.onEntry(document);

    assert.notEqual(insert.wordId, dock.wordId, "the insert must not join dock's run");
    assert.equal(document.wordId, dock.wordId, "the correcting stroke must still fold into dock's run, unaffected by the insert");

    const lastUpdateForDock = [...updates].reverse().find((u) => u.wordId === dock.wordId);
    assert.equal(lastUpdateForDock?.text, "document", "dock's run should resolve normally, as if the insert never happened");
  });
});
