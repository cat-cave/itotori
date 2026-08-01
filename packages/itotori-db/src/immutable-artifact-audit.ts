import {
  ArtifactStoreIntegrityError,
  assertArtifactHash,
  canonicalArtifactJson,
  equalArtifactValues,
  hashArtifactJson,
  type ArtifactAuditEvent,
  type ArtifactDescriptor,
  type ArtifactReference,
  type ArtifactRetentionBasis,
  type ArtifactRetentionPolicy,
  type ImmutableArtifactSnapshot,
} from "./immutable-artifact-snapshot.js";
import { validateArtifactAuditEventContract } from "./immutable-artifact-audit-contract.js";

type ReplayArtifact = Omit<ArtifactDescriptor, "artifactId" | "byteLength">;
type PruneDecision = {
  artifactId: string;
  decision: "pruned" | "not-expired" | "referenced" | "lineage-dependent" | "missing";
};

/** Replays authenticated history and requires exact retained metadata and policy decisions. */
export function validateAuditedArtifactState(snapshot: ImmutableArtifactSnapshot): void {
  const artifacts = new Map<string, ReplayArtifact>();
  const references = new Map<string, ArtifactReference>();
  for (const event of snapshot.auditEvents) {
    validateArtifactAuditEventContract(event);
    replayEvent(event, artifacts, references);
  }
  const snapshotIds = snapshot.artifacts.map((row) => row.artifactId);
  if (!equalArtifactValues([...artifacts.keys()].sort(), snapshotIds)) {
    fail("audit does not reproduce artifact state");
  }
  for (const row of snapshot.artifacts) {
    const { artifactId, byteLength, bytesBase64, ...metadata } = row;
    if (
      artifactId.length === 0 ||
      byteLength < 0 ||
      typeof bytesBase64 !== "string" ||
      canonicalArtifactJson(artifacts.get(row.artifactId)) !== canonicalArtifactJson(metadata)
    ) {
      fail("audit does not reproduce artifact metadata");
    }
  }
  const actualReferences = [...references.values()].sort((left, right) =>
    left.referenceId.localeCompare(right.referenceId),
  );
  if (canonicalArtifactJson(actualReferences) !== canonicalArtifactJson(snapshot.references)) {
    fail("audit does not reproduce reference state");
  }
}

function replayEvent(
  event: ArtifactAuditEvent,
  artifacts: Map<string, ReplayArtifact>,
  references: Map<string, ArtifactReference>,
): void {
  if (event.action === "put" && event.outcome === "created") {
    if (artifacts.has(event.target)) fail("duplicate artifact creation");
    const parents = detailStrings(event, "parents");
    if (parents.some((parent) => !artifacts.has(parent))) {
      fail("audit creates invalid artifact lineage");
    }
    const retention = createdRetention(event);
    artifacts.set(event.target, {
      parents,
      retention,
      createdAt: event.occurredAt,
      createdBy: event.actor,
    });
    return;
  }
  if (event.action === "put" && event.outcome === "already-present") {
    if (!artifacts.has(event.target)) fail("audit repeats missing bytes");
    return;
  }
  if (
    event.action === "put" &&
    event.outcome === "rejected" &&
    event.details.reason === "identity-collision"
  ) {
    const variant = event.details.actualArtifactId;
    if (typeof variant !== "string") return;
    if (variant === event.target || !artifacts.has(event.target) || !artifacts.has(variant)) {
      fail("audit collision does not preserve both variants");
    }
    return;
  }
  if (event.action === "retain" && event.outcome === "retained") {
    const artifact = artifacts.get(event.target);
    if (!artifact) fail("audit retains missing bytes");
    const previous = detailString(event, "previousExpiresAt");
    const expiresAt = detailString(event, "expiresAt");
    if (
      artifact.retention.expiresAt !== previous ||
      expiresAt <= previous ||
      expiresAt <= event.occurredAt
    ) {
      fail("audit retention history is not a monotonic extension");
    }
    artifact.retention.expiresAt = expiresAt;
    return;
  }
  if (event.action === "reference-add" && event.outcome === "added") {
    replayReferenceAdd(event, artifacts, references);
    return;
  }
  if (event.action === "reference-add" && event.outcome === "already-present") {
    const reference = references.get(event.target);
    if (
      reference?.artifactId !== detailString(event, "artifactId") ||
      reference.purpose !== detailReferencePurpose(event, "purpose")
    ) {
      fail("audit repeats a different artifact reference");
    }
    return;
  }
  if (event.action === "reference-remove" && event.outcome === "removed") {
    const reference = references.get(event.target);
    if (!reference || reference.artifactId !== detailString(event, "artifactId")) {
      fail("audit removes a missing or different artifact reference");
    }
    references.delete(event.target);
    return;
  }
  if (event.action === "reference-resolve") {
    replayReferenceResolution(event, references);
    return;
  }
  if (event.action === "read" && event.outcome === "served" && !artifacts.has(event.target)) {
    fail("audit serves missing artifact bytes");
  }
  if (event.action === "read" && event.outcome === "missing" && artifacts.has(event.target)) {
    fail("audit reports available artifact bytes as missing");
  }
  if (event.action === "prune" && (event.outcome === "pruned" || event.outcome === "no-op")) {
    replayPrune(event, artifacts, references);
  }
}

function replayReferenceAdd(
  event: ArtifactAuditEvent,
  artifacts: Map<string, ReplayArtifact>,
  references: Map<string, ArtifactReference>,
): void {
  const artifactId = detailString(event, "artifactId");
  const artifact = artifacts.get(artifactId);
  const purpose = detailReferencePurpose(event, "purpose");
  if (
    !artifact ||
    references.has(event.target) ||
    (purpose === "release" &&
      (artifact.retention.basis !== "release" || artifact.retention.classification !== "public"))
  ) {
    fail("audit adds an invalid artifact reference");
  }
  references.set(event.target, {
    referenceId: event.target,
    artifactId,
    purpose,
    createdAt: event.occurredAt,
    createdBy: event.actor,
  });
}

function replayReferenceResolution(
  event: ArtifactAuditEvent,
  references: Map<string, ArtifactReference>,
): void {
  if (event.outcome === "missing") {
    if (references.has(event.target)) fail("audit reports an available reference as missing");
    return;
  }
  if (event.outcome !== "resolved") return;
  const reference = references.get(event.target);
  if (
    reference === undefined ||
    reference.artifactId !== detailString(event, "artifactId") ||
    reference.purpose !== detailReferencePurpose(event, "purpose") ||
    reference.createdAt !== detailString(event, "createdAt") ||
    reference.createdBy !== detailString(event, "createdBy")
  ) {
    fail("audit resolves a missing or different artifact reference");
  }
}

function replayPrune(
  event: ArtifactAuditEvent,
  artifacts: Map<string, ReplayArtifact>,
  references: Map<string, ArtifactReference>,
): void {
  const requested = detailHashes(event, "requestedArtifactIds");
  const decisions = detailPruneDecisions(event);
  if (
    event.target !== `prune-scope:${hashArtifactJson(requested)}` ||
    decisions.length !== requested.length ||
    decisions.some((row, index) => row.artifactId !== requested[index])
  ) {
    fail("audit prune scope is invalid");
  }
  const scheduled = new Set(
    requested.filter((id) => eligibleForPrune(id, event.occurredAt, artifacts, references)),
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of scheduled) {
      const outsideDependent = [...artifacts].some(
        ([candidate, artifact]) => !scheduled.has(candidate) && artifact.parents.includes(id),
      );
      if (outsideDependent) {
        scheduled.delete(id);
        changed = true;
      }
    }
  }
  const expected = requested.map((artifactId) => ({
    artifactId,
    decision: pruneDecision(artifactId, event.occurredAt, scheduled, artifacts, references),
  }));
  if (
    canonicalArtifactJson(expected) !== canonicalArtifactJson(decisions) ||
    (scheduled.size > 0 ? event.outcome !== "pruned" : event.outcome !== "no-op")
  ) {
    fail("audit prune decisions do not reproduce exact eligibility");
  }
  for (const id of scheduled) artifacts.delete(id);
}

function eligibleForPrune(
  id: string,
  at: string,
  artifacts: Map<string, ReplayArtifact>,
  references: Map<string, ArtifactReference>,
): boolean {
  const artifact = artifacts.get(id);
  return (
    artifact !== undefined &&
    artifact.retention.expiresAt <= at &&
    !artifactIsReferenced(id, references)
  );
}

function artifactIsReferenced(id: string, references: Map<string, ArtifactReference>): boolean {
  return [...references.values()].some((reference) => reference.artifactId === id);
}

function pruneDecision(
  id: string,
  at: string,
  scheduled: Set<string>,
  artifacts: Map<string, ReplayArtifact>,
  references: Map<string, ArtifactReference>,
): PruneDecision["decision"] {
  const artifact = artifacts.get(id);
  if (!artifact) return "missing";
  if (scheduled.has(id)) return "pruned";
  if (artifact.retention.expiresAt > at) return "not-expired";
  if (artifactIsReferenced(id, references)) return "referenced";
  return "lineage-dependent";
}

function createdRetention(event: ArtifactAuditEvent): ArtifactRetentionPolicy {
  const classification = detailClassification(event, "classification");
  const basis = detailRetentionBasis(event, "basis");
  const expiresAt = detailString(event, "expiresAt");
  if (expiresAt <= event.occurredAt || (basis === "release" && classification !== "public")) {
    fail("audit creates an invalid retention policy");
  }
  return { classification, basis, expiresAt };
}

function detailString(event: ArtifactAuditEvent, key: string): string {
  const value = event.details[key];
  if (typeof value !== "string") fail(`audit event ${event.ordinal} lacks ${key}`);
  return value;
}

function detailStrings(event: ArtifactAuditEvent, key: string): string[] {
  const value = event.details[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    fail(`audit event ${event.ordinal} has invalid ${key}`);
  }
  return value.map(String);
}

function detailHashes(event: ArtifactAuditEvent, key: string): string[] {
  const values = detailStrings(event, key);
  for (const value of values) assertArtifactHash(value, `audit ${key} identity`);
  if (!equalArtifactValues(values, [...values].sort()) || new Set(values).size !== values.length) {
    fail(`audit event ${event.ordinal} has unsorted or duplicate ${key}`);
  }
  return values;
}

function detailPruneDecisions(event: ArtifactAuditEvent): PruneDecision[] {
  const value = event.details.decisions;
  if (!Array.isArray(value)) fail("prune decisions are invalid");
  return value.map((item) => {
    if (
      !isRecord(item) ||
      !equalArtifactValues(Object.keys(item).sort(), ["artifactId", "decision"])
    ) {
      fail("prune decision fields are invalid");
    }
    assertArtifactHash(item.artifactId, "prune decision artifact identity");
    if (!isPruneDecision(item.decision)) fail("prune decision is invalid");
    return { artifactId: item.artifactId, decision: item.decision };
  });
}

function detailClassification(
  event: ArtifactAuditEvent,
  key: string,
): ArtifactRetentionPolicy["classification"] {
  const value = detailString(event, key);
  if (value !== "public" && value !== "restricted") fail(`invalid ${key}`);
  return value;
}

function detailRetentionBasis(event: ArtifactAuditEvent, key: string): ArtifactRetentionBasis {
  const value = detailString(event, key);
  if (!isRetentionBasis(value)) fail(`invalid ${key}`);
  return value;
}

function detailReferencePurpose(
  event: ArtifactAuditEvent,
  key: string,
): ArtifactReference["purpose"] {
  const value = detailString(event, key);
  if (value !== "lineage" && value !== "release") fail(`invalid ${key}`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPruneDecision(value: unknown): value is PruneDecision["decision"] {
  return (
    value === "pruned" ||
    value === "not-expired" ||
    value === "referenced" ||
    value === "lineage-dependent" ||
    value === "missing"
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

function fail(message: string): never {
  throw new ArtifactStoreIntegrityError(message);
}
