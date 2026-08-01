import { timingSafeEqual } from "node:crypto";

import {
  ArtifactStoreIntegrityError,
  assertArtifactHash,
  canonicalArtifactTimestamp,
  copyArtifactAuditEvent,
  copyArtifactDescriptor,
  decodeArtifactBytes,
  decodeArtifactSnapshot,
  genesisArtifactAuditHash,
  hashArtifactJson,
  immutableArtifactSnapshotVersion,
  nonBlankArtifactValue,
  type ArtifactAuditAction,
  type ArtifactAuditDetails,
  type ArtifactAuditEvent,
  type ArtifactAuditOutcome,
  type ArtifactDescriptor,
  type ArtifactReference,
  type ArtifactRetentionBasis,
  type ArtifactRetentionPolicy,
  type ImmutableArtifactSnapshot,
} from "./immutable-artifact-snapshot.js";
import { artifactCollisionPrimaryByVariant } from "./immutable-artifact-store-collision.js";
import {
  artifactDependents,
  artifactIsEligibleForPrune,
  artifactIsReferenced,
} from "./immutable-artifact-store-primitives.js";

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

export function loadImmutableArtifactStoreState(serialized: string, expectedSnapshotHash: string) {
  assertArtifactHash(expectedSnapshotHash, "expected snapshot identity");
  const snapshot = decodeArtifactSnapshot(serialized);
  if (snapshot.snapshotHash !== expectedSnapshotHash) {
    throw new ArtifactStoreIntegrityError(
      `artifact snapshot identity mismatch: expected ${expectedSnapshotHash}, received ${snapshot.snapshotHash}`,
    );
  }
  const collisionPrimaryByVariant = artifactCollisionPrimaryByVariant(snapshot.auditEvents);
  if (collisionPrimaryByVariant === undefined) {
    throw new ArtifactStoreIntegrityError("collision variant has conflicting primaries");
  }
  return {
    artifacts: new Map(
      snapshot.artifacts.map((row) => [
        row.artifactId,
        {
          ...copyArtifactDescriptor(row),
          bytes: decodeArtifactBytes(row.bytesBase64, row.artifactId),
        },
      ]),
    ),
    references: new Map(snapshot.references.map((row) => [row.referenceId, { ...row }])),
    audit: snapshot.auditEvents.map(copyArtifactAuditEvent),
    collisionPrimaryByVariant,
  };
}

export function appendImmutableArtifactAuditEvent(
  audit: ArtifactAuditEvent[],
  occurredAt: string,
  actor: string,
  action: ArtifactAuditAction,
  target: string,
  outcome: ArtifactAuditOutcome,
  details: ArtifactAuditDetails,
): ArtifactAuditEvent {
  const previous = audit.at(-1);
  if (previous !== undefined && occurredAt < previous.occurredAt) {
    throw new ArtifactStoreIntegrityError(
      `audit timestamp ${occurredAt} precedes ${previous.occurredAt}`,
    );
  }
  const base = {
    ordinal: audit.length,
    occurredAt,
    actor: nonBlankArtifactValue(actor, "audit actor"),
    action,
    target: nonBlankArtifactValue(target, "audit target"),
    outcome,
    details: structuredClone(details),
    previousHash: previous?.eventHash ?? genesisArtifactAuditHash,
  };
  const event = { ...base, eventHash: hashArtifactJson(base) };
  audit.push(event);
  return copyArtifactAuditEvent(event);
}

export function pruneImmutableArtifactScope(
  artifacts: Map<string, StoredArtifactRecord>,
  references: ReadonlyMap<string, ArtifactReference>,
  ids: readonly string[],
  at: string,
  record: (
    target: string,
    outcome: "pruned" | "no-op",
    details: ArtifactAuditDetails,
  ) => ArtifactAuditEvent,
): ArtifactPruneReceipt {
  const scheduled = new Set(
    ids.filter((id) => artifactIsEligibleForPrune(artifacts, references, id, at)),
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of scheduled) {
      if (artifactDependents(artifacts, id).some((child) => !scheduled.has(child))) {
        scheduled.delete(id);
        changed = true;
      }
    }
  }
  const decisions = ids.map((artifactId): ArtifactPruneDecision => {
    const artifact = artifacts.get(artifactId);
    if (!artifact) return { artifactId, decision: "missing" };
    if (scheduled.has(artifactId)) return { artifactId, decision: "pruned" };
    if (artifact.retention.expiresAt > at) return { artifactId, decision: "not-expired" };
    if (artifactIsReferenced(references, artifactId)) return { artifactId, decision: "referenced" };
    return { artifactId, decision: "lineage-dependent" };
  });
  const prunedArtifactIds = [...scheduled].sort();
  for (const id of prunedArtifactIds) artifacts.delete(id);
  const requestedArtifactIds = [...ids];
  const event = record(
    `prune-scope:${hashArtifactJson(requestedArtifactIds)}`,
    prunedArtifactIds.length ? "pruned" : "no-op",
    { decisions: decisions.map((row) => ({ ...row })), requestedArtifactIds },
  );
  return {
    requestedArtifactIds,
    decisions: decisions.map((row) => ({ ...row })),
    prunedArtifactIds,
    auditEventHash: event.eventHash,
  };
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
