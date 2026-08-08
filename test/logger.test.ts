import test from "node:test";
import assert from "node:assert/strict";
import * as vscode from "vscode";
import { logDebug, logError, logInfo, logWarn, setLogLevel } from "../src/logger";

function lines(): string[] {
  return (vscode.window as unknown as { __getOutputChannelLines(): string[] }).__getOutputChannelLines();
}

function lastLine(): string | undefined {
  return lines().at(-1);
}

test("default level WARN drops DEBUG and INFO but keeps WARN and ERROR", () => {
  setLogLevel("WARN");
  const before = lines().length;

  logDebug("debug msg");
  logInfo("info msg");
  assert.equal(lines().length, before, "DEBUG/INFO should not be written at WARN level");

  logWarn("warn msg");
  assert.ok(lastLine()?.includes("[WARN] warn msg"));

  logError("error msg");
  assert.ok(lastLine()?.includes("[ERROR] error msg"));
});

test("setLogLevel(DEBUG) allows every level through", () => {
  setLogLevel("DEBUG");

  logDebug("all debug msg");
  assert.ok(lastLine()?.includes("[DEBUG] all debug msg"));

  logInfo("all info msg");
  assert.ok(lastLine()?.includes("[INFO] all info msg"));
});

test("setLogLevel(ERROR) drops DEBUG, INFO, and WARN", () => {
  setLogLevel("ERROR");
  const before = lines().length;

  logDebug("dropped debug");
  logInfo("dropped info");
  logWarn("dropped warn");
  assert.equal(lines().length, before, "only ERROR should be written at ERROR level");

  logError("kept error");
  assert.ok(lastLine()?.includes("[ERROR] kept error"));
});
