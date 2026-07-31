import { lstatSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { expectedFragmentFileNames } from "./behavior-proof-fragments.mjs";

const lexical = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

function exactDirectory(path, expectedNames, label) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    throw new Error(`${label}-missing:${path}`);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory())
    throw new Error(`${label}-type-invalid:${path}`);
  const actual = readdirSync(path).toSorted(lexical);
  const expected = [...expectedNames].toSorted(lexical);
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
    throw new Error(`${label}-layout-mismatch`);
  }
}

export function verifyArtifactLayout(location, plan, mutantPlan) {
  exactDirectory(
    location.directory,
    [
      "case-results.json",
      "cell-report.json",
      "cell-report.junit.xml",
      "cucumber",
      "evidence",
      "mutation",
      "mutations.json",
      "receipts",
      "selection-plan.json",
      "summary.txt",
    ],
    "behavior-proof-root",
  );
  exactDirectory(
    resolve(location.directory, "cucumber"),
    expectedFragmentFileNames(plan),
    "behavior-proof-cucumber",
  );
  exactDirectory(
    resolve(location.directory, "mutation"),
    [
      "case-results.json",
      "fixed-success-cell-report.json",
      "fixed-success-cell-report.junit.xml",
      "fixed-success-selection-plan.json",
      "fixed-success-summary.txt",
      ...expectedFragmentFileNames(mutantPlan, "mutation"),
    ],
    "behavior-proof-mutation",
  );
  exactDirectory(
    resolve(location.directory, "receipts"),
    ["root-cells.json"],
    "behavior-proof-receipts",
  );
}
