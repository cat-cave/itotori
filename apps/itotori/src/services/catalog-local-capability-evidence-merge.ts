import { type AdapterCapabilityMatrixRecord, capabilityLevelValues } from "@itotori/db";
import {
  type CatalogCapabilityEvidenceMergeInput,
  type CatalogCapabilityEvidenceReadiness,
  type CatalogPublicFixtureCapabilityEvidence,
  type CatalogCapabilityEvidenceStatus,
  CatalogLocalCapabilityEvidenceError,
  catalogCapabilityEvidenceInputSchemaVersion,
  catalogCapabilityEvidenceMergeFixtureSchemaVersion,
  catalogCapabilityEvidenceReadinessSchemaVersion,
  catalogPublicRpgMakerMvMzAdapterId,
} from "./catalog-local-capability-evidence-contract.js";
import { mapLocalEngineEvidenceToCapabilityEvidence } from "./catalog-local-capability-evidence-local.js";
import {
  assertNoForbiddenPublicFixtureEvidenceLeakage,
  assertPublicNonEmptyStringArray,
  assertPublicStringArray,
} from "./catalog-local-capability-evidence-validation.js";

const knownPublicFixtureIds = new Set(["catalog-capability-evidence-mv-mz-public-matrix"]);
const knownPublicEvidenceLabels = new Set(["rpg_maker_mv_mz_public_fixture_matrix"]);
const catalogCapabilityEvidenceStatusValues = new Set<CatalogCapabilityEvidenceStatus>([
  "present",
  "partial",
  "missing",
  "unknown",
]);
const publicFixtureEvidenceKeys = new Set([
  "level",
  "evidenceSource",
  "evidenceKind",
  "status",
  "evidenceLabels",
  "limitations",
]);
const capabilityMatrixLevels = [
  capabilityLevelValues.identify,
  capabilityLevelValues.inventory,
  capabilityLevelValues.extract,
  capabilityLevelValues.patch,
] as const;
const publicMatrixKeys = new Set(["adapterId", ...capabilityMatrixLevels]);
const supportedMatrixStatusKeys = new Set(["kind"]);
const partialMatrixStatusKeys = new Set(["kind", "limitations"]);
const unsupportedMatrixStatusKeys = new Set(["kind", "reason"]);

export function mergeCapabilityEvidenceFixture(
  input: CatalogCapabilityEvidenceMergeInput,
): CatalogCapabilityEvidenceReadiness {
  if (input.schemaVersion !== catalogCapabilityEvidenceMergeFixtureSchemaVersion) {
    throw new CatalogLocalCapabilityEvidenceError(
      `unsupported merge fixture schemaVersion ${input.schemaVersion}`,
    );
  }

  const publicMatrix = publicMatrixForMerge(input.publicFixture.matrix);
  const privateLocalAggregate = input.privateLocalAggregate?.localEngineEvidence
    ? mapLocalEngineEvidenceToCapabilityEvidence(input.privateLocalAggregate.localEngineEvidence)
    : [];
  const publicFixture = publicFixtureEvidenceForMerge(input);

  return {
    schemaVersion: catalogCapabilityEvidenceReadinessSchemaVersion,
    adapterId: publicMatrix.adapterId,
    matrix: publicMatrix,
    supportEvidence: {
      publicFixture,
      privateLocalAggregate,
    },
  };
}

function publicMatrixForMerge(matrix: unknown): AdapterCapabilityMatrixRecord {
  if (matrix === null || typeof matrix !== "object" || Array.isArray(matrix)) {
    throw new CatalogLocalCapabilityEvidenceError("publicFixture.matrix must be an object");
  }
  for (const key of Object.keys(matrix)) {
    if (!publicMatrixKeys.has(key)) {
      throw new CatalogLocalCapabilityEvidenceError(
        `publicFixture.matrix.${key} is not allowed in public fixture matrix`,
      );
    }
  }

  const record = matrix as Partial<AdapterCapabilityMatrixRecord>;
  if (record.adapterId !== catalogPublicRpgMakerMvMzAdapterId) {
    throw new CatalogLocalCapabilityEvidenceError(
      `public matrix adapterId must be ${catalogPublicRpgMakerMvMzAdapterId}`,
    );
  }

  return {
    adapterId: record.adapterId,
    identify: publicMatrixStatusForMerge(record.identify, "publicFixture.matrix.identify"),
    inventory: publicMatrixStatusForMerge(record.inventory, "publicFixture.matrix.inventory"),
    extract: publicMatrixStatusForMerge(record.extract, "publicFixture.matrix.extract"),
    patch: publicMatrixStatusForMerge(record.patch, "publicFixture.matrix.patch"),
  };
}

function publicMatrixStatusForMerge(
  status: unknown,
  path: string,
): AdapterCapabilityMatrixRecord["identify"] {
  if (status === null || typeof status !== "object" || Array.isArray(status)) {
    throw new CatalogLocalCapabilityEvidenceError(`${path} must be an object`);
  }
  const record = status as Record<string, unknown>;
  switch (record.kind) {
    case "supported":
      assertOnlyPublicMatrixStatusKeys(record, supportedMatrixStatusKeys, path);
      return { kind: "supported" };
    case "partial": {
      assertOnlyPublicMatrixStatusKeys(record, partialMatrixStatusKeys, path);
      assertPublicNonEmptyStringArray(record.limitations, `${path}.limitations`);
      assertNoForbiddenPublicFixtureEvidenceLeakage(record.limitations, `${path}.limitations`);
      return { kind: "partial", limitations: [...record.limitations] };
    }
    case "unsupported":
      assertOnlyPublicMatrixStatusKeys(record, unsupportedMatrixStatusKeys, path);
      if (typeof record.reason !== "string" || record.reason.trim().length === 0) {
        throw new CatalogLocalCapabilityEvidenceError(`${path}.reason must be a non-empty string`);
      }
      assertNoForbiddenPublicFixtureEvidenceLeakage(record.reason, `${path}.reason`);
      return { kind: "unsupported", reason: record.reason };
    default:
      throw new CatalogLocalCapabilityEvidenceError(
        `${path}.kind must be supported, partial, or unsupported`,
      );
  }
}

function assertOnlyPublicMatrixStatusKeys(
  record: Record<string, unknown>,
  allowlist: Set<string>,
  path: string,
): void {
  for (const key of Object.keys(record)) {
    if (!allowlist.has(key)) {
      throw new CatalogLocalCapabilityEvidenceError(
        `${path}.${key} is not allowed in public fixture matrix status`,
      );
    }
  }
}

function publicFixtureEvidenceForMerge(
  input: CatalogCapabilityEvidenceMergeInput,
): CatalogPublicFixtureCapabilityEvidence[] {
  assertKnownPublicFixtureId(input.publicFixture.fixtureId);
  assertNoForbiddenPublicFixtureEvidenceLeakage(
    input.publicFixture.fixtureId,
    "publicFixture.fixtureId",
  );
  if (!Array.isArray(input.publicFixture.evidence)) {
    throw new CatalogLocalCapabilityEvidenceError("public fixture evidence must be an array");
  }

  return input.publicFixture.evidence.map((evidence, index) => {
    assertPublicFixtureEvidenceRow(evidence, index);
    return {
      schemaVersion: catalogCapabilityEvidenceInputSchemaVersion,
      adapterId: input.publicFixture.matrix.adapterId,
      level: evidence.level,
      evidenceSource: "public_fixture",
      evidenceKind: "adapter_matrix",
      fixtureId: input.publicFixture.fixtureId,
      status: evidence.status,
      evidenceLabels: [...evidence.evidenceLabels],
      limitations: [...evidence.limitations],
    };
  });
}

function assertKnownPublicFixtureId(fixtureId: unknown): asserts fixtureId is string {
  if (typeof fixtureId !== "string" || !knownPublicFixtureIds.has(fixtureId)) {
    throw new CatalogLocalCapabilityEvidenceError("unsupported public fixtureId");
  }
}

function assertPublicFixtureEvidenceRow(
  evidence: unknown,
  index: number,
): asserts evidence is Omit<
  CatalogPublicFixtureCapabilityEvidence,
  "schemaVersion" | "adapterId" | "fixtureId"
> {
  const path = `publicFixture.evidence.${index}`;
  if (evidence === null || typeof evidence !== "object" || Array.isArray(evidence)) {
    throw new CatalogLocalCapabilityEvidenceError(`${path} must be an object`);
  }
  for (const key of Object.keys(evidence)) {
    if (!publicFixtureEvidenceKeys.has(key)) {
      throw new CatalogLocalCapabilityEvidenceError(
        `${path}.${key} is not allowed in public fixture evidence`,
      );
    }
  }

  const row = evidence as Partial<CatalogPublicFixtureCapabilityEvidence>;
  if (row.level !== capabilityLevelValues.identify) {
    throw new CatalogLocalCapabilityEvidenceError(`${path}.level is not supported`);
  }
  if (row.evidenceSource !== "public_fixture") {
    throw new CatalogLocalCapabilityEvidenceError(`${path}.evidenceSource is not supported`);
  }
  if (row.evidenceKind !== "adapter_matrix") {
    throw new CatalogLocalCapabilityEvidenceError(`${path}.evidenceKind is not supported`);
  }
  if (!catalogCapabilityEvidenceStatusValues.has(row.status as CatalogCapabilityEvidenceStatus)) {
    throw new CatalogLocalCapabilityEvidenceError(`${path}.status is not supported`);
  }
  assertKnownLabels(
    row.evidenceLabels as string[],
    knownPublicEvidenceLabels,
    `${path}.evidenceLabels`,
  );
  assertPublicStringArray(row.limitations, `${path}.limitations`);
  assertNoForbiddenPublicFixtureEvidenceLeakage(row, path);
}

function assertKnownLabels(labels: string[], allowlist: Set<string>, field: string): void {
  if (!Array.isArray(labels)) {
    throw new CatalogLocalCapabilityEvidenceError(`${field} must be an array`);
  }
  for (const label of labels) {
    if (!allowlist.has(label)) {
      throw new CatalogLocalCapabilityEvidenceError(`${field} contains unsupported label ${label}`);
    }
  }
}
