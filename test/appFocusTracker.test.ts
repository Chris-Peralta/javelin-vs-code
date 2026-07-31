import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type * as vscode from "vscode";
import { AppFocusTracker } from "../src/appFocusTracker";

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

function readLockFile(lockDir: string): { focused: boolean; timestamp: number } | undefined {
  try {
    return JSON.parse(fs.readFileSync(lockFilePath(lockDir), "utf8"));
  } catch {
    return undefined;
  }
}

test.beforeEach(() => {
  vscodeMock.window.__setFocused(true);
});

test("adopts this window's own focus state when no shared lock file exists yet", async () => {
  const lockDir = fs.mkdtempSync(path.join(os.tmpdir(), "javelin-focus-"));
  vscodeMock.window.__setFocused(true);

  const tracker = new AppFocusTracker(makeContext(lockDir));
  await delay(50);

  assert.equal(tracker.isFocused(), true);
  tracker.dispose();
});

test("does not let a stale shared lock file override this window's fresh local observation", async () => {
  // A lock file older than MAX_SHARED_STATE_AGE_MS must not override a fresh local read.
  const lockDir = fs.mkdtempSync(path.join(os.tmpdir(), "javelin-focus-"));
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(
    lockFilePath(lockDir),
    JSON.stringify({ focused: false, timestamp: Date.now() - 60_000 })
  );
  vscodeMock.window.__setFocused(true);

  const tracker = new AppFocusTracker(makeContext(lockDir));
  await delay(50);

  assert.equal(tracker.isFocused(), true, "stale file should not override the correct local observation");
  assert.equal(readLockFile(lockDir)?.focused, true, "the stale file should be overwritten with the correct baseline");
  tracker.dispose();
});

test("adopts a fresh shared lock file written by another (still-running) window", async () => {
  const lockDir = fs.mkdtempSync(path.join(os.tmpdir(), "javelin-focus-"));
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(lockFilePath(lockDir), JSON.stringify({ focused: false, timestamp: Date.now() }));
  // This window's own local read disagrees, but the fresher cross-window signal
  // should win - that's the whole point of this shared-state mechanism.
  vscodeMock.window.__setFocused(true);

  const tracker = new AppFocusTracker(makeContext(lockDir));
  await delay(50);

  assert.equal(tracker.isFocused(), false);
  tracker.dispose();
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

  const tracker = new AppFocusTracker(makeContext(lockDir));
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

    assert.equal(readLockFile(lockDir)?.focused, true, "the later write must win regardless of I/O timing");
  } finally {
    fs.promises.writeFile = originalWriteFile;
    tracker.dispose();
  }
});
