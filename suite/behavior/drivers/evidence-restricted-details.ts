import { readFileSync } from "node:fs";

import { digest, isRecord, type RestrictedEvidenceReceipt } from "./evidence-contract.js";
import { portableFile } from "./evidence-portability.js";

const FIELDS = ["producer", "sourceRevision", "inputHash", "outputHash", "privacyClass", "outcome"];

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).toSorted();
  const sorted = [...expected].toSorted();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function restrictedDetailsAreValid(
  bundleRoot: string,
  record: RestrictedEvidenceReceipt,
): boolean {
  const artifact = portableFile(bundleRoot, record.reference);
  const censusPath = portableFile(bundleRoot, record.censusReference);
  if (
    artifact === null ||
    censusPath === null ||
    !record.reference.startsWith("private-artifacts/") ||
    !record.censusReference.startsWith("census/") ||
    !/^[a-f0-9]{64}$/u.test(record.sourceRevision) ||
    record.inputHash !== record.sourceRevision ||
    record.lineage !== digest(`itotori.evidence-lineage.v2\0${record.sourceRevision}`) ||
    record.outputHash !== digest(readFileSync(artifact)) ||
    record.safe !== (record.scanClasses.length === 0) ||
    record.outcome !== "local-private-facts-verified"
  ) {
    return false;
  }
  let census: unknown;
  try {
    census = JSON.parse(readFileSync(censusPath, "utf8"));
  } catch {
    return false;
  }
  if (
    !isRecord(census) ||
    !exactKeys(census, [
      "schema",
      "sourceHash",
      "currentHash",
      "anchorHash",
      "alternateHash",
      "unaffectedSourceHash",
      "artifactHash",
      "repeatedArtifactHash",
      "alternateArtifactHash",
      "unaffectedArtifactHash",
      "repeatedUnaffectedArtifactHash",
      "localChecks",
      "fields",
    ]) ||
    census.schema !== "itotori.ephemeral-private-evidence-census.v1" ||
    census.sourceHash !== record.sourceRevision ||
    census.artifactHash !== record.outputHash ||
    !Array.isArray(census.fields) ||
    census.fields.length !== FIELDS.length
  ) {
    return false;
  }
  for (const field of [
    "sourceHash",
    "currentHash",
    "anchorHash",
    "alternateHash",
    "unaffectedSourceHash",
    "artifactHash",
    "repeatedArtifactHash",
    "alternateArtifactHash",
    "unaffectedArtifactHash",
    "repeatedUnaffectedArtifactHash",
  ]) {
    if (typeof census[field] !== "string" || !/^[a-f0-9]{64}$/u.test(census[field])) return false;
  }
  const recomputedChecks = {
    sourceMatchesCurrent: census.sourceHash === census.currentHash,
    sourceMatchesPairAnchor: census.sourceHash === census.anchorHash,
    sourceSafe: record.scanClasses.length === 0,
    deterministicRepeat: census.artifactHash === census.repeatedArtifactHash,
    changedDependent:
      census.sourceHash !== census.alternateHash &&
      census.artifactHash !== census.alternateArtifactHash,
    unaffectedStable: census.unaffectedArtifactHash === census.repeatedUnaffectedArtifactHash,
  };
  if (!sameJson(recomputedChecks, record.localChecks)) return false;
  return census.fields.every(
    (field, index) =>
      isRecord(field) &&
      exactKeys(field, ["field", "nonemptyCount", "totalCount"]) &&
      field.field === FIELDS[index] &&
      field.nonemptyCount === 1 &&
      field.totalCount === 1,
  );
}
