import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const SCHEMA = "itotori.behavior-fixed-success-mutation.v1";
const CELL = /^cell::[a-z0-9]+(?:[.-][a-z0-9]+)*::[a-z0-9]+(?:[.-][a-z0-9]+)*$/u;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function fixedSuccessMutationId(cell) {
  if (typeof cell !== "string" || !CELL.test(cell)) {
    throw new Error("fixed-success-mutation-cell-invalid");
  }
  return `kill::${cell.slice("cell::".length)}`;
}

export function writeFixedSuccessMutationArtifact(mutationRoot, cell) {
  if (typeof mutationRoot !== "string" || mutationRoot.length === 0) {
    throw new Error("fixed-success-mutation-root-invalid");
  }
  mkdirSync(mutationRoot, { recursive: true });
  const mutationArtifactPath = resolve(mutationRoot, "fixed-success-mutation.json");
  writeFileSync(
    mutationArtifactPath,
    `${JSON.stringify(
      {
        schema: SCHEMA,
        cell,
        mutationId: fixedSuccessMutationId(cell),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return mutationArtifactPath;
}

export function validateFixedSuccessMutationArtifact(mutationArtifactPath, cell) {
  if (typeof mutationArtifactPath !== "string" || mutationArtifactPath.length === 0) {
    throw new Error("fixed-success-mutation-artifact-path-invalid");
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(mutationArtifactPath, "utf8"));
  } catch {
    throw new Error(`fixed-success-mutation-artifact-unreadable:${cell}`);
  }
  if (
    !isRecord(parsed) ||
    parsed.schema !== SCHEMA ||
    parsed.cell !== cell ||
    parsed.mutationId !== fixedSuccessMutationId(cell)
  ) {
    throw new Error(`fixed-success-mutation-artifact-invalid:${cell}`);
  }
  return mutationArtifactPath;
}
