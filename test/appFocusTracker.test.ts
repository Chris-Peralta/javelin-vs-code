import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type * as vscode from "vscode";
import { AppFocusTracker, type WindowStateSource } from "../src/appFocusTracker";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const vscodeMock = require("./vscodeMock.cjs") as {
  window: { state: { focused: boolean }; __setFocused: (focused: boolean) => void };
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeContext(lockDir: string): vscode.ExtensionContext {
  return { globalStorageUri: { fsPath: lockDir } } as unknown as vscode.ExtensionContext;
}

type FocusEntry = { focused: boolean; timestamp: number };

function focusFilePath(lockDir: string, windowId: string): string {
  return path.join(lockDir, `focus-${encodeURIComponent(windowId)}.json`);
}

function writeFocusEntry(lockDir: string, windowId: string, entry: FocusEntry): void {
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(focusFilePath(lockDir, windowId), JSON.stringify(entry));
}

function readFocusEntry(lockDir: string, windowId: string): FocusEntry | undefined {
  try {
    return JSON.parse(fs.readFileSync(focusFilePath(lockDir, windowId), "utf8"));
  } catch {
    return undefined;
  }
}

function focusFilesIn(lockDir: string): string[] {
  try {
    return fs.readdirSync(lockDir).filter((f) => f.startsWith("focus-") && f.endsWith(".json"));
  } catch {
    return [];
  }
}

/** A standalone fake window, independent of the shared `vscodeMock.window` singleton - see its own doc comment for why that matters when simulating more than one window. */
function makeWindowStateSource(initialFocused: boolean): WindowStateSource & { setFocused: (focused: boolean) => void } {
  const listeners = new Set<(e: { focused: boolean }) => void>();
  let state = { focused: initialFocused };
  return {
    get state() {
      return state;
    },
    onDidChangeWindowState(listener: (e: { focused: boolean }) => void) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    setFocused(focused: boolean) {
      state = { focused };
      for (const listener of [...listeners]) listener({ focused });
    },
  };
}

test.beforeEach(() => {
  vscodeMock.window.__setFocused(true);
});

test("adopts this window's own focus state when no shared lock file exists yet", async () => {
  const lockDir = fs.mkdtempSync(path.join(os.tmpdir(), "javelin-focus-"));
  vscodeMock.window.__setFocused(true);

  const tracker = new AppFocusTracker(makeContext(lockDir));
  try {
    await delay(50);
    assert.equal(tracker.isFocused(), true);
  } finally {
    tracker.dispose();
  }
});

test("does not let a stale sibling file override this window's fresh local observation", async () => {
  // A sibling file older than MAX_SHARED_STATE_AGE_MS must not override a fresh local read.
  const lockDir = fs.mkdtempSync(path.join(os.tmpdir(), "javelin-focus-"));
  writeFocusEntry(lockDir, "other-window", { focused: false, timestamp: Date.now() - 60_000 });
  vscodeMock.window.__setFocused(true);

  const tracker = new AppFocusTracker(makeContext(lockDir), "this-window");
  try {
    await delay(50);

    assert.equal(tracker.isFocused(), true, "stale entries should not override the correct local observation");
    assert.equal(
      readFocusEntry(lockDir, "this-window")?.focused,
      true,
      "the baseline write should still record this window's own claim"
    );
  } finally {
    tracker.dispose();
  }
});

test("a stuck-true local flag is corrected once a strictly fresher claim from another window arrives", async () => {
  // Reproduces the bug this class works around: a stuck-true local flag, corrected by a sibling's later claim.
  const lockDir = fs.mkdtempSync(path.join(os.tmpdir(), "javelin-focus-"));
  vscodeMock.window.__setFocused(true);

  const tracker = new AppFocusTracker(makeContext(lockDir), "this-window");
  try {
    await delay(50); // let this window settle and publish its own baseline claim
    assert.equal(tracker.isFocused(), true, "sanity check");

    writeFocusEntry(lockDir, "other-window", { focused: true, timestamp: Date.now() });
    await delay(50); // the directory watcher picks up the new sibling file

    assert.equal(
      tracker.isFocused(),
      false,
      "a strictly fresher claim from another window must override this window's stuck-true local flag"
    );
  } finally {
    tracker.dispose();
  }
});

test("dispose() called before init() finishes does not go on to create its lock file", async () => {
  // dispose() must abort init() before it creates the watcher or writes anything.
  const lockDir = fs.mkdtempSync(path.join(os.tmpdir(), "javelin-focus-"));

  const tracker = new AppFocusTracker(makeContext(lockDir));
  tracker.dispose();
  await delay(50);

  assert.deepEqual(focusFilesIn(lockDir), [], "init() should have aborted before writing the baseline");
});

test("serializes writeSharedState calls so slower I/O for an earlier write can't clobber a later one", async () => {
  // Writes must land on disk in call order, regardless of individual I/O timing.
  const lockDir = fs.mkdtempSync(path.join(os.tmpdir(), "javelin-focus-"));
  vscodeMock.window.__setFocused(true);

  const tracker = new AppFocusTracker(makeContext(lockDir), "this-window");
  await delay(50); // let init() finish its own baseline write first

  const originalWriteFile = fs.promises.writeFile;
  let calls = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (fs.promises as any).writeFile = async (...args: Parameters<typeof fs.promises.writeFile>) => {
    calls++;
    if (calls === 1) await delay(30); // slow down the first (older) write
    return originalWriteFile.apply(fs.promises, args);
  };

  try {
    vscodeMock.window.__setFocused(false); // queued write #1 (focused: false), slowed down
    vscodeMock.window.__setFocused(true); // queued write #2 (focused: true)
    await delay(60);

    assert.equal(
      readFocusEntry(lockDir, "this-window")?.focused,
      true,
      "the later write must win regardless of I/O timing"
    );
  } finally {
    fs.promises.writeFile = originalWriteFile;
    tracker.dispose();
  }
});

test("a focus handoff between two live windows converges correctly even if the losing window's blur is observed after the winning window's focus", async () => {
  // Reproduces the production race: B's fresh claim must survive A's blur landing with a later timestamp.
  const lockDir = fs.mkdtempSync(path.join(os.tmpdir(), "javelin-focus-"));

  const sourceA = makeWindowStateSource(true);
  const sourceB = makeWindowStateSource(false);

  // Settle A before B exists, so B's initial read can't race A's baseline write.
  const trackerA = new AppFocusTracker(makeContext(lockDir), "window-a", sourceA);
  await delay(50);
  assert.equal(trackerA.isFocused(), true, "sanity check");

  const trackerB = new AppFocusTracker(makeContext(lockDir), "window-b", sourceB);
  await delay(50);
  assert.equal(trackerB.isFocused(), false, "sanity check: B is not the holder yet, A's baseline claim is");

  try {
    // Fire B's gain first, then A's loss - the losing window's write should embed the later timestamp.
    sourceB.setFocused(true);
    sourceA.setFocused(false);
    await delay(100);

    assert.equal(trackerB.isFocused(), true, "B just gained real focus and must not show unfocused");
    assert.equal(trackerA.isFocused(), false, "A lost real focus and must not show focused just because B has it");
  } finally {
    trackerA.dispose();
    trackerB.dispose();
  }
});

test("a window stuck reporting focused after a sibling silently steals focus stops recording once the real holder actually releases", async () => {
  // Window A never receives a blur when B steals focus, so A's local flag stays stuck true.
  const lockDir = fs.mkdtempSync(path.join(os.tmpdir(), "javelin-focus-"));

  const sourceA = makeWindowStateSource(true);
  const trackerA = new AppFocusTracker(makeContext(lockDir), "window-a", sourceA);
  await delay(50);
  assert.equal(trackerA.isFocused(), true);

  // B opens and takes focus - A is never told (the bug), so it never writes again.
  const sourceB = makeWindowStateSource(true);
  const trackerB = new AppFocusTracker(makeContext(lockDir), "window-b", sourceB);
  try {
    await delay(50);
    assert.equal(trackerB.isFocused(), true);

    // Age A's claim past MAX_SHARED_STATE_AGE_MS instead of sleeping for real.
    const entry = readFocusEntry(lockDir, "window-a")!;
    entry.timestamp -= 10_000;
    writeFocusEntry(lockDir, "window-a", entry);

    // Focus genuinely leaves VS Code entirely - B correctly fires blur.
    sourceB.setFocused(false);
    await delay(50);

    assert.equal(trackerB.isFocused(), false, "the real holder released, so B should show unfocused");
    assert.equal(
      trackerA.isFocused(),
      false,
      "A's stuck claim is stale and must not keep the aggregate stuck focused"
    );
  } finally {
    trackerA.dispose();
    trackerB.dispose();
  }
});
