import type { AdapterCapabilityMatrixRecord, CapabilityLevel } from "@itotori/db";
import type { CatalogLocalEngineEvidence } from "./catalog-local-scan.js";

export const catalogCapabilityEvidenceInputSchemaVersion =
  "catalog.capability_evidence_input.v0.1" as const;
export const catalogCapabilityEvidenceReadinessSchemaVersion =
  "catalog.capability_evidence_readiness.v0.1" as const;
export const catalogCapabilityEvidenceMergeFixtureSchemaVersion =
  "catalog.capability_evidence_merge_fixture.v0.1" as const;

export const catalogLocalRpgMakerMvMzSourceAdapterId = "local-scan:rpg_maker_mv_mz" as const;
export const catalogPublicRpgMakerMvMzAdapterId = "kaifuu.rpg-maker-mv-mz" as const;

export type CatalogCapabilityEvidenceSource = "public_fixture" | "private_local_aggregate";
export type CatalogCapabilityEvidenceKind =
  | "adapter_matrix"
  | "local_corpus_sidecar"
  | "key_validation";
export type CatalogCapabilityEvidenceStatus = "present" | "partial" | "missing" | "unknown";

export type CatalogCapabilityEvidenceInput = {
  schemaVersion: typeof catalogCapabilityEvidenceInputSchemaVersion;
  adapterId: string;
  level: CapabilityLevel;
  evidenceSource: CatalogCapabilityEvidenceSource;
  evidenceKind: CatalogCapabilityEvidenceKind;
  sourceAdapterId: string;
  sourceSchemaVersion: string;
  status: CatalogCapabilityEvidenceStatus;
  aggregateCounts: Record<string, number>;
  evidenceLabels: string[];
  limitations: string[];
};

export type CatalogPublicFixtureCapabilityEvidence = {
  schemaVersion: typeof catalogCapabilityEvidenceInputSchemaVersion;
  adapterId: string;
  level: CapabilityLevel;
  evidenceSource: "public_fixture";
  evidenceKind: "adapter_matrix";
  fixtureId: string;
  status: CatalogCapabilityEvidenceStatus;
  evidenceLabels: string[];
  limitations: string[];
};

export type CatalogKeyValidationDiagnosticResult =
  | "success"
  | "missing_key"
  | "bad_key"
  | "unsupported_suffix";

export type CatalogKeyValidationFixtureRecord = {
  requirementId: string;
  secretRefScheme: string;
  surface: string;
  codec: string;
  diagnosticResult: CatalogKeyValidationDiagnosticResult;
  proofHash: string;
  systemJsonProofHash: string;
  imageEvidenceHash: string;
};

export type CatalogKeyValidationFixture = {
  schemaVersion: string;
  fixtureId: string;
  status: "passed" | "failed";
  supportBoundary: string;
  records: CatalogKeyValidationFixtureRecord[];
  decryptOrPatchClaimed: boolean;
};

export type CatalogPublicKeyValidationCapabilityEvidence = {
  schemaVersion: typeof catalogCapabilityEvidenceInputSchemaVersion;
  adapterId: string;
  level: CapabilityLevel;
  evidenceSource: "public_fixture";
  evidenceKind: "key_validation";
  fixtureId: string;
  status: CatalogCapabilityEvidenceStatus;
  aggregateCounts: Record<string, number>;
  evidenceLabels: string[];
  limitations: string[];
};

export type CatalogCapabilityEvidenceReadiness = {
  schemaVersion: typeof catalogCapabilityEvidenceReadinessSchemaVersion;
  adapterId: string;
  matrix: AdapterCapabilityMatrixRecord;
  supportEvidence: {
    publicFixture: CatalogPublicFixtureCapabilityEvidence[];
    privateLocalAggregate: CatalogCapabilityEvidenceInput[];
  };
};

export type CatalogCapabilityEvidenceMergeInput = {
  schemaVersion: typeof catalogCapabilityEvidenceMergeFixtureSchemaVersion;
  publicFixture: {
    fixtureId: string;
    matrix: AdapterCapabilityMatrixRecord;
    evidence: Omit<
      CatalogPublicFixtureCapabilityEvidence,
      "schemaVersion" | "adapterId" | "fixtureId"
    >[];
  };
  privateLocalAggregate?: {
    localEngineEvidence: CatalogLocalEngineEvidence;
  };
};

export class CatalogLocalCapabilityEvidenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogLocalCapabilityEvidenceError";
  }
}

export const catalogRpgMakerMvMzKeyValidationFixtureId =
  "kaifuu-rpg-maker-mv-mz-key-validation-success" as const;
