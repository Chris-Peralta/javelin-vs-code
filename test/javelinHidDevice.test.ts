import test from "node:test";
import assert from "node:assert/strict";
import type { Device as NodeHidDeviceInfo } from "node-hid";
import { buildUdevRule, decodeJavEvent, parseLookupResults, type JavSuggestionEventDetail } from "../src/javelinHidDevice";

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

test("parseLookupResults parses the legacy firmware format", () => {
  const raw = [
    { outline: "KAT", dictionary: "main.json", definition: "cat", can_remove: true },
    { outline: "KAEUT", definition: "cat" },
  ];

  assert.deepEqual(parseLookupResults(raw, "kat"), [
    { outline: "KAT", dictionary: "main.json", translation: "cat", removable: true },
    { outline: "KAEUT", dictionary: null, translation: "cat", removable: false },
  ]);
});

test("parseLookupResults parses the modern firmware format's array response, resolving run-length-encoded dictionary/translation references", () => {
  const raw = [
    { o: "KAT", d: "main.json", t: "cat", r: 1 as const },
    { o: "KAEUT", d: 0 },
  ];

  assert.deepEqual(parseLookupResults(raw, "kat"), [
    { outline: "KAT", dictionary: "main.json", translation: "cat", removable: true },
    { outline: "KAEUT", dictionary: "main.json", translation: "kat", removable: false },
  ]);
});

test("parseLookupResults resolves a run-length-encoded translation back-reference", () => {
  const raw = [
    { o: "KAT", d: "main.json", t: "cat", r: 1 as const },
    { o: "KAEUT", d: 0, t: 0 },
  ];

  assert.deepEqual(parseLookupResults(raw, "kat"), [
    { outline: "KAT", dictionary: "main.json", translation: "cat", removable: true },
    { outline: "KAEUT", dictionary: "main.json", translation: "cat", removable: false },
  ]);
});

test("parseLookupResults wraps a single modern-format result object (newest firmware) in an array", () => {
  const raw = { o: "KAT", d: "main.json", t: "cat", r: 1 as const };

  assert.deepEqual(parseLookupResults(raw, "kat"), [
    { outline: "KAT", dictionary: "main.json", translation: "cat", removable: true },
  ]);
});

test("parseLookupResults returns an empty array for an empty or null response", () => {
  assert.deepEqual(parseLookupResults([], "kat"), []);
  assert.deepEqual(parseLookupResults(null, "kat"), []);
});
