// ALPHA-004: typed schema for the generated engine capability matrix.
//
// This is the typed contract for the artifact produced by
// `scripts/generate-engine-capability-matrix.mjs`. The artifact is GENERATED
// and traces every cell back to a real adapter-registry / detector-profile /
// readiness-profile / validation-run input; it is never hand-authored. This
// module gives consumers (dashboard, CLI, tests) a typed view plus a runtime
// guard that rejects malformed or hand-broken documents.

export const ENGINE_CAPABILITY_MATRIX_SCHEMA_VERSION =
  "itotori.engine_capability_matrix.v0.1" as const;

export const ENGINE_CAPABILITY_LEVELS = [
  "identify",
  "inventory",
  "extract",
  "patch",
  "helper",
  "runtime",
] as const;
export type EngineCapabilityLevel = (typeof ENGINE_CAPABILITY_LEVELS)[number];

export const ENGINE_CAPABILITY_LEVEL_STATUSES = [
  "supported",
  "partial",
  "unsupported",
  "not_applicable",
  "unknown",
] as const;
export type EngineCapabilityLevelStatus = (typeof ENGINE_CAPABILITY_LEVEL_STATUSES)[number];

export const ENGINE_EVIDENCE_POSTURES = ["positive_adapter", "readiness_only"] as const;
export type EngineEvidencePosture = (typeof ENGINE_EVIDENCE_POSTURES)[number];

export type EngineCapabilityLevelCell = {
  status: EngineCapabilityLevelStatus;
  derivedFrom: string;
  note?: string;
};

export type EngineCapabilityLevels = Record<EngineCapabilityLevel, EngineCapabilityLevelCell>;

export type EngineCapabilityEvidenceRef = {
  sourceId: string;
  category: string;
  kind: string;
};

export type EngineCapabilityRow = {
  rowId: string;
  engineFamily: string;
  scenario: string;
  adapterId: string | null;
  evidencePosture: EngineEvidencePosture;
  levels: EngineCapabilityLevels;
  evidence: EngineCapabilityEvidenceRef[];
  limitations: string[];
};

export type EngineCapabilityInputSource = {
  sourceId: string;
  path: string;
  category: string;
  kind: string;
  role: string;
};

export type EngineCapabilityExclusion = {
  engineFamily: string;
  reason: string;
  evidenceSourceIds: string[];
};

export type EngineCapabilityMatrixDocument = {
  schemaVersion: typeof ENGINE_CAPABILITY_MATRIX_SCHEMA_VERSION;
  generatedBy: string;
  doNotEdit: string;
  capabilityLevels: EngineCapabilityLevel[];
  levelStatuses: EngineCapabilityLevelStatus[];
  evidencePostures: EngineEvidencePosture[];
  inputCategoriesCovered: string[];
  inputs: EngineCapabilityInputSource[];
  rows: EngineCapabilityRow[];
  exclusions: EngineCapabilityExclusion[];
  knownLimitations: string[];
};

/** A project-bindable engine entry derived from a matrix adapter-registry row. */
export type ProjectEngineFamilyRegistration = {
  engineFamily: string;
  adapterId: string;
};

/**
 * Registry consumed by project create/import composition. Its members are
 * derived from the generated matrix's adapter-registry rows, never from a
 * caller-maintained engine-name list.
 */
export type ProjectEngineFamilyRegistry = {
  has(engineFamily: string): boolean;
  registrations(): readonly ProjectEngineFamilyRegistration[];
};

export class EngineCapabilityMatrixShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EngineCapabilityMatrixShapeError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function assertCell(value: unknown, path: string): asserts value is EngineCapabilityLevelCell {
  if (!isRecord(value)) {
    throw new EngineCapabilityMatrixShapeError(`${path} must be an object`);
  }
  if (!ENGINE_CAPABILITY_LEVEL_STATUSES.includes(value.status as EngineCapabilityLevelStatus)) {
    throw new EngineCapabilityMatrixShapeError(`${path}.status is not a valid level status`);
  }
  if (typeof value.derivedFrom !== "string" || value.derivedFrom.length === 0) {
    throw new EngineCapabilityMatrixShapeError(`${path}.derivedFrom must be a non-empty string`);
  }
  if (value.note !== undefined && typeof value.note !== "string") {
    throw new EngineCapabilityMatrixShapeError(`${path}.note must be a string when present`);
  }
}

function assertRow(value: unknown, index: number): asserts value is EngineCapabilityRow {
  const path = `rows[${index}]`;
  if (!isRecord(value)) {
    throw new EngineCapabilityMatrixShapeError(`${path} must be an object`);
  }
  if (typeof value.rowId !== "string" || value.rowId.length === 0) {
    throw new EngineCapabilityMatrixShapeError(`${path}.rowId must be a non-empty string`);
  }
  if (typeof value.engineFamily !== "string" || value.engineFamily.length === 0) {
    throw new EngineCapabilityMatrixShapeError(`${path}.engineFamily must be a non-empty string`);
  }
  if (typeof value.scenario !== "string" || value.scenario.length === 0) {
    throw new EngineCapabilityMatrixShapeError(`${path}.scenario must be a non-empty string`);
  }
  if (value.adapterId !== null && typeof value.adapterId !== "string") {
    throw new EngineCapabilityMatrixShapeError(`${path}.adapterId must be a string or null`);
  }
  if (!ENGINE_EVIDENCE_POSTURES.includes(value.evidencePosture as EngineEvidencePosture)) {
    throw new EngineCapabilityMatrixShapeError(`${path}.evidencePosture is invalid`);
  }
  if (!isRecord(value.levels)) {
    throw new EngineCapabilityMatrixShapeError(`${path}.levels must be an object`);
  }
  for (const level of ENGINE_CAPABILITY_LEVELS) {
    assertCell((value.levels as Record<string, unknown>)[level], `${path}.levels.${level}`);
  }
  if (!Array.isArray(value.evidence) || value.evidence.length === 0) {
    throw new EngineCapabilityMatrixShapeError(`${path}.evidence must be a non-empty array`);
  }
  for (const [evidenceIndex, evidence] of value.evidence.entries()) {
    if (!isRecord(evidence) || typeof evidence.sourceId !== "string") {
      throw new EngineCapabilityMatrixShapeError(
        `${path}.evidence[${evidenceIndex}] must reference a sourceId`,
      );
    }
  }
  if (!isNonEmptyStringArray(value.limitations)) {
    throw new EngineCapabilityMatrixShapeError(`${path}.limitations must be a string array`);
  }
}

/**
 * Runtime guard mirroring the generator output. Throws on any malformed or
 * hand-broken document so a stale/edited artifact cannot pass type-level
 * validation.
 */
export function assertEngineCapabilityMatrixDocument(
  value: unknown,
): asserts value is EngineCapabilityMatrixDocument {
  if (!isRecord(value)) {
    throw new EngineCapabilityMatrixShapeError("matrix document must be an object");
  }
  if (value.schemaVersion !== ENGINE_CAPABILITY_MATRIX_SCHEMA_VERSION) {
    throw new EngineCapabilityMatrixShapeError(
      `schemaVersion must be ${ENGINE_CAPABILITY_MATRIX_SCHEMA_VERSION}`,
    );
  }
  if (typeof value.generatedBy !== "string" || value.generatedBy.length === 0) {
    throw new EngineCapabilityMatrixShapeError("generatedBy must be a non-empty string");
  }
  for (const field of [
    "capabilityLevels",
    "levelStatuses",
    "evidencePostures",
    "knownLimitations",
  ]) {
    if (!isNonEmptyStringArray((value as Record<string, unknown>)[field])) {
      throw new EngineCapabilityMatrixShapeError(`${field} must be a string array`);
    }
  }
  if (!Array.isArray(value.inputs) || value.inputs.length === 0) {
    throw new EngineCapabilityMatrixShapeError("inputs must be a non-empty array");
  }
  if (!Array.isArray(value.rows) || value.rows.length === 0) {
    throw new EngineCapabilityMatrixShapeError("rows must be a non-empty array");
  }
  for (const [index, row] of value.rows.entries()) {
    assertRow(row, index);
  }
  if (!Array.isArray(value.exclusions)) {
    throw new EngineCapabilityMatrixShapeError("exclusions must be an array");
  }
}

/**
 * Derive the project-binding registry from the generated capability matrix.
 * A family is bindable precisely when the matrix associates it with an adapter
 * id; readiness-only rows without an adapter cannot be selected by a project.
 */
export function createProjectEngineFamilyRegistry(
  document: EngineCapabilityMatrixDocument,
): ProjectEngineFamilyRegistry {
  assertEngineCapabilityMatrixDocument(document);
  const byFamily = new Map<string, string>();
  for (const row of document.rows) {
    if (row.adapterId === null) {
      continue;
    }
    const existing = byFamily.get(row.engineFamily);
    if (existing !== undefined && existing !== row.adapterId) {
      throw new EngineCapabilityMatrixShapeError(
        `engine family '${row.engineFamily}' maps to multiple adapter ids`,
      );
    }
    byFamily.set(row.engineFamily, row.adapterId);
  }
  const registrations = [...byFamily.entries()]
    .map(([engineFamily, adapterId]) => ({ engineFamily, adapterId }))
    .sort((left, right) => left.engineFamily.localeCompare(right.engineFamily));
  return {
    has(engineFamily: string): boolean {
      return byFamily.has(engineFamily);
    },
    registrations(): readonly ProjectEngineFamilyRegistration[] {
      return registrations;
    },
  };
}

/**
 * Mechanical posture check: a positive extraction/patch adapter must extract or
 * patch (supported/partial). Readiness-only rows must NOT. Used by tests to
 * prove the distinction is faithful in the committed artifact.
 */
export function rowExtractsOrPatches(row: EngineCapabilityRow): boolean {
  const extractable =
    row.levels.extract.status === "supported" || row.levels.extract.status === "partial";
  const patchable =
    row.levels.patch.status === "supported" || row.levels.patch.status === "partial";
  return extractable || patchable;
}
