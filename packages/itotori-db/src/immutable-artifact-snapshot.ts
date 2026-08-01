import { createHash } from "node:crypto";

import { validateAuditedArtifactState } from "./immutable-artifact-audit.js";

export const immutableArtifactSnapshotVersion: "itotori.immutable-artifact-store.v1" =
  "itotori.immutable-artifact-store.v1";
export const genesisArtifactAuditHash = `sha256:${"0".repeat(64)}`;
const hashPattern = /^sha256:[0-9a-f]{64}$/u;

export type ArtifactRetentionBasis =
  | "lineage"
  | "expiry"
  | "release"
  | "append-only"
  | "declared-scope";
export type ArtifactRetentionPolicy = {
  classification: "public" | "restricted";
  expiresAt: string;
  basis: ArtifactRetentionBasis;
};
export type ArtifactDescriptor = {
  artifactId: string;
  byteLength: number;
  parents: readonly string[];
  retention: ArtifactRetentionPolicy;
  createdAt: string;
  createdBy: string;
};
export type ArtifactReference = {
  referenceId: string;
  artifactId: string;
  purpose: "lineage" | "release";
  createdAt: string;
  createdBy: string;
};
export type ArtifactAuditAction =
  | "put"
  | "reference-add"
  | "reference-remove"
  | "retain"
  | "prune"
  | "read"
  | "reference-resolve"
  | "export"
  | "audit";
export type ArtifactAuditOutcome =
  | "created"
  | "already-present"
  | "added"
  | "removed"
  | "retained"
  | "pruned"
  | "served"
  | "resolved"
  | "exported"
  | "reviewed"
  | "missing"
  | "no-op"
  | "denied"
  | "rejected";
type JsonValue = null | boolean | number | string | JsonValue[] | ArtifactAuditDetails;
export type ArtifactAuditDetails = { [key: string]: JsonValue };
export type ArtifactAuditEvent = {
  ordinal: number;
  occurredAt: string;
  actor: string;
  action: ArtifactAuditAction;
  target: string;
  outcome: ArtifactAuditOutcome;
  details: ArtifactAuditDetails;
  previousHash: string;
  eventHash: string;
};
export type SnapshotArtifact = ArtifactDescriptor & { bytesBase64: string };
export type ImmutableArtifactSnapshot = {
  schemaVersion: typeof immutableArtifactSnapshotVersion;
  artifacts: readonly SnapshotArtifact[];
  references: readonly ArtifactReference[];
  auditEvents: readonly ArtifactAuditEvent[];
  auditLength: number;
  auditHead: string;
  snapshotHash: string;
};

export class ArtifactStoreIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactStoreIntegrityError";
  }
}

export function artifactIdForBytes(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function decodeArtifactSnapshot(serialized: string): ImmutableArtifactSnapshot {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch (error) {
    throw new ArtifactStoreIntegrityError(
      `artifact snapshot is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  assertSnapshot(value);
  validateSnapshot(value);
  return value;
}

export function hashArtifactJson(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalArtifactJson(value)).digest("hex")}`;
}

export function canonicalArtifactJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalArtifactJson).join(",")}]`;
  if (isObject(value)) {
    const fields = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalArtifactJson(value[key])}`);
    return `{${fields.join(",")}}`;
  }
  throw new ArtifactStoreIntegrityError("value is not canonical JSON");
}

export function decodeArtifactBytes(value: string, label: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new ArtifactStoreIntegrityError(`${label} has invalid base64 bytes`);
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) {
    throw new ArtifactStoreIntegrityError(`${label} has noncanonical bytes`);
  }
  return new Uint8Array(bytes);
}

export function copyArtifactDescriptor(row: ArtifactDescriptor): ArtifactDescriptor {
  return {
    artifactId: row.artifactId,
    byteLength: row.byteLength,
    parents: [...row.parents],
    retention: { ...row.retention },
    createdAt: row.createdAt,
    createdBy: row.createdBy,
  };
}

export function copyArtifactAuditEvent(event: ArtifactAuditEvent): ArtifactAuditEvent {
  return { ...event, details: structuredClone(event.details) };
}

export function canonicalArtifactTimestamp(value: string, label: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new ArtifactStoreIntegrityError(`${label} must be a canonical UTC timestamp`);
  }
  return value;
}

export function nonBlankArtifactValue(value: string, label: string): string {
  if (!value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new ArtifactStoreIntegrityError(`${label} must be nonblank without controls`);
  }
  return value;
}

export function assertArtifactHash(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !hashPattern.test(value)) {
    throw new ArtifactStoreIntegrityError(`${label} is not sha256`);
  }
}

export function sortedUniqueArtifactValues(values: readonly string[], label: string): string[] {
  const sorted = [...values].sort();
  assertSortedUnique(sorted, label);
  return sorted;
}

export function equalArtifactValues(left: readonly unknown[], right: readonly unknown[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function validateSnapshot(snapshot: ImmutableArtifactSnapshot): void {
  const { snapshotHash, ...body } = snapshot;
  if (hashArtifactJson(body) !== snapshotHash) {
    throw new ArtifactStoreIntegrityError("snapshot hash mismatch");
  }
  const identities = snapshot.artifacts.map((row) => row.artifactId);
  assertSortedUnique(identities, "snapshot artifacts");
  const known = new Set(identities);
  for (const row of snapshot.artifacts) {
    const bytes = decodeArtifactBytes(row.bytesBase64, row.artifactId);
    if (artifactIdForBytes(bytes) !== row.artifactId || bytes.byteLength !== row.byteLength) {
      throw new ArtifactStoreIntegrityError(`artifact ${row.artifactId} bytes are not intact`);
    }
    if (row.retention.expiresAt <= row.createdAt) {
      throw new ArtifactStoreIntegrityError(`artifact ${row.artifactId} retention is invalid`);
    }
    if (row.retention.basis === "release" && row.retention.classification !== "public") {
      throw new ArtifactStoreIntegrityError(`artifact ${row.artifactId} release policy is invalid`);
    }
    if (row.parents.some((parent) => parent === row.artifactId || !known.has(parent))) {
      throw new ArtifactStoreIntegrityError(`artifact ${row.artifactId} has invalid lineage`);
    }
  }
  assertSortedUnique(
    snapshot.references.map((row) => row.referenceId),
    "snapshot references",
  );
  if (snapshot.references.some((row) => !known.has(row.artifactId))) {
    throw new ArtifactStoreIntegrityError("artifact reference names missing bytes");
  }
  for (const reference of snapshot.references) {
    const artifact = snapshot.artifacts.find((row) => row.artifactId === reference.artifactId);
    if (
      reference.purpose === "release" &&
      (artifact?.retention.basis !== "release" || artifact.retention.classification !== "public")
    ) {
      throw new ArtifactStoreIntegrityError("release reference names an invalid artifact policy");
    }
  }
  if (snapshot.auditLength !== snapshot.auditEvents.length) {
    throw new ArtifactStoreIntegrityError("audit length mismatch");
  }
  let previous = genesisArtifactAuditHash;
  let previousTime: string | undefined;
  for (const [ordinal, event] of snapshot.auditEvents.entries()) {
    const { eventHash, ...body } = event;
    if (
      event.ordinal !== ordinal ||
      event.previousHash !== previous ||
      event.eventHash !== hashArtifactJson(body) ||
      (previousTime !== undefined && event.occurredAt < previousTime)
    ) {
      throw new ArtifactStoreIntegrityError(`audit chain is invalid at ordinal ${ordinal}`);
    }
    previous = eventHash;
    previousTime = event.occurredAt;
  }
  if (snapshot.auditHead !== previous) throw new ArtifactStoreIntegrityError("audit head mismatch");
  validateAuditedArtifactState(snapshot);
}

function assertSnapshot(value: unknown): asserts value is ImmutableArtifactSnapshot {
  const root = exactObject(
    value,
    [
      "schemaVersion",
      "artifacts",
      "references",
      "auditEvents",
      "auditLength",
      "auditHead",
      "snapshotHash",
    ],
    "snapshot",
  );
  if (root.schemaVersion !== immutableArtifactSnapshotVersion) {
    throw new ArtifactStoreIntegrityError("snapshot schema version is incompatible");
  }
  assertArtifactHash(root.snapshotHash, "snapshot hash");
  for (const item of unknownArray(root.artifacts, "snapshot artifacts")) {
    assertSnapshotArtifact(item);
  }
  for (const item of unknownArray(root.references, "snapshot references")) {
    assertSnapshotReference(item);
  }
  assertInteger(root.auditLength, "audit length");
  assertArtifactHash(root.auditHead, "audit head");
  for (const item of unknownArray(root.auditEvents, "audit events")) assertAuditEvent(item);
}

function assertSnapshotArtifact(value: unknown): void {
  const row = exactObject(
    value,
    ["artifactId", "byteLength", "parents", "retention", "createdAt", "createdBy", "bytesBase64"],
    "snapshot artifact",
  );
  assertArtifactHash(row.artifactId, "artifact identity");
  assertInteger(row.byteLength, "artifact byte length");
  const parents = unknownArray(row.parents, "artifact parents");
  for (const parent of parents) assertArtifactHash(parent, "parent identity");
  assertSortedUnique(parents, "artifact parents");
  const retention = exactObject(
    row.retention,
    ["classification", "expiresAt", "basis"],
    "artifact retention",
  );
  if (retention.classification !== "public" && retention.classification !== "restricted") {
    throw new ArtifactStoreIntegrityError("retention classification is invalid");
  }
  if (!isRetentionBasis(retention.basis)) {
    throw new ArtifactStoreIntegrityError("retention basis is invalid");
  }
  assertTimestamp(retention.expiresAt, "retention deadline");
  assertTimestamp(row.createdAt, "artifact creation timestamp");
  assertNonBlank(row.createdBy, "artifact creator");
  if (typeof row.bytesBase64 !== "string") {
    throw new ArtifactStoreIntegrityError("artifact bytes are invalid");
  }
}

function assertSnapshotReference(value: unknown): void {
  const row = exactObject(
    value,
    ["referenceId", "artifactId", "purpose", "createdAt", "createdBy"],
    "artifact reference",
  );
  assertNonBlank(row.referenceId, "reference identity");
  assertArtifactHash(row.artifactId, "referenced artifact identity");
  if (row.purpose !== "lineage" && row.purpose !== "release") {
    throw new ArtifactStoreIntegrityError("reference purpose is invalid");
  }
  assertTimestamp(row.createdAt, "reference timestamp");
  assertNonBlank(row.createdBy, "reference creator");
}

function assertAuditEvent(value: unknown): void {
  const row = exactObject(
    value,
    [
      "ordinal",
      "occurredAt",
      "actor",
      "action",
      "target",
      "outcome",
      "details",
      "previousHash",
      "eventHash",
    ],
    "audit event",
  );
  assertInteger(row.ordinal, "audit ordinal");
  assertTimestamp(row.occurredAt, "audit timestamp");
  assertNonBlank(row.actor, "audit actor");
  assertNonBlank(row.target, "audit target");
  if (!isAuditAction(row.action) || !isAuditOutcome(row.outcome)) {
    throw new ArtifactStoreIntegrityError("audit action or outcome is invalid");
  }
  jsonObject(row.details, "audit details");
  assertArtifactHash(row.previousHash, "previous audit hash");
  assertArtifactHash(row.eventHash, "audit event hash");
}

function exactObject(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (!isObject(value) || !equalArtifactValues(Object.keys(value).sort(), [...keys].sort())) {
    throw new ArtifactStoreIntegrityError(`${label} fields are invalid`);
  }
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unknownArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new ArtifactStoreIntegrityError(`${label} must be an array`);
  return value;
}

function assertSortedUnique(values: readonly unknown[], label: string): void {
  for (let index = 0; index < values.length; index += 1) {
    const current = values[index];
    const previous = index > 0 ? values[index - 1] : undefined;
    if (
      typeof current !== "string" ||
      (index > 0 && (typeof previous !== "string" || previous >= current))
    ) {
      throw new ArtifactStoreIntegrityError(`${label} must be sorted unique strings`);
    }
  }
}

function jsonObject(value: unknown, label: string): ArtifactAuditDetails {
  if (!isObject(value)) throw new ArtifactStoreIntegrityError(`${label} must be an object`);
  const result: ArtifactAuditDetails = {};
  for (const [key, child] of Object.entries(value))
    result[key] = jsonValue(child, `${label}.${key}`);
  return result;
}

function jsonValue(value: unknown, label: string): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((item) => jsonValue(item, label));
  return jsonObject(value, label);
}

function assertTimestamp(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string") throw new ArtifactStoreIntegrityError(`${label} must be a string`);
  canonicalArtifactTimestamp(value, label);
}

function assertNonBlank(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string") throw new ArtifactStoreIntegrityError(`${label} must be a string`);
  nonBlankArtifactValue(value, label);
}

function assertInteger(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ArtifactStoreIntegrityError(`${label} must be a nonnegative integer`);
  }
}

function isAuditAction(value: unknown): value is ArtifactAuditAction {
  return (
    value === "put" ||
    value === "reference-add" ||
    value === "reference-remove" ||
    value === "retain" ||
    value === "prune" ||
    value === "read" ||
    value === "reference-resolve" ||
    value === "export" ||
    value === "audit"
  );
}

function isAuditOutcome(value: unknown): value is ArtifactAuditOutcome {
  return (
    value === "created" ||
    value === "already-present" ||
    value === "added" ||
    value === "removed" ||
    value === "retained" ||
    value === "pruned" ||
    value === "served" ||
    value === "resolved" ||
    value === "exported" ||
    value === "reviewed" ||
    value === "missing" ||
    value === "no-op" ||
    value === "denied" ||
    value === "rejected"
  );
}

function isRetentionBasis(value: unknown): value is ArtifactRetentionBasis {
  return (
    value === "lineage" ||
    value === "expiry" ||
    value === "release" ||
    value === "append-only" ||
    value === "declared-scope"
  );
}
