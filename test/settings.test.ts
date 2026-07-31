import test from "node:test";
import assert from "node:assert/strict";
import type * as vscode from "vscode";
import { JavelinSettings } from "../src/settings";
import { FakeMemento } from "./fakeMemento";

function makeContext(initial: Record<string, unknown> = {}): vscode.ExtensionContext {
  return { globalState: new FakeMemento(initial) } as unknown as vscode.ExtensionContext;
}

test("defaults are all off", () => {
  const settings = new JavelinSettings(makeContext());
  assert.equal(settings.showTimestamps, false);
  assert.equal(settings.backgroundMonitoring, false);
  assert.equal(settings.persistPerWindow, false);
});

test("setPersistPerWindow(true) is rejected while backgroundMonitoring is on", async () => {
  const settings = new JavelinSettings(makeContext({ "javelin.backgroundMonitoring": true }));
  let fired = false;
  settings.onDidChange(() => {
    fired = true;
  });

  await settings.setPersistPerWindow(true);

  assert.equal(settings.persistPerWindow, false);
  assert.equal(fired, false, "a rejected update should not fire a change event");
});

test("setPersistPerWindow(true) succeeds while backgroundMonitoring is off", async () => {
  const settings = new JavelinSettings(makeContext());
  await settings.setPersistPerWindow(true);
  assert.equal(settings.persistPerWindow, true);
});

test("setBackgroundMonitoring(true) is rejected while persistPerWindow is on", async () => {
  const settings = new JavelinSettings(makeContext());
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
  const settings = new JavelinSettings(makeContext());
  await settings.setBackgroundMonitoring(true);
  assert.equal(settings.backgroundMonitoring, true);
});

test("turning off backgroundMonitoring does not touch an already-off persistPerWindow", async () => {
  const settings = new JavelinSettings(makeContext({ "javelin.backgroundMonitoring": true }));
  await settings.setBackgroundMonitoring(false);
  assert.equal(settings.persistPerWindow, false);
});

test("concurrent setBackgroundMonitoring(true) and setPersistPerWindow(true) calls never leave both settings on", async () => {
  // Concurrent calls must serialize - backgroundMonitoring and persistPerWindow are mutually exclusive.
  const settings = new JavelinSettings(makeContext());

  const a = settings.setBackgroundMonitoring(true);
  const b = settings.setPersistPerWindow(true);
  await Promise.all([a, b]);

  assert.ok(
    !(settings.backgroundMonitoring && settings.persistPerWindow),
    `mutually exclusive settings both ended up true: backgroundMonitoring=${settings.backgroundMonitoring}, persistPerWindow=${settings.persistPerWindow}`
  );
});

test("a setting changed in one window is not visible in an already-open window until it reloads", async () => {
  // vscode.ExtensionContext.globalState is not live-synced across windows in the
  // same session (https://github.com/Microsoft/vscode/issues/55834): each window's
  // extension host has its own in-process copy, taken when that window activated.
  // Model that here as two independent FakeMementos, with "window B" starting from
  // a snapshot of the same shared disk state "window A" writes through to.
  const disk = new FakeMemento();
  const windowA = new JavelinSettings({ globalState: disk } as unknown as vscode.ExtensionContext);
  const windowB = new JavelinSettings({
    globalState: new FakeMemento(disk.snapshot()),
  } as unknown as vscode.ExtensionContext);

  await windowA.setPersistPerWindow(true);

  assert.equal(windowA.persistPerWindow, true);
  assert.equal(windowB.persistPerWindow, false, "window B hasn't reloaded, so it can't see A's change yet");

  // Window B reopens/reloads: it re-reads the (now up to date) shared disk state fresh.
  const windowBReloaded = new JavelinSettings({
    globalState: new FakeMemento(disk.snapshot()),
  } as unknown as vscode.ExtensionContext);
  assert.equal(windowBReloaded.persistPerWindow, true);
});
