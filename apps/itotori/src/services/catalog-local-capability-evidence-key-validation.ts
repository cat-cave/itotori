import {
  type CapabilityEvidenceInput as DbCapabilityEvidenceInput,
  capabilityEvidenceLabelValues,
  capabilityLevelValues,
  engineCapabilityEvidenceKindValues,
  engineCapabilityEvidenceSourceValues,
  engineCapabilityEvidenceStatusValues,
} from "@itotori/db";
import {
  type CatalogCapabilityEvidenceStatus,
  type CatalogKeyValidationDiagnosticResult,
  type CatalogKeyValidationFixture,
  type CatalogKeyValidationFixtureRecord,
  type CatalogPublicKeyValidationCapabilityEvidence,
  CatalogLocalCapabilityEvidenceError,
  catalogCapabilityEvidenceInputSchemaVersion,
  catalogPublicRpgMakerMvMzAdapterId,
  catalogRpgMakerMvMzKeyValidationFixtureId,
} from "./catalog-local-capability-evidence-contract.js";
import {
  assertNoForbiddenPublicFixtureEvidenceLeakage,
  sortRecord,
} from "./catalog-local-capability-evidence-validation.js";

const knownKeyValidationFixtureIds = new Set<string>([catalogRpgMakerMvMzKeyValidationFixtureId]);
const knownKeyValidationOutcomes = new Set<CatalogKeyValidationDiagnosticResult>([
  "success",
  "missing_key",
  "bad_key",
  "unsupported_suffix",
]);

export function mapKeyValidationFixtureToCapabilityEvidence(
  fixture: CatalogKeyValidationFixture,
): CatalogPublicKeyValidationCapabilityEvidence {
  assertKnownKeyValidationFixture(fixture);

  const evidence: CatalogPublicKeyValidationCapabilityEvidence = {
    schemaVersion: catalogCapabilityEvidenceInputSchemaVersion,
    adapterId: catalogPublicRpgMakerMvMzAdapterId,
    level: capabilityLevelValues.extract,
    evidenceSource: "public_fixture",
    evidenceKind: "key_validation",
    fixtureId: fixture.fixtureId,
    status: keyValidationEvidenceStatus(fixture),
    aggregateCounts: keyValidationAggregateCounts(fixture.records),
    evidenceLabels: [capabilityEvidenceLabelValues.publicFixtureKeyValidation],
    limitations: [
      "public fixture key-validation runtime evidence; validates fixture-safe MV/MZ key evidence against System metadata and encrypted image evidence only",
      "key validation does not decrypt, extract, replace, or patch encrypted media",
    ],
  };

  assertNoForbiddenPublicFixtureEvidenceLeakage(evidence, "keyValidationEvidence");
  return evidence;
}

export function mapPublicKeyValidationEvidenceToDbInput(
  evidence: CatalogPublicKeyValidationCapabilityEvidence,
): DbCapabilityEvidenceInput {
  if (
    evidence.adapterId !== catalogPublicRpgMakerMvMzAdapterId ||
    evidence.evidenceSource !== "public_fixture" ||
    evidence.evidenceKind !== "key_validation"
  ) {
    throw new CatalogLocalCapabilityEvidenceError(
      "only public_fixture key_validation MV/MZ evidence can be persisted by this mapper",
    );
  }

  return {
    adapterId: evidence.adapterId,
    level: evidence.level,
    evidenceSource: engineCapabilityEvidenceSourceValues.publicFixture,
    evidenceKind: engineCapabilityEvidenceKindValues.keyValidation,
    schemaVersion: evidence.schemaVersion,
    status: dbEvidenceStatus(evidence.status),
    aggregateCounts: evidence.aggregateCounts,
    evidenceLabels: [capabilityEvidenceLabelValues.publicFixtureKeyValidation],
    limitations: evidence.limitations,
    publicFixtureId: evidence.fixtureId,
  };
}

function assertKnownKeyValidationFixture(
  fixture: CatalogKeyValidationFixture,
): asserts fixture is CatalogKeyValidationFixture {
  if (fixture === null || typeof fixture !== "object" || Array.isArray(fixture)) {
    throw new CatalogLocalCapabilityEvidenceError("key validation fixture must be an object");
  }
  if (
    typeof fixture.fixtureId !== "string" ||
    !knownKeyValidationFixtureIds.has(fixture.fixtureId)
  ) {
    throw new CatalogLocalCapabilityEvidenceError("unsupported key validation fixtureId");
  }
  if (typeof fixture.schemaVersion !== "string" || fixture.schemaVersion.trim().length === 0) {
    throw new CatalogLocalCapabilityEvidenceError(
      "key validation fixture schemaVersion must be a non-empty string",
    );
  }
  if (fixture.status !== "passed" && fixture.status !== "failed") {
    throw new CatalogLocalCapabilityEvidenceError("unsupported key validation fixture status");
  }
  if (!Array.isArray(fixture.records) || fixture.records.length === 0) {
    throw new CatalogLocalCapabilityEvidenceError(
      "key validation fixture must carry at least one record",
    );
  }
  fixture.records.forEach((record, index) => {
    if (record === null || typeof record !== "object" || Array.isArray(record)) {
      throw new CatalogLocalCapabilityEvidenceError(
        `key validation record ${index} must be an object`,
      );
    }
    if (!knownKeyValidationOutcomes.has(record.diagnosticResult)) {
      throw new CatalogLocalCapabilityEvidenceError(
        `key validation record ${index} has an unsupported diagnosticResult`,
      );
    }
  });
}

function keyValidationEvidenceStatus(
  fixture: CatalogKeyValidationFixture,
): CatalogCapabilityEvidenceStatus {
  if (fixture.status !== "passed") {
    return "missing";
  }
  const successes = fixture.records.filter(
    (record) => record.diagnosticResult === "success",
  ).length;
  if (successes === fixture.records.length) {
    return "present";
  }
  if (successes > 0) {
    return "partial";
  }
  return "missing";
}

function keyValidationAggregateCounts(
  records: CatalogKeyValidationFixtureRecord[],
): Record<string, number> {
  const counts: Record<string, number> = { key_validation_records: records.length };
  for (const outcome of knownKeyValidationOutcomes) {
    const total = records.filter((record) => record.diagnosticResult === outcome).length;
    if (total > 0) {
      counts[`key_validation_${outcome}`] = total;
    }
  }
  return sortRecord(counts);
}

function dbEvidenceStatus(
  status: CatalogCapabilityEvidenceStatus,
): DbCapabilityEvidenceInput["status"] {
  switch (status) {
    case "present":
      return engineCapabilityEvidenceStatusValues.present;
    case "partial":
      return engineCapabilityEvidenceStatusValues.partial;
    case "missing":
      return engineCapabilityEvidenceStatusValues.missing;
    case "unknown":
      return engineCapabilityEvidenceStatusValues.unknown;
  }
}
