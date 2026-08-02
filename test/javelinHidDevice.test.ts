import test from "node:test";
import assert from "node:assert/strict";
import type { Device as NodeHidDeviceInfo } from "node-hid";
import { buildUdevRule } from "../src/javelinHidDevice";

/** Runs `fn` with `process.platform` temporarily overridden, restoring it afterward. */
function withPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
  const original = process.platform;
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, "platform", { value: original, configurable: true });
  }
}

test("builds the udev rule from the device's vendor/product id on Linux", () => {
  const rule = withPlatform("linux", () =>
    buildUdevRule({ vendorId: 0xfeed, productId: 0x400d } as NodeHidDeviceInfo)
  );
  assert.equal(rule, `SUBSYSTEM=="hidraw", KERNELS=="*:FEED:400D.*", MODE="0666"`);
});

test("pads short vendor/product ids to 4 hex digits", () => {
  const rule = withPlatform("linux", () =>
    buildUdevRule({ vendorId: 0x1, productId: 0x2 } as NodeHidDeviceInfo)
  );
  assert.equal(rule, `SUBSYSTEM=="hidraw", KERNELS=="*:0001:0002.*", MODE="0666"`);
});

test("returns undefined outside Linux", () => {
  for (const platform of ["darwin", "win32"] as const) {
    const rule = withPlatform(platform, () =>
      buildUdevRule({ vendorId: 0xfeed, productId: 0x400d } as NodeHidDeviceInfo)
    );
    assert.equal(rule, undefined);
  }
});

test("returns undefined when the device has no vendor/product id", () => {
  const rule = withPlatform("linux", () =>
    buildUdevRule({ vendorId: undefined, productId: undefined } as unknown as NodeHidDeviceInfo)
  );
  assert.equal(rule, undefined);
});
