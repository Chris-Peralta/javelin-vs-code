import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type * as vscode from "vscode";
import { JavelinSettings } from "../src/settings";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "javelin-settings-"));
}

function makeContext(storageDir: string): vscode.ExtensionContext {
  return { globalStorageUri: { fsPath: storageDir } } as unknown as vscode.ExtensionContext;
}

test("defaults are all off", () => {
  const settings = new JavelinSettings(makeContext(tmpDir()));
  assert.equal(settings.showTimestamps, false);
  assert.equal(settings.backgroundMonitoring, false);
  assert.equal(settings.persistPerWindow, false);
});

test("setPersistPerWindow(true) is rejected while backgroundMonitoring is on", async () => {
  const settings = new JavelinSettings(makeContext(tmpDir()));
  await settings.setBackgroundMonitoring(true);

  let fired = false;
  settings.onDidChange(() => {
    fired = true;
  });

  await settings.setPersistPerWindow(true);

  assert.equal(settings.persistPerWindow, false);
  assert.equal(fired, false, "a rejected update should not fire a change event");
});

test("setPersistPerWindow(true) succeeds while backgroundMonitoring is off", async () => {
  const settings = new JavelinSettings(makeContext(tmpDir()));
  await settings.setPersistPerWindow(true);
  assert.equal(settings.persistPerWindow, true);
});

test("setBackgroundMonitoring(true) is rejected while persistPerWindow is on", async () => {
  const settings = new JavelinSettings(makeContext(tmpDir()));
  await settings.setPersistPerWindow(true);

  let fired = false;
  settings.onDidChange(() => {
    fired = true;
  });

  await settings.setBackgroundMonitoring(true);

  assert.equal(settings.backgroundMonitoring, false);
  assert.equal(settings.persistPerWindow, true);
  assert.equal(fired, false, "a rejected update should not fire a change event");
});

test("setBackgroundMonitoring(true) succeeds while persistPerWindow is off", async () => {
  const settings = new JavelinSettings(makeContext(tmpDir()));
  await settings.setBackgroundMonitoring(true);
  assert.equal(settings.backgroundMonitoring, true);
});

test("turning off backgroundMonitoring does not touch an already-off persistPerWindow", async () => {
  const settings = new JavelinSettings(makeContext(tmpDir()));
  await settings.setBackgroundMonitoring(true);
  await settings.setBackgroundMonitoring(false);
  assert.equal(settings.persistPerWindow, false);
});

test("concurrent setBackgroundMonitoring(true) and setPersistPerWindow(true) calls never leave both settings on", async () => {
  // Concurrent calls must serialize - backgroundMonitoring and persistPerWindow are mutually exclusive.
  const settings = new JavelinSettings(makeContext(tmpDir()));

  const a = settings.setBackgroundMonitoring(true);
  const b = settings.setPersistPerWindow(true);
  await Promise.all([a, b]);

  assert.ok(
    !(settings.backgroundMonitoring && settings.persistPerWindow),
    `mutually exclusive settings both ended up true: backgroundMonitoring=${settings.backgroundMonitoring}, persistPerWindow=${settings.persistPerWindow}`
  );
});

test("a fresh window picks up values already on disk from a previous session", async () => {
  const dir = tmpDir();
  const first = new JavelinSettings(makeContext(dir));
  await first.setShowTimestamps(true);
  first.dispose();

  const second = new JavelinSettings(makeContext(dir));
  assert.equal(second.showTimestamps, true);
  second.dispose();
});

test("a setting changed in one window becomes visible in an already-open sibling window, without reloading", async () => {
  const dir = tmpDir();
  const windowA = new JavelinSettings(makeContext(dir));
  const windowB = new JavelinSettings(makeContext(dir));

  try {
    let fired: boolean | undefined;
    windowB.onDidChange((snapshot) => {
      fired = snapshot.showTimestamps;
    });

    await windowA.setShowTimestamps(true);
    await delay(50); // let window B's directory watcher pick up the change

    assert.equal(windowB.showTimestamps, true, "window B should see A's change live, without reloading");
    assert.equal(fired, true, "window B should fire onDidChange for a sibling window's write");
  } finally {
    windowA.dispose();
    windowB.dispose();
  }
});

test("a sibling window's write is not lost when another window writes a different setting before its watcher fires", async () => {
  const dir = tmpDir();
  const windowA = new JavelinSettings(makeContext(dir));
  const windowB = new JavelinSettings(makeContext(dir));

  try {
    await windowA.setShowTimestamps(true);
    // B writes before its directory watcher has had a chance to pick up A's change.
    await windowB.setBackgroundMonitoring(true);

    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8"));
    assert.equal(onDisk.showTimestamps, true, "A's write should not be lost");
    assert.equal(onDisk.backgroundMonitoring, true, "B's write should not be lost");
  } finally {
    windowA.dispose();
    windowB.dispose();
  }
});
