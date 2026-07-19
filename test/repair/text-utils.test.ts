import assert from "node:assert/strict";
import test from "node:test";

import { compactText } from "../../dist/repair/text-utils.js";

test("compactText never exceeds maxLength, even for tiny caps", () => {
  for (const n of [0, 1, 2, 3, 5, 16]) {
    assert.ok(
      compactText("hello world this is long", n).length <= n,
      `compactText(..., ${n}) must fit within ${n}`,
    );
  }
  // Regression: maxLength 2 used to return the bare "..." (length 3).
  assert.equal(compactText("hello world", 2), "he");
  assert.equal(compactText("abcdefghijklmnopqrstuvwxyz", 3), "...");
  assert.equal(compactText("abcdefghijklmnopqrstuvwxyz", 4), "a...");
  assert.equal(compactText("abcdefghijklmnopqrstuvwxyz", 16), "abcdefghijklm...");
  assert.equal(compactText("abcdefghijklmnopqrstuvwxyz", 17), "abcdef ... uvwxyz");
});
