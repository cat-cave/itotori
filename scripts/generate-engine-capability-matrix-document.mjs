import {
  buildFixturePositiveAdapterRow,
  buildProductionPlainXp3Row,
  buildProductionRpgMakerRow,
  buildReallivePatchbackProduceRow,
  buildRealliveReadinessRow,
  buildSoftpalRow,
  buildXp3Row,
} from "./generate-engine-capability-matrix-adapters.mjs";
import {
  buildDetectionSummaryReadinessRow,
  buildRpgMakerEncryptedMediaRow,
  buildSiglusDetectorReadinessRow,
  buildSiglusKnownKeyRow,
  buildTyranoScriptRow,
} from "./generate-engine-capability-matrix-readiness.mjs";
import {
  CAPABILITY_LEVELS,
  EVIDENCE_POSTURES,
  GENERATOR_PATH,
  INPUT_SOURCES,
  LEVEL_STATUSES,
  MATRIX_SCHEMA_VERSION,
  MatrixGenerationError,
  NON_DRIVER_EXCLUSIONS,
  REQUIRED_INPUT_CATEGORIES,
  REQUIRED_INPUT_KINDS,
} from "./generate-engine-capability-matrix-inputs.mjs";

export function generateEngineCapabilityMatrix(inputs) {
  const rows = [
    buildFixturePositiveAdapterRow(inputs),
    buildTyranoScriptRow(inputs),
    buildXp3Row(inputs, "xp3-plain-detector-profile", "readiness"),
    buildXp3Row(inputs, "xp3-compressed-detector-profile", "readiness"),
    buildXp3Row(inputs, "xp3-encrypted-detector-profile", "crypt-smoke"),
    buildProductionPlainXp3Row(inputs),
    buildSiglusDetectorReadinessRow(inputs),
    buildSiglusKnownKeyRow(inputs),
    buildRpgMakerEncryptedMediaRow(inputs),
    buildProductionRpgMakerRow(inputs),
    buildDetectionSummaryReadinessRow(inputs, {
      engineFamily: "wolf_rpg_editor",
      rowId: "wolf-rpg-editor-encrypted-archive-smoke",
      scenario: "encrypted-archive-smoke",
    }),
    buildDetectionSummaryReadinessRow(inputs, {
      engineFamily: "bgi_ethornell",
      rowId: "bgi-ethornell-container-readiness",
      scenario: "detector-profile-readiness",
    }),
    buildRealliveReadinessRow(inputs),
    buildReallivePatchbackProduceRow(inputs),
    buildSoftpalRow(inputs),
  ];

  assertNoExcludedRows(rows);
  const consumed = collectConsumedNamespaces(rows);
  assertRequiredCoverage(consumed);

  return {
    schemaVersion: MATRIX_SCHEMA_VERSION,
    generatedBy: GENERATOR_PATH,
    doNotEdit:
      "GENERATED ARTIFACT — do not hand-edit. Regenerate with `node scripts/generate-engine-capability-matrix.mjs`. Manual edits fail `--check`.",
    capabilityLevels: CAPABILITY_LEVELS,
    levelStatuses: LEVEL_STATUSES,
    evidencePostures: EVIDENCE_POSTURES,
    inputCategoriesCovered: consumed.categories,
    inputKindsCovered: consumed.kinds,
    inputs: INPUT_SOURCES.map((s) => ({
      sourceId: s.id,
      path: s.path,
      category: s.category,
      kind: s.kind,
      role: s.role,
    })),
    rows,
    exclusions: NON_DRIVER_EXCLUSIONS.map((e) => ({
      engineFamily: e.engineFamily,
      reason: e.reason,
      evidenceSourceIds: e.evidenceSourceIds,
    })),
    knownLimitations: collectKnownLimitations(rows),
  };
}

function assertNoExcludedRows(rows) {
  const excluded = new Set(NON_DRIVER_EXCLUSIONS.map((e) => e.engineFamily));
  for (const row of rows) {
    if (excluded.has(row.engineFamily)) {
      throw new MatrixGenerationError(
        `engine family ${row.engineFamily} is on the non-driver exclusion list and must not appear as a capability row`,
      );
    }
  }
}

export function collectConsumedNamespaces(rows) {
  const categories = new Set();
  const kinds = new Set();
  for (const row of rows) {
    for (const evidence of row.evidence ?? []) {
      if (typeof evidence.category === "string" && evidence.category.length > 0) {
        categories.add(evidence.category);
      }
      if (typeof evidence.kind === "string" && evidence.kind.length > 0) {
        kinds.add(evidence.kind);
      }
    }
  }
  return {
    categories: [...categories].sort(),
    kinds: [...kinds].sort(),
  };
}

export function assertRequiredCoverage(consumed) {
  const categorySet = new Set(consumed.categories ?? []);
  const kindSet = new Set(consumed.kinds ?? []);
  const missingCategories = REQUIRED_INPUT_CATEGORIES.filter((c) => !categorySet.has(c));
  const missingKinds = REQUIRED_INPUT_KINDS.filter((k) => !kindSet.has(k));
  if (missingCategories.length > 0) {
    throw new MatrixGenerationError(
      `matrix is not generated from every required input category; missing: ${missingCategories.join(", ")}`,
    );
  }
  if (missingKinds.length > 0) {
    throw new MatrixGenerationError(
      `matrix is not generated from every required input kind; missing: ${missingKinds.join(", ")}`,
    );
  }
}

function collectKnownLimitations(rows) {
  const limitations = [];
  for (const row of rows) {
    for (const limitation of row.limitations) {
      limitations.push(`[${row.rowId}] ${limitation}`);
    }
  }
  for (const exclusion of NON_DRIVER_EXCLUSIONS) {
    limitations.push(`[exclusion:${exclusion.engineFamily}] ${exclusion.reason}`);
  }
  return limitations;
}
