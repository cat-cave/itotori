import { lstatSync, writeFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { behaviorCells } from "./behavior-cell-registry.mjs";
import { validateFixedSuccessMutationArtifact } from "./behavior-fixed-success-mutation-contract.mjs";

const FIXED_SUCCESS_MUTATION_MANIFEST_SCHEMA = "itotori.behavior-fixed-success-mutations.v1";
const registeredCells = new Set(behaviorCells.map(({ cell }) => cell));

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function existingDirectory(path, label) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    throw new Error(`${label}-missing`);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${label}-type-invalid`);
}

function existingFile(path, label) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    throw new Error(`${label}-missing`);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label}-type-invalid`);
}

function isDescendant(root, target) {
  const path = relative(root, target);
  return (
    path.length > 0 && path !== ".." && !path.startsWith(`..${sep}`) && !path.startsWith("../")
  );
}

function validPreparedMutation(value, workRoot, cell) {
  if (
    !isRecord(value) ||
    typeof value.mutationRoot !== "string" ||
    typeof value.mutationArtifactPath !== "string"
  ) {
    throw new Error(`registered-cell-mutation-preparation-invalid:${cell}`);
  }
  const mutationRoot = resolve(value.mutationRoot);
  const mutationArtifactPath = resolve(value.mutationArtifactPath);
  if (!isDescendant(workRoot, mutationRoot)) {
    throw new Error(`registered-cell-mutation-root-escapes-work-root:${cell}`);
  }
  if (!isDescendant(mutationRoot, mutationArtifactPath)) {
    throw new Error(`registered-cell-mutation-artifact-escapes-root:${cell}`);
  }
  existingDirectory(mutationRoot, "registered-cell-mutation-root");
  existingFile(mutationArtifactPath, "registered-cell-mutation-artifact");
  validateFixedSuccessMutationArtifact(mutationArtifactPath, cell);
  return { cell, mutationArtifactPath };
}

export async function validateCompiledRegisteredCellDrivers(glueRoot, cells = behaviorCells) {
  if (typeof glueRoot !== "string" || glueRoot.length === 0) {
    throw new Error("registered-cell-driver-glue-root-invalid");
  }
  const validated = [];
  for (const { cell, driverModule } of cells) {
    let loaded;
    try {
      loaded = await import(pathToFileURL(resolve(glueRoot, driverModule)).href);
    } catch {
      throw new Error(`registered-cell-driver-module-unavailable:${cell}`);
    }
    if (!isRecord(loaded) || typeof loaded.executeCellStep !== "function") {
      throw new Error(`registered-cell-driver-export-invalid:${cell}`);
    }
    validated.push(cell);
  }
  return validated;
}

export async function prepareFixedSuccessMutations(root, workRoot, cells = behaviorCells) {
  const mutations = [];
  for (const { cell, mutationModule } of cells) {
    let loaded;
    try {
      loaded = await import(new URL(mutationModule, import.meta.url).href);
    } catch {
      throw new Error(`registered-cell-mutation-module-unavailable:${cell}`);
    }
    if (!isRecord(loaded) || typeof loaded.prepareFixedSuccessMutation !== "function") {
      throw new Error(`registered-cell-mutation-export-invalid:${cell}`);
    }
    const prepared = await loaded.prepareFixedSuccessMutation(root, workRoot);
    mutations.push(validPreparedMutation(prepared, workRoot, cell));
  }
  if (new Set(mutations.map(({ cell }) => cell)).size !== cells.length) {
    throw new Error("registered-cell-mutation-preparation-duplicate");
  }
  writeFileSync(
    resolve(workRoot, "fixed-success-mutations.json"),
    `${JSON.stringify(
      {
        schema: FIXED_SUCCESS_MUTATION_MANIFEST_SCHEMA,
        mutations: mutations.toSorted((left, right) => left.cell.localeCompare(right.cell)),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return mutations;
}

export function assertUnimplementedCasesStayExplicit(plan, results) {
  const unimplemented = plan.cases.filter(({ cell }) => !registeredCells.has(cell));
  const unimplementedIds = new Set(unimplemented.map(({ id }) => id));
  const missingExecution = results.filter(({ reasonCodes }) =>
    reasonCodes.includes("missing-execution"),
  );
  const resultsByCaseId = new Map(results.map((result) => [result.caseId, result]));
  const allUnimplementedAreExplicit = unimplemented.every(({ id }) => {
    const result = resultsByCaseId.get(id);
    return (
      result?.status === "fail" &&
      result.reasonCodes.includes("missing-execution") &&
      result.assertionCount === 0 &&
      result.observationCount === 0
    );
  });
  const noRegisteredCaseUsesMissingExecution = missingExecution.every(({ caseId }) =>
    unimplementedIds.has(caseId),
  );
  if (
    missingExecution.length !== unimplemented.length ||
    !allUnimplementedAreExplicit ||
    !noRegisteredCaseUsesMissingExecution
  ) {
    throw new Error(
      `unexpected-unimplemented-case-count:${missingExecution.length}/${unimplemented.length}`,
    );
  }
  return { expected: unimplemented.length, observed: missingExecution.length };
}
