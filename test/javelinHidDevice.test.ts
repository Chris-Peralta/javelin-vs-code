import test from "node:test";
import assert from "node:assert/strict";
import type { Device as NodeHidDeviceInfo } from "node-hid";
import { buildUdevRule, decodeJavEvent, type JavSuggestionEventDetail } from "../src/javelinHidDevice";

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

test("decodes a suggestion event whose outlines field is a bare string as a one-element array", () => {
  const decoded = decodeJavEvent({ e: "s", c: 1, t: "good day", o: "TKPW-D" });
  assert.equal(decoded?.event, "suggestion");

  const detail = decoded?.detail as JavSuggestionEventDetail;
  assert.equal(detail.strokes, 1);
  assert.equal(detail.translation, "good day");
  assert.deepEqual(detail.outlines, ["TKPW-D"]);
});

test("decodes a suggestion event whose outlines field is an array of multiple candidates", () => {
  const decoded = decodeJavEvent({ e: "s", c: 2, t: "this is", o: ["TH-S", "STKHE", "STKH-B"] });

  const detail = decoded?.detail as JavSuggestionEventDetail;
  assert.deepEqual(detail.outlines, ["TH-S", "STKHE", "STKH-B"]);
});

test("decodes a suggestion event with a null outlines field as an empty array", () => {
  const decoded = decodeJavEvent({ e: "s", c: 1, t: "word", o: null });

  const detail = decoded?.detail as JavSuggestionEventDetail;
  assert.deepEqual(detail.outlines, []);
});

test("decodes a suggestion event using legacy field names", () => {
  const decoded = decodeJavEvent({ e: "suggestion", combine_count: 2, text: "good day", outlines: "TKPW-D" });
  assert.equal(decoded?.event, "suggestion");

  const detail = decoded?.detail as JavSuggestionEventDetail;
  assert.equal(detail.strokes, 2);
  assert.equal(detail.translation, "good day");
  assert.deepEqual(detail.outlines, ["TKPW-D"]);
});
