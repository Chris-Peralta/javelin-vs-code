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

function lockFilePath(lockDir: string): string {
  return path.join(lockDir, "focus-state.json");
}

type SharedFocusState = Record<string, { focused: boolean; timestamp: number }>;

function readLockFile(lockDir: string): SharedFocusState | undefined {
  try {
    return JSON.parse(fs.readFileSync(lockFilePath(lockDir), "utf8"));
  } catch {
    return undefined;
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

test("does not let a stale shared lock file override this window's fresh local observation", async () => {
  // A lock file with only entries older than MAX_SHARED_STATE_AGE_MS must not override a fresh local read.
  const lockDir = fs.mkdtempSync(path.join(os.tmpdir(), "javelin-focus-"));
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(
    lockFilePath(lockDir),
    JSON.stringify({ "other-window": { focused: false, timestamp: Date.now() - 60_000 } })
  );
  vscodeMock.window.__setFocused(true);

  const tracker = new AppFocusTracker(makeContext(lockDir), "this-window");
  try {
    await delay(50);

    assert.equal(tracker.isFocused(), true, "stale entries should not override the correct local observation");
    assert.equal(
      readLockFile(lockDir)?.["this-window"]?.focused,
      true,
      "the baseline write should still record this window's own claim"
    );
  } finally {
    tracker.dispose();
  }
});

test("adopts a fresh shared lock file written by another (still-running) window", async () => {
  const lockDir = fs.mkdtempSync(path.join(os.tmpdir(), "javelin-focus-"));
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(
    lockFilePath(lockDir),
    JSON.stringify({ "other-window": { focused: true, timestamp: Date.now() } })
  );
  // Local read disagrees, but the fresher cross-window claim should win.
  vscodeMock.window.__setFocused(false);

  const tracker = new AppFocusTracker(makeContext(lockDir), "this-window");
  try {
    await delay(50);
    assert.equal(tracker.isFocused(), true);
  } finally {
    tracker.dispose();
  }
});

test("dispose() called before init() finishes does not go on to create the lock file", async () => {
  // dispose() must abort init() before it creates the watcher or writes anything.
  const lockDir = fs.mkdtempSync(path.join(os.tmpdir(), "javelin-focus-"));

  const tracker = new AppFocusTracker(makeContext(lockDir));
  tracker.dispose();
  await delay(50);

  assert.equal(readLockFile(lockDir), undefined, "init() should have aborted before writing the baseline");
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
      readLockFile(lockDir)?.["this-window"]?.focused,
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
  assert.equal(trackerB.isFocused(), true, "sanity check: B should have adopted A's baseline claim");

  try {
    // Fire B's gain first, then A's loss - the losing window's write should embed the later timestamp.
    sourceB.setFocused(true);
    sourceA.setFocused(false);
    await delay(100);

    assert.equal(trackerB.isFocused(), true, "B just gained real focus and must not show unfocused");
    assert.equal(trackerA.isFocused(), true, "A lost focus, but VS Code (window B) still has it overall");
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
    const data = readLockFile(lockDir)!;
    data["window-a"].timestamp -= 10_000;
    fs.writeFileSync(lockFilePath(lockDir), JSON.stringify(data));

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
