import test from "node:test";
import assert from "node:assert/strict";
import * as vscode from "vscode";
import { KeyboardProtocolSync } from "../src/keyboardProtocolSync";
import type { JavelinHidDevice } from "../src/javelinHidDevice";

/** Stands in for JavelinHidDevice: records sent commands and lets tests fire fake connection events. */
class FakeDevice {
  connected = false;
  sentCommands: string[] = [];
  private nextResponse = "OK";
  private readonly listeners = new Map<string, Set<() => void>>();

  on(type: string, listener: () => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }

  off(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  fire(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }

  async sendCommand(command: string): Promise<string> {
    this.sentCommands.push(command);
    return this.nextResponse;
  }

  /** Controls what the next `sendCommand` call resolves with. */
  respondWith(response: string): void {
    this.nextResponse = response;
  }
}

test("pushes the default protocol command on connect when compatibilityMode is 0", async () => {
  const device = new FakeDevice();
  device.connected = true;
  new KeyboardProtocolSync(device as unknown as JavelinHidDevice);

  vscode.workspace.__setConfig("javelin.compatibilityMode", 0);
  device.fire("connected");
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(device.sentCommands, ["set_keyboard_protocol default"]);
});

test("pushes the compatibility mode command on connect when compatibilityMode is set", async () => {
  const device = new FakeDevice();
  device.connected = true;
  new KeyboardProtocolSync(device as unknown as JavelinHidDevice);

  vscode.workspace.__setConfig("javelin.compatibilityMode", 5);
  device.fire("connected");
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(device.sentCommands, ["set_keyboard_protocol 5 compatibility"]);
});

test("pushes again when javelin.compatibilityMode changes", async () => {
  const device = new FakeDevice();
  device.connected = true;
  new KeyboardProtocolSync(device as unknown as JavelinHidDevice);

  vscode.workspace.__setConfig("javelin.compatibilityMode", 7);
  vscode.workspace.__fireConfigChange("javelin.compatibilityMode");
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(device.sentCommands, ["set_keyboard_protocol 7 compatibility"]);
});

test("logs an error when the device rejects the command", async () => {
  const device = new FakeDevice();
  device.connected = true;
  device.respondWith('ERR Unable to set keyboard protocol: "5 compatibility"');
  new KeyboardProtocolSync(device as unknown as JavelinHidDevice);

  vscode.workspace.__setConfig("javelin.compatibilityMode", 5);
  device.fire("connected");
  await new Promise((resolve) => setImmediate(resolve));

  const lines: string[] = vscode.window.__getOutputChannelLines();
  assert.ok(lines.at(-1)?.includes("device rejected keyboard protocol command"));
});

test("dispose stops pushing on connect and on config change", async () => {
  const device = new FakeDevice();
  device.connected = true;
  const sync = new KeyboardProtocolSync(device as unknown as JavelinHidDevice);
  sync.dispose();

  device.fire("connected");
  vscode.workspace.__fireConfigChange("javelin.compatibilityMode");
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(device.sentCommands, []);
});
