import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import {
  prepareFixedSuccessMutations,
  validateCompiledRegisteredCellDrivers,
} from "./behavior-cell-execution.mjs";
import { behaviorCells, validateBehaviorCells } from "./behavior-cell-registry.mjs";

test("current behavior-cell registrations are valid and immutable", () => {
  assert.equal(behaviorCells.length, 4);
  assert.ok(Object.isFrozen(behaviorCells));
  assert.ok(behaviorCells.every((entry) => Object.isFrozen(entry)));
  assert.ok(
    behaviorCells
      .filter(({ portableEvidence }) => portableEvidence !== undefined)
      .every(({ portableEvidence }) => Object.isFrozen(portableEvidence)),
  );
  assert.equal(validateBehaviorCells(behaviorCells).length, behaviorCells.length);
});

test("registry rejects a missing mutation module", () => {
  assert.throws(
    () => validateBehaviorCells([{ ...behaviorCells[0], mutationModule: undefined }]),
    /behavior-cell-registry-mutation-module-0-invalid/u,
  );
});

test("registry rejects a duplicate cell identity", () => {
  assert.throws(
    () => validateBehaviorCells([behaviorCells[0], { ...behaviorCells[0] }]),
    /behavior-cell-registry-duplicate-cell/u,
  );
});

test("registry rejects an invalid portable-evidence capability", () => {
  const portableEntry = behaviorCells.find(
    ({ portableEvidence }) => portableEvidence !== undefined,
  );
  assert.ok(portableEntry);
  assert.throws(
    () => validateBehaviorCells([{ ...portableEntry, portableEvidence: { expectedCaseCount: 0 } }]),
    /behavior-cell-registry-portable-evidence-count-invalid/u,
  );
});

test("mutation preparation rejects an unavailable registered mutation module", async () => {
  const workRoot = mkdtempSync(join(tmpdir(), "behavior-cell-registry-test-"));
  try {
    await assert.rejects(
      prepareFixedSuccessMutations(process.cwd(), workRoot, [
        { ...behaviorCells[0], mutationModule: "./behavior-proof-does-not-exist-mutation.mjs" },
      ]),
      /registered-cell-mutation-module-unavailable/u,
    );
  } finally {
    rmSync(workRoot, { force: true, recursive: true });
  }
});

test("compiled registered drivers must export an executable step function", async () => {
  const validRoot = createCompiledDriverRoot("export const executeCellStep = async () => ({});\n");
  const invalidRoot = createCompiledDriverRoot("export const executeCellStep = undefined;\n");
  try {
    assert.deepEqual(
      await validateCompiledRegisteredCellDrivers(validRoot),
      behaviorCells.map(({ cell }) => cell),
    );
    await assert.rejects(
      validateCompiledRegisteredCellDrivers(invalidRoot),
      /registered-cell-driver-export-invalid/u,
    );
  } finally {
    rmSync(validRoot, { force: true, recursive: true });
    rmSync(invalidRoot, { force: true, recursive: true });
  }
});

function createCompiledDriverRoot(source) {
  const root = mkdtempSync(join(tmpdir(), "behavior-cell-driver-test-"));
  writeFileSync(resolve(root, "package.json"), '{"type":"module"}\n', "utf8");
  for (const { driverModule } of behaviorCells) {
    const path = resolve(root, driverModule);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, source, "utf8");
  }
  return root;
}
