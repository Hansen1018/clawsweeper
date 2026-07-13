import assert from "node:assert/strict";
import test from "node:test";

import { readText } from "../helpers.ts";

test("publish-main receipts the durable Git push only when explicitly requested", () => {
  const source = readText("src/repair/publish-main.ts");

  assert.match(source, /if \(args\.receiptKind\)/);
  assert.match(source, /runRepairMutation\(/);
  assert.match(source, /operationName: "state_publication"/);
  assert.match(source, /operation: \(\) => publishMainCommit\(publishOptions\)/);
  assert.match(source, /result === "committed" \? "accepted" : "rejected"/);
  assert.match(source, /--receipt-kind/);
});
