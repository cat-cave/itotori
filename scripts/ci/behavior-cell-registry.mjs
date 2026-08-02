const CELL = /^cell::[a-z0-9]+(?:[.-][a-z0-9]+)*::[a-z0-9]+(?:[.-][a-z0-9]+)*$/u;
const BEHAVIOR = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u;
const LANE = /^[a-z0-9][a-z0-9-]*$/u;
const DRIVER_MODULE = /^drivers\/behavior-cells\/[a-z0-9-]+\.js$/u;
const MUTATION_MODULE = /^\.\/behavior-proof-[a-z0-9-]+-mutation\.mjs$/u;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredText(value, label, pattern) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`behavior-cell-registry-${label}-invalid`);
  }
  return value;
}

function validatePortableEvidence(value, cell) {
  if (!isRecord(value)) throw new Error(`behavior-cell-registry-portable-evidence-invalid:${cell}`);
  if (!Number.isInteger(value.expectedCaseCount) || value.expectedCaseCount < 1) {
    throw new Error(`behavior-cell-registry-portable-evidence-count-invalid:${cell}`);
  }
  return Object.freeze({ expectedCaseCount: value.expectedCaseCount });
}

export function validateBehaviorCells(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("behavior-cell-registry-empty-or-invalid");
  }
  const cells = new Set();
  const normalized = [];
  let portableEvidenceCount = 0;
  for (const [index, entry] of value.entries()) {
    if (!isRecord(entry)) throw new Error(`behavior-cell-registry-entry-invalid:${index}`);
    const cell = requiredText(entry.cell, `cell-${index}`, CELL);
    const behavior = requiredText(entry.behavior, `behavior-${index}`, BEHAVIOR);
    const lane = requiredText(entry.lane, `lane-${index}`, LANE);
    const driverModule = requiredText(entry.driverModule, `driver-module-${index}`, DRIVER_MODULE);
    const mutationModule = requiredText(
      entry.mutationModule,
      `mutation-module-${index}`,
      MUTATION_MODULE,
    );
    if (!cell.startsWith(`cell::${behavior}::`)) {
      throw new Error(`behavior-cell-registry-identity-mismatch:${cell}`);
    }
    if (cells.has(cell)) throw new Error(`behavior-cell-registry-duplicate-cell:${cell}`);
    cells.add(cell);
    const portableEvidence =
      entry.portableEvidence === undefined
        ? undefined
        : validatePortableEvidence(entry.portableEvidence, cell);
    if (portableEvidence !== undefined) portableEvidenceCount += 1;
    normalized.push(
      Object.freeze({
        cell,
        behavior,
        lane,
        driverModule,
        mutationModule,
        ...(portableEvidence === undefined ? {} : { portableEvidence }),
      }),
    );
  }
  if (portableEvidenceCount > 1) {
    throw new Error("behavior-cell-registry-portable-evidence-duplicate");
  }
  return normalized;
}

export const behaviorCells = Object.freeze(
  validateBehaviorCells([
    {
      cell: "cell::platform.artifacts-are-immutable-and-retained-by-policy::all",
      behavior: "platform.artifacts-are-immutable-and-retained-by-policy",
      lane: "public-ts",
      driverModule: "drivers/behavior-cells/immutable-artifact.js",
      mutationModule: "./behavior-proof-artifact-mutation.mjs",
    },
    {
      cell: "cell::platform.public-formats-upgrade-predictably::all",
      behavior: "platform.public-formats-upgrade-predictably",
      lane: "public-ts",
      driverModule: "drivers/behavior-cells/public-format.js",
      mutationModule: "./behavior-proof-public-format-mutation.mjs",
    },
    {
      cell: "cell::quality.evidence-is-traceable-and-portable::all",
      behavior: "quality.evidence-is-traceable-and-portable",
      lane: "public-ts",
      driverModule: "drivers/behavior-cells/portable-evidence.js",
      mutationModule: "./behavior-proof-portable-evidence-mutation.mjs",
      portableEvidence: { expectedCaseCount: 8 },
    },
    {
      cell: "cell::quality.failures-stay-explicit::all",
      behavior: "quality.failures-stay-explicit",
      lane: "public-ts",
      driverModule: "drivers/behavior-cells/explicit-failure.js",
      mutationModule: "./behavior-proof-explicit-failure-mutation.mjs",
    },
  ]),
);
