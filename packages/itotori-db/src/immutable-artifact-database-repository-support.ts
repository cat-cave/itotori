import {
  ArtifactStoreIntegrityError,
  assertImmutableArtifactFormatVersion,
  type ArtifactDescriptor,
  type ArtifactRetentionPolicy,
} from "./immutable-artifact-store.js";

export type ArtifactDatabaseRow = {
  artifactId: string;
  byteLength: number;
  parents: readonly string[];
  retention: ArtifactRetentionPolicy;
  baseExpiresAt: string;
  createdAt: string;
  createdBy: string;
  deletionState: string;
  formatVersion: string;
  contentFingerprint: string;
};

export function databaseArtifactRow(row: Record<string, unknown>): ArtifactDatabaseRow {
  const classification = String(row.retention_classification);
  const basis = String(row.retention_basis);
  const parents = row.parents;
  if (classification !== "public" && classification !== "restricted") {
    throw new ArtifactStoreIntegrityError("stored retention classification is invalid");
  }
  if (!isRetentionBasis(basis) || !Array.isArray(parents) || !parents.every(isString)) {
    throw new ArtifactStoreIntegrityError("stored immutable artifact metadata is invalid");
  }
  assertImmutableArtifactFormatVersion(row.format_version);
  return {
    artifactId: String(row.artifact_id),
    byteLength: Number(row.byte_length),
    parents,
    retention: {
      classification,
      basis,
      expiresAt: databaseTimestamp(row.effective_expires_at),
    },
    baseExpiresAt: databaseTimestamp(row.base_expires_at),
    createdAt: databaseTimestamp(row.created_at),
    createdBy: String(row.created_by),
    deletionState: String(row.deletion_state),
    formatVersion: String(row.format_version),
    contentFingerprint: requiredDatabaseString(
      row.content_fingerprint,
      "artifact content fingerprint",
    ),
  };
}

export function databaseArtifactDescriptor(row: ArtifactDatabaseRow): ArtifactDescriptor {
  return {
    artifactId: row.artifactId,
    byteLength: row.byteLength,
    parents: [...row.parents],
    retention: { ...row.retention },
    createdAt: row.createdAt,
    createdBy: row.createdBy,
  };
}

export function sameDatabaseArtifactMetadata(
  row: ArtifactDatabaseRow,
  input: { parents: readonly string[]; retention: ArtifactRetentionPolicy; byteLength: number },
): boolean {
  return (
    row.byteLength === input.byteLength &&
    row.parents.length === input.parents.length &&
    row.parents.every((parent, index) => parent === input.parents[index]) &&
    row.retention.classification === input.retention.classification &&
    row.retention.basis === input.retention.basis &&
    row.baseExpiresAt === input.retention.expiresAt
  );
}

export function databaseTimestamp(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    throw new ArtifactStoreIntegrityError("stored timestamp is invalid");
  }
  return date.toISOString();
}

export function requiredDatabaseBytes(value: unknown, label: string): Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw new ArtifactStoreIntegrityError(`${label} is missing`);
  }
  return new Uint8Array(value);
}

export function requiredDatabaseString(value: unknown, label = "artifact key reference"): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ArtifactStoreIntegrityError(`${label} is missing`);
  }
  return value;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isRetentionBasis(value: string): value is ArtifactRetentionPolicy["basis"] {
  return ["lineage", "expiry", "release", "append-only", "declared-scope"].includes(value);
}
