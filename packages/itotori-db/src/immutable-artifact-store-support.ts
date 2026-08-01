import { timingSafeEqual } from "node:crypto";

import {
  ArtifactStoreIntegrityError,
  canonicalArtifactTimestamp,
  copyArtifactAuditEvent,
  copyArtifactDescriptor,
  genesisArtifactAuditHash,
  hashArtifactJson,
  immutableArtifactSnapshotVersion,
  type ArtifactAuditEvent,
  type ArtifactDescriptor,
  type ArtifactReference,
  type ArtifactRetentionBasis,
  type ArtifactRetentionPolicy,
  type ImmutableArtifactSnapshot,
} from "./immutable-artifact-snapshot.js";

export type StoredArtifactRecord = ArtifactDescriptor & { bytes: Uint8Array };
export type ArtifactCapability =
  | "artifact:write"
  | "artifact:read"
  | "artifact:reference"
  | "artifact:retain"
  | "artifact:prune"
  | "artifact:export"
  | "artifact:audit";
export type ArtifactActor = { readonly actorId: string };
export type ArtifactAuthority = {
  hasCapability(actor: ArtifactActor, capability: ArtifactCapability): boolean;
};
export type ArtifactSnapshotExport = { serialized: string; snapshotHash: string };
export type ArtifactPruneDecision = {
  artifactId: string;
  decision: "pruned" | "not-expired" | "referenced" | "lineage-dependent" | "missing";
};
export type ArtifactPruneReceipt = {
  requestedArtifactIds: readonly string[];
  decisions: readonly ArtifactPruneDecision[];
  prunedArtifactIds: readonly string[];
  auditEventHash: string;
};

export const restrictedArtifactMaximumRetentionMs = 365 * 24 * 60 * 60 * 1_000;

export function checkedArtifactAuthority(value: unknown): ArtifactAuthority {
  if (!isArtifactAuthority(value)) {
    throw new ArtifactStoreIntegrityError("artifact authority is required");
  }
  return value;
}

function isArtifactAuthority(value: unknown): value is ArtifactAuthority {
  return (
    typeof value === "object" &&
    value !== null &&
    "hasCapability" in value &&
    typeof value.hasCapability === "function"
  );
}

export function buildImmutableArtifactSnapshot(
  artifacts: Iterable<StoredArtifactRecord>,
  references: Iterable<ArtifactReference>,
  audit: readonly ArtifactAuditEvent[],
): ImmutableArtifactSnapshot {
  const snapshotArtifacts = [...artifacts]
    .sort((left, right) => left.artifactId.localeCompare(right.artifactId))
    .map((row) => ({
      ...copyArtifactDescriptor(row),
      bytesBase64: Buffer.from(row.bytes).toString("base64"),
    }));
  const snapshotReferences = [...references]
    .sort((left, right) => left.referenceId.localeCompare(right.referenceId))
    .map((row) => ({ ...row }));
  const auditEvents = audit.map(copyArtifactAuditEvent);
  const body = {
    schemaVersion: immutableArtifactSnapshotVersion,
    artifacts: snapshotArtifacts,
    references: snapshotReferences,
    auditEvents,
    auditLength: auditEvents.length,
    auditHead: auditEvents.at(-1)?.eventHash ?? genesisArtifactAuditHash,
  };
  return { ...body, snapshotHash: hashArtifactJson(body) };
}

export function checkedArtifactRetention(
  value: ArtifactRetentionPolicy,
  at: string,
): ArtifactRetentionPolicy {
  if (value.classification !== "public" && value.classification !== "restricted") {
    throw new ArtifactStoreIntegrityError("retention classification is invalid");
  }
  const expiresAt = canonicalArtifactTimestamp(value.expiresAt, "retention deadline");
  if (expiresAt <= at) {
    throw new ArtifactStoreIntegrityError("retention deadline must be future");
  }
  const basis: ArtifactRetentionBasis = value.basis;
  if (
    basis !== "lineage" &&
    basis !== "expiry" &&
    basis !== "release" &&
    basis !== "append-only" &&
    basis !== "declared-scope"
  ) {
    throw new ArtifactStoreIntegrityError("retention basis is invalid");
  }
  if (basis === "release" && value.classification !== "public") {
    throw new ArtifactStoreIntegrityError("release retention must be public");
  }
  const retention = { classification: value.classification, expiresAt, basis };
  assertRestrictedArtifactDeadline(retention, at);
  return retention;
}

export function assertRestrictedArtifactDeadline(
  retention: ArtifactRetentionPolicy,
  createdAt: string,
): void {
  if (
    retention.classification === "restricted" &&
    new Date(retention.expiresAt).getTime() - new Date(createdAt).getTime() >
      restrictedArtifactMaximumRetentionMs
  ) {
    throw new ArtifactStoreIntegrityError("restricted retention exceeds the 365-day maximum");
  }
}

export function equalArtifactBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}
