import assert from "node:assert/strict";
import test from "node:test";

import { REQUIRED_NODE_REFS, runChecklist } from "./alpha-readiness-checklist.mjs";

const nodeId = (prefix, number) => `${prefix}-${String(number).padStart(3, "0")}`;

test("validates every canonical evidence reference against the DAG", () => {
  const expected = [
    nodeId("KAIFUU", 42),
    "ALPHA-006",
    "ALPHA-007",
    "ALPHA-008",
    nodeId("ITOTORI", 116),
    nodeId("ITOTORI", 117),
    nodeId("UTSUSHI", 119),
    "SHARED-025",
    "UNIV-013",
    "SHARED-013",
    "SHARED-014",
    "UNIV-021",
  ];
  assert.deepEqual(REQUIRED_NODE_REFS, expected);

  const nodeFindings = runChecklist().findings.filter((finding) => finding.check === "node-ref");
  assert.equal(nodeFindings.length, expected.length);
  assert.deepEqual(
    nodeFindings.map((finding) => finding.message.match(/^(.+?) resolves/u)?.[1]),
    expected,
  );
  assert.ok(nodeFindings.every((finding) => finding.severity === "info"));
});
