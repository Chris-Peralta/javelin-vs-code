import test from "node:test";
import assert from "node:assert/strict";
import { nextOverrideAction } from "../src/editorSettingOverrides";

test("nextOverrideAction", async (t) => {
  await t.test("writes the desired value when it differs from the current editor value", () => {
    assert.deepEqual(nextOverrideAction(14, 0, 0, undefined), { kind: "write", value: 14 });
  });

  await t.test("does nothing when the desired value already matches the editor value", () => {
    assert.deepEqual(nextOverrideAction(14, 0, 14, undefined), { kind: "none" });
  });

  await t.test("does nothing when the desired value is unset and nothing was previously pushed", () => {
    assert.deepEqual(nextOverrideAction(0, 0, 0, undefined), { kind: "none" });
  });

  await t.test("clears the override when desired reverts to unset and we still own the current value", () => {
    assert.deepEqual(nextOverrideAction(0, 0, 14, 14), { kind: "clear" });
  });

  await t.test("leaves a manual edit alone when desired reverts to unset but the editor value no longer matches what we pushed", () => {
    assert.deepEqual(nextOverrideAction(0, 0, 20, 14), { kind: "none" });
  });

  await t.test("re-writes when desired changes to a new non-unset value even if we previously pushed a different one", () => {
    assert.deepEqual(nextOverrideAction(16, 0, 14, 14), { kind: "write", value: 16 });
  });

  await t.test("works with string settings like occurrencesHighlight", () => {
    assert.deepEqual(nextOverrideAction("off", "inherit", "singleFile", undefined), {
      kind: "write",
      value: "off",
    });
    assert.deepEqual(nextOverrideAction("inherit", "inherit", "off", "off"), { kind: "clear" });
  });
});
