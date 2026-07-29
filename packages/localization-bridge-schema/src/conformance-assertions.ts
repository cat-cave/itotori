import {
  CONFORMANCE_EVIDENCE_TIERS_V01,
  CONFORMANCE_EVIDENCE_REF_KINDS_V01,
  CONFORMANCE_OUTCOME_KINDS_V01,
  CONFORMANCE_PROFILE_IDS_V01,
  CONFORMANCE_RUNTIME_ARTIFACT_KINDS_V01,
  CONFORMANCE_SCHEMA_VERSION_V01,
  CONFORMANCE_SUBSYSTEM_REQUIREMENTS_V01,
  CONFORMANCE_ABI_VERSION_V01,
  ConformanceIngestionError,
  MAX_DETAIL_LENGTH,
  MAX_ID_LENGTH,
  MAX_NOTE_LENGTH,
  MAX_REASON_LENGTH,
  PROFILE_EVIDENCE_TIER_CEILING,
  PROFILE_REQUIRED_SUBSYSTEMS,
  type ConformanceEvidenceRefV01,
  type ConformanceEvidenceTierV01,
  type ConformanceManifestV01,
  type ConformanceProfileIdV01,
  type ConformanceProfileExtensionV01,
  type ConformanceProfileV01,
  type ConformanceResultOutcomeV01,
  type ConformanceResultV01,
  type ConformanceSubsystemRequirementV01,
} from "./conformance-types.js";
import {
  asArray,
  asRecord,
  assertAdapterId,
  assertAllowedKeys,
  assertBoolean,
  assertBoundedString,
  assertEnum,
  assertExtensionKey,
  assertIdString,
  assertRecordedAt,
  assertRuntimeArtifactUri,
  assertSemanticCodeAllowedV01,
  assertStatePath,
  reject,
} from "./conformance-primitives.js";

function assertEvidenceRef(value: unknown, label: string): ConformanceEvidenceRefV01 {
  const record = asRecord(value, label);
  const artifactKind = assertEnum(
    record.artifactKind,
    CONFORMANCE_EVIDENCE_REF_KINDS_V01,
    `${label}.artifactKind`,
  );
  switch (artifactKind) {
    case "runtimeArtifact": {
      assertAllowedKeys(record, ["artifactKind", "kind", "uri", "artifactId"], label);
      const kind = assertEnum(record.kind, CONFORMANCE_RUNTIME_ARTIFACT_KINDS_V01, `${label}.kind`);
      const uri = assertRuntimeArtifactUri(record.uri, `${label}.uri`);
      let artifactId: string | undefined;
      if (record.artifactId !== undefined) {
        artifactId = assertIdString(record.artifactId, `${label}.artifactId`);
      }
      return artifactId === undefined
        ? { artifactKind, kind, uri }
        : { artifactKind, kind, uri, artifactId };
    }
    case "textLine": {
      assertAllowedKeys(record, ["artifactKind", "lineId"], label);
      const lineId = assertIdString(record.lineId, `${label}.lineId`);
      return { artifactKind, lineId };
    }
    case "frameArtifactRef": {
      assertAllowedKeys(record, ["artifactKind", "frameId"], label);
      const frameId = assertIdString(record.frameId, `${label}.frameId`);
      return { artifactKind, frameId };
    }
    case "replayLogRef": {
      assertAllowedKeys(record, ["artifactKind", "runId"], label);
      const runId = assertIdString(record.runId, `${label}.runId`);
      return { artifactKind, runId };
    }
    case "implMapFixture": {
      assertAllowedKeys(record, ["artifactKind", "fixtureId"], label);
      const fixtureId = assertIdString(record.fixtureId, `${label}.fixtureId`);
      return { artifactKind, fixtureId };
    }
    case "bridgeUnit": {
      assertAllowedKeys(record, ["artifactKind", "bridgeUnitId"], label);
      const bridgeUnitId = assertIdString(record.bridgeUnitId, `${label}.bridgeUnitId`);
      return { artifactKind, bridgeUnitId };
    }
    case "statePath": {
      assertAllowedKeys(record, ["artifactKind", "path"], label);
      const path = assertStatePath(record.path, `${label}.path`);
      return { artifactKind, path };
    }
  }
}

function assertOutcome(value: unknown, label: string): ConformanceResultOutcomeV01 {
  const record = asRecord(value, label);
  const kind = assertEnum(record.kind, CONFORMANCE_OUTCOME_KINDS_V01, `${label}.kind`);
  switch (kind) {
    case "pass": {
      assertAllowedKeys(record, ["kind", "evidenceTier"], label);
      const evidenceTier = assertEnum(
        record.evidenceTier,
        CONFORMANCE_EVIDENCE_TIERS_V01,
        `${label}.evidenceTier`,
        "itotori.conformance.evidence_tier_malformed",
      );
      return { kind, evidenceTier };
    }
    case "fail": {
      assertAllowedKeys(record, ["kind", "semanticCode", "detail"], label);
      const semanticCode = assertBoundedString(
        record.semanticCode,
        `${label}.semanticCode`,
        MAX_ID_LENGTH * 4,
        "itotori.conformance.semantic_code_malformed",
      );
      assertSemanticCodeAllowedV01(semanticCode, `${label}.semanticCode`);
      const detail = assertBoundedString(record.detail, `${label}.detail`, MAX_DETAIL_LENGTH);
      return { kind, semanticCode, detail };
    }
    case "skip": {
      assertAllowedKeys(record, ["kind", "semanticCode", "reason"], label);
      const semanticCode = assertBoundedString(
        record.semanticCode,
        `${label}.semanticCode`,
        MAX_ID_LENGTH * 4,
        "itotori.conformance.semantic_code_malformed",
      );
      assertSemanticCodeAllowedV01(semanticCode, `${label}.semanticCode`);
      const reason = assertBoundedString(record.reason, `${label}.reason`, MAX_REASON_LENGTH);
      return { kind, semanticCode, reason };
    }
    case "unsupported": {
      assertAllowedKeys(record, ["kind", "semanticCode", "declaredInManifest"], label);
      const semanticCode = assertBoundedString(
        record.semanticCode,
        `${label}.semanticCode`,
        MAX_ID_LENGTH * 4,
        "itotori.conformance.semantic_code_malformed",
      );
      assertSemanticCodeAllowedV01(semanticCode, `${label}.semanticCode`);
      const declaredInManifest = assertBoolean(
        record.declaredInManifest,
        `${label}.declaredInManifest`,
      );
      if (declaredInManifest) {
        reject(
          "itotori.conformance.declared_profile_reported_as_unsupported",
          `${label}.declaredInManifest must be false (declared profiles cannot be Unsupported)`,
        );
      }
      return { kind, semanticCode, declaredInManifest };
    }
  }
}

function assertProfile(value: unknown, label: string): ConformanceProfileV01 {
  const record = asRecord(value, label);
  assertAllowedKeys(record, ["id", "requiredSubsystems", "evidenceTierCeiling"], label);
  const id = assertEnum(record.id, CONFORMANCE_PROFILE_IDS_V01, `${label}.id`);
  const requiredArray = asArray(record.requiredSubsystems, `${label}.requiredSubsystems`);
  const seen = new Set<ConformanceSubsystemRequirementV01>();
  const requiredSubsystems: ConformanceSubsystemRequirementV01[] = [];
  for (const [index, entry] of requiredArray.entries()) {
    const sub = assertEnum(
      entry,
      CONFORMANCE_SUBSYSTEM_REQUIREMENTS_V01,
      `${label}.requiredSubsystems[${String(index)}]`,
    );
    if (seen.has(sub)) {
      reject(
        "itotori.conformance.duplicate_subsystem",
        `${label}.requiredSubsystems[${String(index)}] duplicates ${sub}`,
      );
    }
    seen.add(sub);
    requiredSubsystems.push(sub);
  }
  for (const needed of PROFILE_REQUIRED_SUBSYSTEMS[id]) {
    if (!seen.has(needed)) {
      reject(
        "itotori.conformance.missing_subsystem",
        `${label}.requiredSubsystems is missing ${needed} for profile ${id}`,
      );
    }
  }
  const evidenceTierCeiling = assertEnum(
    record.evidenceTierCeiling,
    CONFORMANCE_EVIDENCE_TIERS_V01,
    `${label}.evidenceTierCeiling`,
    "itotori.conformance.evidence_tier_malformed",
  );
  const profileCeiling = PROFILE_EVIDENCE_TIER_CEILING[id];
  if (compareEvidenceTier(evidenceTierCeiling, profileCeiling) > 0) {
    reject(
      "itotori.conformance.evidence_tier_above_profile_ceiling",
      `${label}.evidenceTierCeiling (${evidenceTierCeiling}) exceeds profile ${id} ceiling ${profileCeiling}`,
    );
  }
  return { id, requiredSubsystems, evidenceTierCeiling };
}

function assertProfileExtension(value: unknown, label: string): ConformanceProfileExtensionV01 {
  const record = asRecord(value, label);
  assertAllowedKeys(record, ["profileId", "key", "note"], label);
  const profileId = assertEnum(record.profileId, CONFORMANCE_PROFILE_IDS_V01, `${label}.profileId`);
  const key = assertExtensionKey(record.key, `${label}.key`);
  const note = assertBoundedString(record.note, `${label}.note`, MAX_NOTE_LENGTH);
  return { profileId, key, note };
}

function compareEvidenceTier(a: ConformanceEvidenceTierV01, b: ConformanceEvidenceTierV01): number {
  return CONFORMANCE_EVIDENCE_TIERS_V01.indexOf(a) - CONFORMANCE_EVIDENCE_TIERS_V01.indexOf(b);
}

export function assertConformanceManifestV01(
  value: unknown,
): asserts value is ConformanceManifestV01 {
  const record = asRecord(value, "ConformanceManifestV01");
  assertAllowedKeys(
    record,
    ["schemaVersion", "adapterId", "abiVersion", "supportedProfiles", "optionalExtensions"],
    "ConformanceManifestV01",
  );
  if (record.schemaVersion !== CONFORMANCE_SCHEMA_VERSION_V01) {
    reject(
      "itotori.conformance.schema_version_mismatch",
      `ConformanceManifestV01.schemaVersion must be ${CONFORMANCE_SCHEMA_VERSION_V01} (got ${String(record.schemaVersion)})`,
    );
  }
  assertAdapterId(record.adapterId, "ConformanceManifestV01.adapterId");
  if (record.abiVersion !== CONFORMANCE_ABI_VERSION_V01) {
    reject(
      "itotori.conformance.abi_version_unsupported",
      `ConformanceManifestV01.abiVersion must be ${String(CONFORMANCE_ABI_VERSION_V01)} (got ${String(record.abiVersion)})`,
    );
  }
  const profilesArray = asArray(
    record.supportedProfiles,
    "ConformanceManifestV01.supportedProfiles",
  );
  if (profilesArray.length === 0) {
    reject(
      "itotori.conformance.manifest_empty",
      "ConformanceManifestV01.supportedProfiles must not be empty",
    );
  }
  const seenIds = new Set<ConformanceProfileIdV01>();
  const profiles: ConformanceProfileV01[] = [];
  for (const [index, entry] of profilesArray.entries()) {
    const profile = assertProfile(
      entry,
      `ConformanceManifestV01.supportedProfiles[${String(index)}]`,
    );
    if (seenIds.has(profile.id)) {
      reject(
        "itotori.conformance.duplicate_profile",
        `ConformanceManifestV01.supportedProfiles[${String(index)}] duplicates profile ${profile.id}`,
      );
    }
    seenIds.add(profile.id);
    profiles.push(profile);
  }
  if (record.optionalExtensions !== undefined) {
    const extArray = asArray(
      record.optionalExtensions,
      "ConformanceManifestV01.optionalExtensions",
    );
    const seenExt = new Set<string>();
    for (const [index, entry] of extArray.entries()) {
      const extension = assertProfileExtension(
        entry,
        `ConformanceManifestV01.optionalExtensions[${String(index)}]`,
      );
      if (!seenIds.has(extension.profileId)) {
        reject(
          "itotori.conformance.orphaned_extension",
          `ConformanceManifestV01.optionalExtensions[${String(index)}] references undeclared profile ${extension.profileId}`,
        );
      }
      const key = `${extension.profileId}::${extension.key}`;
      if (seenExt.has(key)) {
        reject(
          "itotori.conformance.duplicate_extension",
          `ConformanceManifestV01.optionalExtensions[${String(index)}] duplicates ${extension.profileId}/${extension.key}`,
        );
      }
      seenExt.add(key);
    }
  }
}

export function assertConformanceResultV01(value: unknown): asserts value is ConformanceResultV01 {
  const record = asRecord(value, "ConformanceResultV01");
  assertAllowedKeys(
    record,
    ["schemaVersion", "adapterId", "profileId", "outcome", "evidence", "recordedAt"],
    "ConformanceResultV01",
  );
  if (record.schemaVersion !== CONFORMANCE_SCHEMA_VERSION_V01) {
    reject(
      "itotori.conformance.schema_version_mismatch",
      `ConformanceResultV01.schemaVersion must be ${CONFORMANCE_SCHEMA_VERSION_V01} (got ${String(record.schemaVersion)})`,
    );
  }
  assertAdapterId(record.adapterId, "ConformanceResultV01.adapterId");
  const profileId = assertEnum(
    record.profileId,
    CONFORMANCE_PROFILE_IDS_V01,
    "ConformanceResultV01.profileId",
  );
  assertRecordedAt(record.recordedAt, "ConformanceResultV01.recordedAt");
  const evidenceArray = asArray(record.evidence, "ConformanceResultV01.evidence");
  const evidence: ConformanceEvidenceRefV01[] = [];
  for (const [index, entry] of evidenceArray.entries()) {
    evidence.push(assertEvidenceRef(entry, `ConformanceResultV01.evidence[${String(index)}]`));
  }
  const outcome = assertOutcome(record.outcome, "ConformanceResultV01.outcome");
  if (outcome.kind === "pass") {
    if (evidence.length === 0) {
      reject(
        "itotori.conformance.pass_without_evidence",
        `ConformanceResultV01.evidence must be non-empty for Pass outcomes on profile ${profileId}`,
      );
    }
    const profileCeiling = PROFILE_EVIDENCE_TIER_CEILING[profileId];
    if (compareEvidenceTier(outcome.evidenceTier, profileCeiling) > 0) {
      reject(
        "itotori.conformance.evidence_tier_above_profile_ceiling",
        `ConformanceResultV01.outcome.evidenceTier (${outcome.evidenceTier}) exceeds profile ${profileId} ceiling ${profileCeiling}`,
      );
    }
  }
}

export type ConformanceCrossValidationIssueV01 = {
  code: string;
  message: string;
  profileId?: ConformanceProfileIdV01;
};

// Mirrors the Rust `cross_validate_results_against_manifest` invariants.
// Returns the first issue found via the error throw; returns successfully
// otherwise.
export function assertConformanceManifestResultJoinV01(
  manifest: ConformanceManifestV01,
  results: ReadonlyArray<ConformanceResultV01>,
): void {
  const declared = new Map<ConformanceProfileIdV01, ConformanceProfileV01>();
  for (const profile of manifest.supportedProfiles) {
    declared.set(profile.id, profile);
  }
  const reported = new Set<ConformanceProfileIdV01>();
  for (const result of results) {
    if (result.adapterId !== manifest.adapterId) {
      reject(
        "itotori.conformance.adapter_id_mismatch",
        `result.adapterId (${result.adapterId}) does not match manifest.adapterId (${manifest.adapterId})`,
      );
    }
    reported.add(result.profileId);
    const profileDeclared = declared.has(result.profileId);
    switch (result.outcome.kind) {
      case "pass": {
        if (!profileDeclared) {
          reject(
            "itotori.conformance.profile_not_declared",
            `result.profileId (${result.profileId}) is not declared in manifest`,
          );
        }
        const profile = declared.get(result.profileId);
        if (profile !== undefined) {
          if (compareEvidenceTier(result.outcome.evidenceTier, profile.evidenceTierCeiling) > 0) {
            reject(
              "itotori.conformance.pass_above_manifest_ceiling",
              `result.outcome.evidenceTier (${result.outcome.evidenceTier}) exceeds manifest profile ${result.profileId} ceiling ${profile.evidenceTierCeiling}`,
            );
          }
        }
        break;
      }
      case "fail": {
        if (!profileDeclared) {
          reject(
            "itotori.conformance.profile_not_declared",
            `result.profileId (${result.profileId}) is not declared in manifest`,
          );
        }
        break;
      }
      case "skip": {
        if (profileDeclared) {
          reject(
            "itotori.conformance.declared_profile_skipped",
            `declared profile ${result.profileId} reported as Skip`,
          );
        }
        break;
      }
      case "unsupported": {
        if (profileDeclared) {
          reject(
            "itotori.conformance.declared_profile_reported_as_unsupported",
            `declared profile ${result.profileId} reported as Unsupported`,
          );
        }
        // declared_in_manifest=true is already rejected by assertOutcome.
        break;
      }
    }
  }
  for (const profile of manifest.supportedProfiles) {
    if (!reported.has(profile.id)) {
      reject(
        "itotori.conformance.profile_not_reported",
        `manifest profile ${profile.id} has no matching result`,
      );
    }
  }
}

export function profileEvidenceTierCeilingV01(
  profileId: ConformanceProfileIdV01,
): ConformanceEvidenceTierV01 {
  return PROFILE_EVIDENCE_TIER_CEILING[profileId];
}

export function profileRequiredSubsystemsV01(
  profileId: ConformanceProfileIdV01,
): ReadonlyArray<ConformanceSubsystemRequirementV01> {
  return PROFILE_REQUIRED_SUBSYSTEMS[profileId];
}
