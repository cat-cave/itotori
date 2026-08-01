import {
  ArtifactStoreIntegrityError,
  artifactIdForBytes,
  assertArtifactHash,
  canonicalArtifactJson,
  canonicalArtifactTimestamp,
  copyArtifactAuditEvent,
  copyArtifactDescriptor,
  decodeArtifactBytes,
  decodeArtifactSnapshot,
  equalArtifactValues,
  genesisArtifactAuditHash,
  hashArtifactJson,
  immutableArtifactSnapshotVersion,
  nonBlankArtifactValue,
  sortedUniqueArtifactValues,
  type ArtifactAuditAction,
  type ArtifactAuditDetails,
  type ArtifactAuditEvent,
  type ArtifactAuditOutcome,
  type ArtifactDescriptor,
  type ArtifactReference,
  type ArtifactRetentionPolicy,
  type ImmutableArtifactSnapshot,
} from "./immutable-artifact-snapshot.js";
import {
  buildImmutableArtifactSnapshot,
  assertRestrictedArtifactDeadline,
  checkedArtifactAuthority,
  checkedArtifactRetention,
  equalArtifactBytes as equalBytes,
  type ArtifactActor,
  type ArtifactAuthority,
  type ArtifactCapability,
  type ArtifactPruneDecision,
  type ArtifactPruneReceipt,
  type ArtifactSnapshotExport,
  type StoredArtifactRecord,
} from "./immutable-artifact-store-support.js";

export {
  ArtifactStoreIntegrityError,
  artifactIdForBytes,
  immutableArtifactSnapshotVersion,
} from "./immutable-artifact-snapshot.js";
export type {
  ArtifactAuditAction,
  ArtifactAuditEvent,
  ArtifactAuditOutcome,
  ArtifactDescriptor,
  ArtifactReference,
  ArtifactRetentionBasis,
  ArtifactRetentionPolicy,
  ImmutableArtifactSnapshot,
} from "./immutable-artifact-snapshot.js";
export type {
  ArtifactActor,
  ArtifactAuthority,
  ArtifactCapability,
  ArtifactPruneDecision,
  ArtifactPruneReceipt,
  ArtifactSnapshotExport,
} from "./immutable-artifact-store-support.js";
export class ArtifactIdentityCollisionError extends ArtifactStoreIntegrityError {
  constructor(id: string) {
    super(`artifact identity collision rejected for ${id}`);
    this.name = "ArtifactIdentityCollisionError";
  }
}
export class ArtifactAuthorizationError extends Error {
  constructor(actor: string, capability: ArtifactCapability) {
    super(`actor ${actor} lacks ${capability}`);
    this.name = "ArtifactAuthorizationError";
  }
}
export class ImmutableArtifactStore {
  readonly #authority: ArtifactAuthority;
  readonly #artifacts: Map<string, StoredArtifactRecord>;
  readonly #references: Map<string, ArtifactReference>;
  readonly #audit: ArtifactAuditEvent[];

  private constructor(
    authority: ArtifactAuthority,
    artifacts = new Map<string, StoredArtifactRecord>(),
    references = new Map<string, ArtifactReference>(),
    audit: ArtifactAuditEvent[] = [],
  ) {
    this.#authority = checkedArtifactAuthority(authority);
    this.#artifacts = artifacts;
    this.#references = references;
    this.#audit = audit;
  }

  static create(authority: ArtifactAuthority): ImmutableArtifactStore {
    return new ImmutableArtifactStore(authority);
  }

  static reload(
    serialized: string,
    expectedSnapshotHash: string,
    authority: ArtifactAuthority,
  ): ImmutableArtifactStore {
    assertArtifactHash(expectedSnapshotHash, "expected snapshot identity");
    const value = decodeArtifactSnapshot(serialized);
    if (value.snapshotHash !== expectedSnapshotHash) {
      throw new ArtifactStoreIntegrityError(
        `artifact snapshot identity mismatch: expected ${expectedSnapshotHash}, received ${value.snapshotHash}`,
      );
    }
    const artifacts = new Map<string, StoredArtifactRecord>();
    for (const row of value.artifacts) {
      artifacts.set(row.artifactId, {
        ...copyArtifactDescriptor(row),
        bytes: decodeArtifactBytes(row.bytesBase64, row.artifactId),
      });
    }
    return new ImmutableArtifactStore(
      authority,
      artifacts,
      new Map(value.references.map((row) => [row.referenceId, { ...row }])),
      value.auditEvents.map(copyArtifactAuditEvent),
    );
  }

  put(input: {
    bytes: Uint8Array;
    retention: ArtifactRetentionPolicy;
    actor: ArtifactActor;
    at: string;
    expectedId?: string;
    parents?: readonly string[];
  }): ArtifactDescriptor {
    const at = canonicalArtifactTimestamp(input.at, "put timestamp");
    const bytes = new Uint8Array(input.bytes);
    const actualId = artifactIdForBytes(bytes);
    const target = input.expectedId ?? actualId;
    assertArtifactHash(target, "expected artifact identity");
    this.#authorize(input.actor, "artifact:write", "put", target, at);
    const collision = this.#artifacts.get(target);
    if (collision && !equalBytes(collision.bytes, bytes)) {
      this.#reject(at, input.actor.actorId, "put", target, "identity-collision");
      throw new ArtifactIdentityCollisionError(target);
    }
    if (target !== actualId) {
      this.#record(at, input.actor.actorId, "put", target, "rejected", {
        actualArtifactId: actualId,
        reason: "content-hash-mismatch",
      });
      throw new ArtifactStoreIntegrityError(`expected ${target}, received ${actualId}`);
    }
    const parents = sortedUniqueArtifactValues(input.parents ?? [], "artifact parents");
    for (const parent of parents) {
      assertArtifactHash(parent, "parent artifact identity");
      if (parent === target || !this.#artifacts.has(parent)) {
        this.#reject(at, input.actor.actorId, "put", target, "missing-or-self-parent");
        throw new ArtifactStoreIntegrityError(`artifact parent ${parent} is not available`);
      }
    }
    const retention = checkedArtifactRetention(input.retention, at);
    const existing = this.#artifacts.get(actualId);
    if (existing) {
      const same =
        equalArtifactValues(existing.parents, parents) &&
        canonicalArtifactJson(existing.retention) === canonicalArtifactJson(retention);
      if (!same) {
        this.#reject(at, input.actor.actorId, "put", target, "immutable-metadata-conflict");
        throw new ArtifactStoreIntegrityError(`artifact metadata cannot replace ${target}`);
      }
      this.#record(at, input.actor.actorId, "put", target, "already-present", {});
      return copyArtifactDescriptor(existing);
    }
    const stored: StoredArtifactRecord = {
      artifactId: target,
      byteLength: bytes.byteLength,
      parents,
      retention,
      createdAt: at,
      createdBy: input.actor.actorId,
      bytes,
    };
    this.#artifacts.set(target, stored);
    this.#record(at, input.actor.actorId, "put", target, "created", {
      basis: retention.basis,
      classification: retention.classification,
      expiresAt: retention.expiresAt,
      parents,
    });
    return copyArtifactDescriptor(stored);
  }

  addReference(input: {
    referenceId: string;
    artifactId: string;
    purpose: ArtifactReference["purpose"];
    actor: ArtifactActor;
    at: string;
  }): ArtifactReference {
    const at = canonicalArtifactTimestamp(input.at, "reference timestamp");
    const id = nonBlankArtifactValue(input.referenceId, "reference identity");
    assertArtifactHash(input.artifactId, "referenced artifact identity");
    this.#authorize(input.actor, "artifact:reference", "reference-add", id, at);
    const artifact = this.#artifacts.get(input.artifactId);
    if (!artifact) {
      this.#reject(at, input.actor.actorId, "reference-add", id, "missing-artifact");
      throw new ArtifactStoreIntegrityError(`artifact ${input.artifactId} is missing`);
    }
    if (
      input.purpose === "release" &&
      (artifact.retention.basis !== "release" || artifact.retention.classification !== "public")
    ) {
      this.#reject(at, input.actor.actorId, "reference-add", id, "invalid-release-policy");
      throw new ArtifactStoreIntegrityError(`artifact ${input.artifactId} is not releasable`);
    }
    const existing = this.#references.get(id);
    if (existing) {
      if (existing.artifactId !== input.artifactId || existing.purpose !== input.purpose) {
        this.#reject(at, input.actor.actorId, "reference-add", id, "reference-conflict");
        throw new ArtifactStoreIntegrityError(`reference ${id} cannot be replaced`);
      }
      this.#record(at, input.actor.actorId, "reference-add", id, "already-present", {
        artifactId: input.artifactId,
        purpose: input.purpose,
      });
      return { ...existing };
    }
    const reference = {
      referenceId: id,
      artifactId: input.artifactId,
      purpose: input.purpose,
      createdAt: at,
      createdBy: input.actor.actorId,
    };
    this.#references.set(id, reference);
    this.#record(at, input.actor.actorId, "reference-add", id, "added", {
      artifactId: input.artifactId,
      purpose: input.purpose,
    });
    return { ...reference };
  }

  removeReference(input: { referenceId: string; actor: ArtifactActor; at: string }): void {
    const at = canonicalArtifactTimestamp(input.at, "reference removal timestamp");
    const id = nonBlankArtifactValue(input.referenceId, "reference identity");
    this.#authorize(input.actor, "artifact:reference", "reference-remove", id, at);
    const reference = this.#references.get(id);
    if (!reference) {
      this.#reject(at, input.actor.actorId, "reference-remove", id, "missing-reference");
      throw new ArtifactStoreIntegrityError(`reference ${id} is missing`);
    }
    this.#references.delete(id);
    this.#record(at, input.actor.actorId, "reference-remove", id, "removed", {
      artifactId: reference.artifactId,
    });
  }

  retain(input: { artifactId: string; until: string; actor: ArtifactActor; at: string }): void {
    const at = canonicalArtifactTimestamp(input.at, "retention timestamp");
    const until = canonicalArtifactTimestamp(input.until, "retention deadline");
    assertArtifactHash(input.artifactId, "retained artifact identity");
    this.#authorize(input.actor, "artifact:retain", "retain", input.artifactId, at);
    const artifact = this.#artifacts.get(input.artifactId);
    if (!artifact || until <= at || until <= artifact.retention.expiresAt) {
      this.#reject(at, input.actor.actorId, "retain", input.artifactId, "invalid-extension");
      throw new ArtifactStoreIntegrityError(`artifact ${input.artifactId} cannot be retained`);
    }
    assertRestrictedArtifactDeadline(
      { ...artifact.retention, expiresAt: until },
      artifact.createdAt,
    );
    const previousExpiresAt = artifact.retention.expiresAt;
    artifact.retention = { ...artifact.retention, expiresAt: until };
    this.#record(at, input.actor.actorId, "retain", input.artifactId, "retained", {
      expiresAt: until,
      previousExpiresAt,
    });
  }

  prune(input: {
    scope: readonly string[];
    actor: ArtifactActor;
    at: string;
  }): ArtifactPruneReceipt {
    const at = canonicalArtifactTimestamp(input.at, "prune timestamp");
    const ids = sortedUniqueArtifactValues(input.scope, "prune scope");
    for (const id of ids) assertArtifactHash(id, "prune target");
    const target = `prune-scope:${hashArtifactJson(ids)}`;
    this.#authorize(input.actor, "artifact:prune", "prune", target, at, {
      requestedArtifactIds: ids,
    });
    const scheduled = new Set(ids.filter((id) => this.#eligible(id, at)));
    let changed = true;
    while (changed) {
      changed = false;
      for (const id of scheduled) {
        if (this.#dependents(id).some((child) => !scheduled.has(child))) {
          scheduled.delete(id);
          changed = true;
        }
      }
    }
    const decisions = ids.map((id): ArtifactPruneDecision => {
      const artifact = this.#artifacts.get(id);
      if (!artifact) return { artifactId: id, decision: "missing" };
      if (scheduled.has(id)) return { artifactId: id, decision: "pruned" };
      if (artifact.retention.expiresAt > at) return { artifactId: id, decision: "not-expired" };
      if (this.#referenced(id)) return { artifactId: id, decision: "referenced" };
      return { artifactId: id, decision: "lineage-dependent" };
    });
    const prunedArtifactIds = [...scheduled].sort();
    for (const id of prunedArtifactIds) this.#artifacts.delete(id);
    const event = this.#record(
      at,
      input.actor.actorId,
      "prune",
      target,
      prunedArtifactIds.length ? "pruned" : "no-op",
      { decisions: decisions.map((row) => ({ ...row })), requestedArtifactIds: ids },
    );
    return {
      requestedArtifactIds: [...ids],
      decisions: decisions.map((row) => ({ ...row })),
      prunedArtifactIds,
      auditEventHash: event.eventHash,
    };
  }

  availability(input: {
    artifactId: string;
    actor: ArtifactActor;
    at: string;
  }):
    | { artifactId: string; status: "available"; byteLength: number }
    | { artifactId: string; status: "missing" } {
    const at = canonicalArtifactTimestamp(input.at, "availability timestamp");
    assertArtifactHash(input.artifactId, "artifact identity");
    this.#authorize(input.actor, "artifact:read", "read", input.artifactId, at, {
      metadataOnly: true,
    });
    const artifact = this.#artifacts.get(input.artifactId);
    return artifact
      ? { artifactId: input.artifactId, status: "available", byteLength: artifact.byteLength }
      : { artifactId: input.artifactId, status: "missing" };
  }

  read(input: { artifactId: string; actor: ArtifactActor; at: string }): Uint8Array | undefined {
    const at = canonicalArtifactTimestamp(input.at, "read timestamp");
    assertArtifactHash(input.artifactId, "artifact identity");
    this.#authorize(input.actor, "artifact:read", "read", input.artifactId, at);
    const bytes = this.#artifacts.get(input.artifactId)?.bytes;
    this.#record(
      at,
      input.actor.actorId,
      "read",
      input.artifactId,
      bytes ? "served" : "missing",
      bytes ? { byteLength: bytes.byteLength } : {},
    );
    return bytes ? new Uint8Array(bytes) : undefined;
  }

  describe(input: {
    artifactId: string;
    actor: ArtifactActor;
    at: string;
  }): ArtifactDescriptor | undefined {
    const at = canonicalArtifactTimestamp(input.at, "description timestamp");
    assertArtifactHash(input.artifactId, "artifact identity");
    this.#authorize(input.actor, "artifact:read", "read", input.artifactId, at, {
      metadataOnly: true,
    });
    const artifact = this.#artifacts.get(input.artifactId);
    return artifact ? copyArtifactDescriptor(artifact) : undefined;
  }

  resolveReference(input: {
    referenceId: string;
    actor: ArtifactActor;
    at: string;
  }): ArtifactReference | undefined {
    const at = canonicalArtifactTimestamp(input.at, "reference resolution timestamp");
    const id = nonBlankArtifactValue(input.referenceId, "reference identity");
    this.#authorize(input.actor, "artifact:read", "reference-resolve", id, at);
    const reference = this.#references.get(id);
    this.#record(
      at,
      input.actor.actorId,
      "reference-resolve",
      id,
      reference ? "resolved" : "missing",
      reference
        ? {
            artifactId: reference.artifactId,
            createdAt: reference.createdAt,
            createdBy: reference.createdBy,
            purpose: reference.purpose,
          }
        : {},
    );
    return reference ? { ...reference } : undefined;
  }

  auditTrail(input: { actor: ArtifactActor; at: string }): readonly ArtifactAuditEvent[] {
    const at = canonicalArtifactTimestamp(input.at, "audit review timestamp");
    this.#authorize(input.actor, "artifact:audit", "audit", "audit-trail", at);
    this.#record(at, input.actor.actorId, "audit", "audit-trail", "reviewed", {});
    return this.#audit.map(copyArtifactAuditEvent);
  }

  exportSnapshot(input: { actor: ArtifactActor; at: string }): ArtifactSnapshotExport {
    const at = canonicalArtifactTimestamp(input.at, "artifact export timestamp");
    this.#authorize(input.actor, "artifact:export", "export", "artifact-snapshot", at);
    this.#record(at, input.actor.actorId, "export", "artifact-snapshot", "exported", {});
    const snapshot = this.#snapshot();
    return {
      serialized: `${JSON.stringify(snapshot, null, 2)}\n`,
      snapshotHash: snapshot.snapshotHash,
    };
  }

  #snapshot(): ImmutableArtifactSnapshot {
    return buildImmutableArtifactSnapshot(
      this.#artifacts.values(),
      this.#references.values(),
      this.#audit,
    );
  }

  #authorize(
    actor: ArtifactActor,
    capability: ArtifactCapability,
    action: ArtifactAuditAction,
    target: string,
    at: string,
    details: ArtifactAuditDetails = {},
  ): void {
    const actorId = nonBlankArtifactValue(actor.actorId, "audit actor");
    this.#chronological(at);
    if (this.#authority.hasCapability({ actorId }, capability) !== true) {
      this.#record(at, actorId, action, target, "denied", {
        ...details,
        requiredCapability: capability,
      });
      throw new ArtifactAuthorizationError(actorId, capability);
    }
  }

  #reject(
    at: string,
    actor: string,
    action: ArtifactAuditAction,
    target: string,
    reason: string,
  ): void {
    this.#record(at, actor, action, target, "rejected", { reason });
  }

  #record(
    occurredAt: string,
    actor: string,
    action: ArtifactAuditAction,
    target: string,
    outcome: ArtifactAuditOutcome,
    details: ArtifactAuditDetails,
  ): ArtifactAuditEvent {
    this.#chronological(occurredAt);
    const base = {
      ordinal: this.#audit.length,
      occurredAt,
      actor: nonBlankArtifactValue(actor, "audit actor"),
      action,
      target: nonBlankArtifactValue(target, "audit target"),
      outcome,
      details: structuredClone(details),
      previousHash: this.#audit.at(-1)?.eventHash ?? genesisArtifactAuditHash,
    };
    const event = { ...base, eventHash: hashArtifactJson(base) };
    this.#audit.push(event);
    return copyArtifactAuditEvent(event);
  }

  #chronological(at: string): void {
    const previous = this.#audit.at(-1)?.occurredAt;
    if (previous !== undefined && at < previous) {
      throw new ArtifactStoreIntegrityError(`audit timestamp ${at} precedes ${previous}`);
    }
  }
  #referenced(id: string): boolean {
    return [...this.#references.values()].some((reference) => reference.artifactId === id);
  }
  #dependents(id: string): string[] {
    return [...this.#artifacts.values()]
      .filter((artifact) => artifact.parents.includes(id))
      .map((artifact) => artifact.artifactId);
  }

  #eligible(id: string, at: string): boolean {
    const artifact = this.#artifacts.get(id);
    return artifact !== undefined && artifact.retention.expiresAt <= at && !this.#referenced(id);
  }
}
