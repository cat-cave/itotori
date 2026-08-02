import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import {
  assertUnimplementedCasesStayExplicit,
  prepareFixedSuccessMutations,
  validateCompiledRegisteredCellDrivers,
} from "./behavior-cell-execution.mjs";
import {
  BEHAVIOR_CELL_CAPSULE_ROOT,
  behaviorCells,
  capsuleDirectoryName,
  discoverBehaviorCells,
  validateBehaviorCells,
} from "./behavior-cell-registry.mjs";

const CAPSULE_SCHEMA = "itotori.behavior-proof-capsule.v1";

test("current proof capsules are valid, immutable, and canonically ordered", () => {
  assert.ok(behaviorCells.length > 0);
  assert.ok(Object.isFrozen(behaviorCells));
  assert.ok(behaviorCells.every((entry) => Object.isFrozen(entry)));
  assert.ok(
    behaviorCells
      .filter(({ portableEvidence }) => portableEvidence !== undefined)
      .every(({ portableEvidence }) => Object.isFrozen(portableEvidence)),
  );
  assert.deepEqual(
    behaviorCells.map(({ cell }) => cell),
    behaviorCells.map(({ cell }) => cell).toSorted(),
  );
  assert.equal(validateBehaviorCells(behaviorCells).length, behaviorCells.length);
});

test("registry validation rejects missing mutation metadata", () => {
  assert.throws(
    () => validateBehaviorCells([{ ...behaviorCells[0], mutationModule: undefined }]),
    /behavior-cell-registry-mutation-module-0-invalid/u,
  );
});

test("registry validation rejects duplicate identities", () => {
  assert.throws(
    () => validateBehaviorCells([behaviorCells[0], { ...behaviorCells[0] }]),
    /behavior-cell-registry-duplicate-cell/u,
  );
});

test("registry validation rejects invalid portable-evidence metadata", () => {
  const portableEntry = behaviorCells.find(
    ({ portableEvidence }) => portableEvidence !== undefined,
  );
  assert.ok(portableEntry);
  assert.throws(
    () => validateBehaviorCells([{ ...portableEntry, portableEvidence: { expectedCaseCount: 0 } }]),
    /behavior-cell-registry-portable-evidence-count-invalid/u,
  );
});

test("capsule discovery explicitly sorts directories into canonical cell order", async () => {
  await withTemporaryRoot(async (root) => {
    const later = writeCapsule(root, { behavior: "domain.zeta" });
    const earlier = writeCapsule(root, { behavior: "domain.alpha" });

    const discovered = await discoverBehaviorCells(root);
    assert.deepEqual(
      discovered.map(({ cell }) => cell),
      [earlier.cell, later.cell],
    );
    assert.ok(Object.isFrozen(discovered));
  });
});

test("duplicate identities across separately discovered capsules fail loudly", async () => {
  await withTemporaryRoot(async (root) => {
    writeCapsule(root, { behavior: "domain.alpha" });
    writeCapsule(root, { behavior: "domain.alpha", directory: "duplicate-capsule" });

    await assert.rejects(
      discoverBehaviorCells(root),
      /behavior-cell-registry-duplicate-cell:cell::domain\.alpha::all/u,
    );
  });
});

test("a declared identity that disagrees with its capsule location fails loudly", async () => {
  await withTemporaryRoot(async (root) => {
    writeCapsule(root, { behavior: "domain.correct", directory: "domain.wrong--all" });

    await assert.rejects(
      discoverBehaviorCells(root),
      /behavior-cell-capsule-location-mismatch:cell::domain\.correct::all/u,
    );
  });
});

test("a declared identity that disagrees with mutation-module contents fails loudly", async () => {
  await withTemporaryRoot(async (root) => {
    writeCapsule(root, {
      behavior: "domain.alpha",
      mutationSource:
        'export const cell = "cell::domain.other::all";\nexport function prepareFixedSuccessMutation() {}\n',
    });

    await assert.rejects(
      discoverBehaviorCells(root),
      /behavior-cell-capsule-mutation-identity-mismatch:cell::domain\.alpha::all/u,
    );
  });
});

test("a missing mutation module fails loudly during capsule discovery", async () => {
  await withTemporaryRoot(async (root) => {
    writeCapsule(root, { behavior: "domain.alpha", omitMutation: true });

    await assert.rejects(
      discoverBehaviorCells(root),
      /behavior-cell-capsule-mutation:domain\.alpha--all-missing/u,
    );
  });
});

test("a non-functioning mutation module fails loudly during capsule discovery", async () => {
  await withTemporaryRoot(async (root) => {
    const cell = cellFor("domain.alpha");
    writeCapsule(root, {
      behavior: "domain.alpha",
      mutationSource: `export const cell = ${JSON.stringify(cell)};\n`,
    });

    await assert.rejects(
      discoverBehaviorCells(root),
      /behavior-cell-capsule-mutation-export-invalid:cell::domain\.alpha::all/u,
    );
  });
});

test("a malformed or partially written capsule is never ignored", async () => {
  await withTemporaryRoot(async (root) => {
    const partial = resolve(root, BEHAVIOR_CELL_CAPSULE_ROOT, "partial-capsule");
    mkdirSync(partial, { recursive: true });
    writeFileSync(resolve(partial, "capsule.json"), "{\n", "utf8");

    await assert.rejects(
      discoverBehaviorCells(root),
      /behavior-cell-capsule-manifest-invalid:partial-capsule/u,
    );
  });
});

test("a capsule missing its required driver is never ignored", async () => {
  await withTemporaryRoot(async (root) => {
    writeCapsule(root, { behavior: "domain.alpha", omitDriver: true });

    await assert.rejects(
      discoverBehaviorCells(root),
      /behavior-cell-capsule-driver:domain\.alpha--all-missing/u,
    );
  });
});

test("glob discovery includes a hidden partial capsule", async () => {
  await withTemporaryRoot(async (root) => {
    mkdirSync(resolve(root, BEHAVIOR_CELL_CAPSULE_ROOT, ".partial-capsule"), {
      recursive: true,
    });

    await assert.rejects(
      discoverBehaviorCells(root),
      /behavior-cell-capsule-manifest:\.partial-capsule-missing/u,
    );
  });
});

test("a non-capsule root entry is never filtered out of discovery", async () => {
  await withTemporaryRoot(async (root) => {
    const capsuleRoot = resolve(root, BEHAVIOR_CELL_CAPSULE_ROOT);
    mkdirSync(capsuleRoot, { recursive: true });
    writeFileSync(resolve(capsuleRoot, "partial-capsule"), "incomplete", "utf8");

    await assert.rejects(
      discoverBehaviorCells(root),
      /behavior-cell-capsule-root-entry-invalid:partial-capsule/u,
    );
  });
});

test("mutation preparation retains a second unavailable-module failure boundary", async () => {
  const workRoot = mkdtempSync(join(tmpdir(), "behavior-cell-registry-test-"));
  try {
    await assert.rejects(
      prepareFixedSuccessMutations(process.cwd(), workRoot, [
        {
          ...behaviorCells[0],
          mutationModule: "suite/behavior/capsules/not-a-real-capsule--all/mutation.mjs",
        },
      ]),
      /registered-cell-mutation-module-unavailable/u,
    );
  } finally {
    rmSync(workRoot, { force: true, recursive: true });
  }
});

test("a callable mutation with an unusable preparation still fails closed", async () => {
  await withTemporaryRoot(async (root) => {
    writeCapsule(root, { behavior: "domain.unusable-mutation" });
    const [cell] = await discoverBehaviorCells(root);
    const workRoot = mkdtempSync(join(tmpdir(), "behavior-cell-registry-test-"));
    try {
      await assert.rejects(
        prepareFixedSuccessMutations(root, workRoot, [cell]),
        /registered-cell-mutation-preparation-invalid:cell::domain\.unusable-mutation::all/u,
      );
    } finally {
      rmSync(workRoot, { force: true, recursive: true });
    }
  });
});

test("compiled capsule drivers must export matching executable identities", async () => {
  const validRoot = createCompiledDriverRoot(
    (cell) =>
      `export const cell = ${JSON.stringify(cell)};\nexport const executeCellStep = async () => ({});\n`,
  );
  const invalidRoot = createCompiledDriverRoot(
    (cell) =>
      `export const cell = ${JSON.stringify(cell)};\nexport const executeCellStep = undefined;\n`,
  );
  const mismatchedRoot = createCompiledDriverRoot(
    () =>
      'export const cell = "cell::domain.other::all";\nexport const executeCellStep = async () => ({});\n',
  );
  try {
    assert.deepEqual(
      await validateCompiledRegisteredCellDrivers(validRoot),
      behaviorCells.map(({ cell }) => cell),
    );
    await assert.rejects(
      validateCompiledRegisteredCellDrivers(invalidRoot),
      /registered-cell-driver-export-invalid/u,
    );
    await assert.rejects(
      validateCompiledRegisteredCellDrivers(mismatchedRoot),
      /registered-cell-driver-identity-mismatch/u,
    );
  } finally {
    rmSync(validRoot, { force: true, recursive: true });
    rmSync(invalidRoot, { force: true, recursive: true });
    rmSync(mismatchedRoot, { force: true, recursive: true });
  }
});

test("an undiscovered capsule cell can only remain explicitly red", async () => {
  await withTemporaryRoot(async (root) => {
    writeCapsule(root, { behavior: "domain.unowned" });
    const [undiscovered] = await discoverBehaviorCells(root);
    assert.ok(undiscovered);
    assert.ok(!behaviorCells.some(({ cell }) => cell === undiscovered.cell));
    const plan = { cases: [{ id: "case::domain.unowned", cell: undiscovered.cell }] };
    const red = [
      {
        caseId: "case::domain.unowned",
        status: "fail",
        reasonCodes: ["missing-execution"],
        assertionCount: 0,
        observationCount: 0,
      },
    ];

    assert.deepEqual(assertUnimplementedCasesStayExplicit(plan, red), { expected: 1, observed: 1 });
    assert.throws(
      () =>
        assertUnimplementedCasesStayExplicit(plan, [
          { ...red[0], status: "pass", reasonCodes: [] },
        ]),
      /unexpected-unimplemented-case-count:0\/1/u,
    );
  });
});

async function withTemporaryRoot(run) {
  const root = mkdtempSync(join(tmpdir(), "behavior-cell-capsule-test-"));
  try {
    return await run(root);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

function cellFor(behavior, subject = "all") {
  return `cell::${behavior}::${subject}`;
}

function writeCapsule(root, options = {}) {
  const behavior = options.behavior ?? "domain.synthetic";
  const subject = options.subject ?? "all";
  const cell = options.cell ?? cellFor(behavior, subject);
  const directory = options.directory ?? capsuleDirectoryName(behavior, subject);
  const capsuleRoot = resolve(root, BEHAVIOR_CELL_CAPSULE_ROOT, directory);
  mkdirSync(capsuleRoot, { recursive: true });
  const manifest = options.manifest ?? {
    schema: CAPSULE_SCHEMA,
    cell,
    behavior,
    subject,
    lane: "public-ts",
    driver: "driver.ts",
    mutation: "mutation.mjs",
  };
  if (!options.omitManifest) {
    writeFileSync(
      resolve(capsuleRoot, "capsule.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );
  }
  if (!options.omitDriver) {
    writeFileSync(
      resolve(capsuleRoot, "driver.ts"),
      options.driverSource ??
        `export const cell = ${JSON.stringify(cell)};\nexport const executeCellStep = async () => ({});\n`,
      "utf8",
    );
  }
  if (!options.omitMutation) {
    writeFileSync(
      resolve(capsuleRoot, "mutation.mjs"),
      options.mutationSource ??
        `export const cell = ${JSON.stringify(cell)};\nexport function prepareFixedSuccessMutation() {}\n`,
      "utf8",
    );
  }
  return { cell };
}

function createCompiledDriverRoot(sourceForCell) {
  const root = mkdtempSync(join(tmpdir(), "behavior-cell-driver-test-"));
  writeFileSync(resolve(root, "package.json"), '{"type":"module"}\n', "utf8");
  for (const { cell, driverModule } of behaviorCells) {
    const path = resolve(root, driverModule);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, sourceForCell(cell), "utf8");
  }
  return root;
}
