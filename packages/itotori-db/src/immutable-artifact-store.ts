import {
  ArtifactStoreIntegrityError,
  artifactIdForBytes,
  assertArtifactHash,
  canonicalArtifactJson,
  canonicalArtifactTimestamp,
  copyArtifactAuditEvent,
  copyArtifactDescriptor,
  equalArtifactValues,
  hashArtifactJson,
  nonBlankArtifactValue,
  sortedUniqueArtifactValues,
  type ArtifactAuditAction,
  type ArtifactAuditDetails,
  type ArtifactAuditEvent,
  type ArtifactAuditOutcome,
  type ArtifactDescriptor,
  type ArtifactReference,
  type ArtifactRetentionPolicy,
} from "./immutable-artifact-snapshot.js";
import { artifactCollisionVariantIdForBytes } from "./immutable-artifact-store-collision.js";
import {
  appendImmutableArtifactAuditEvent,
  buildImmutableArtifactSnapshot,
  assertRestrictedArtifactDeadline,
  checkedArtifactAuthority,
  checkedArtifactRetention,
  equalArtifactBytes,
  loadImmutableArtifactStoreState,
  pruneImmutableArtifactScope,
  type ArtifactActor,
  type ArtifactAuthority,
  type ArtifactCapability,
  type ArtifactPruneDecision,
  type ArtifactPruneReceipt,
  type ArtifactSnapshotExport,
  type StoredArtifactRecord,
} from "./immutable-artifact-store-support.js";
import {
  ArtifactAuthorizationError,
  ArtifactIdentityCollisionError,
  assertArtifactAuditChronological,
} from "./immutable-artifact-store-primitives.js";

type ArtifactPutInput = {
  bytes: Uint8Array;
  retention: ArtifactRetentionPolicy;
  actor: ArtifactActor;
  at: string;
  expectedId?: string;
  parents?: readonly string[];
};

type ArtifactPrimaryHashForTesting = (bytes: Uint8Array) => string;

export {
  ArtifactIncompatibleVersionError,
  ArtifactStoreIntegrityError,
  assertImmutableArtifactFormatVersion,
  artifactIdForBytes,
  immutableArtifactFormatVersion,
  immutableArtifactSnapshotVersion,
} from "./immutable-artifact-snapshot.js";
export { artifactCollisionVariantIdForBytes } from "./immutable-artifact-store-collision.js";
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
export {
  ArtifactAuthorizationError,
  ArtifactIdentityCollisionError,
} from "./immutable-artifact-store-primitives.js";

export class ImmutableArtifactStore {
  readonly #authority: ArtifactAuthority;
  readonly #artifacts: Map<string, StoredArtifactRecord>;
  readonly #references: Map<string, ArtifactReference>;
  readonly #audit: ArtifactAuditEvent[];
  readonly #collisionPrimaryByVariant: Map<string, string>;
  readonly #primaryHashForBytes: ArtifactPrimaryHashForTesting;

  private constructor(
    authority: ArtifactAuthority,
    artifacts = new Map<string, StoredArtifactRecord>(),
    references = new Map<string, ArtifactReference>(),
    audit: ArtifactAuditEvent[] = [],
    collisionPrimaryByVariant = new Map<string, string>(),
    primaryHashForBytes: ArtifactPrimaryHashForTesting = artifactIdForBytes,
  ) {
    this.#authority = checkedArtifactAuthority(authority);
    this.#artifacts = artifacts;
    this.#references = references;
    this.#audit = audit;
    this.#collisionPrimaryByVariant = collisionPrimaryByVariant;
    this.#primaryHashForBytes = primaryHashForBytes;
  }

  static create(authority: ArtifactAuthority): ImmutableArtifactStore {
    return new ImmutableArtifactStore(authority);
  }

  /** Test-only seam: only a later candidate may share the first artifact's primary hash. */
  static createForTesting(
    authority: ArtifactAuthority,
    primaryHashForBytes: ArtifactPrimaryHashForTesting,
  ): ImmutableArtifactStore {
    return new ImmutableArtifactStore(
      authority,
      new Map(),
      new Map(),
      [],
      new Map(),
      primaryHashForBytes,
    );
  }

  static reload(
    serialized: string,
    expectedSnapshotHash: string,
    authority: ArtifactAuthority,
  ): ImmutableArtifactStore {
    const state = loadImmutableArtifactStoreState(serialized, expectedSnapshotHash);
    return new ImmutableArtifactStore(
      authority,
      state.artifacts,
      state.references,
      state.audit,
      state.collisionPrimaryByVariant,
    );
  }

  put(input: ArtifactPutInput): ArtifactDescriptor {
    const at = canonicalArtifactTimestamp(input.at, "put timestamp");
    const bytes = new Uint8Array(input.bytes);
    const primaryId = this.#primaryHashForBytes(bytes);
    assertArtifactHash(primaryId, "computed artifact identity");
    const claimedId = input.expectedId ?? primaryId;
    assertArtifactHash(claimedId, "expected artifact identity");
    this.#authorize(input.actor, "artifact:write", "put", claimedId, at);
    if (claimedId !== primaryId) {
      this.#record(at, input.actor.actorId, "put", claimedId, "rejected", {
        actualArtifactId: primaryId,
        reason: "content-hash-mismatch",
      });
      throw new ArtifactStoreIntegrityError(`expected ${claimedId}, received ${primaryId}`);
    }
    const incumbent = this.#artifacts.get(primaryId);
    if (incumbent === undefined) {
      if (primaryId !== artifactIdForBytes(bytes)) {
        throw new ArtifactStoreIntegrityError(
          "first artifact must use its canonical sha256 identity",
        );
      }
      return this.#putCanonical(input, at, primaryId, bytes);
    }
    if (equalArtifactBytes(incumbent.bytes, bytes))
      return this.#putCanonical(input, at, primaryId, bytes);
    const variantId = artifactCollisionVariantIdForBytes(primaryId, bytes);
    const variant = this.#putCanonical(input, at, variantId, bytes);
    this.#collisionPrimaryByVariant.set(variant.artifactId, primaryId);
    this.#record(at, input.actor.actorId, "put", primaryId, "rejected", {
      actualArtifactId: variant.artifactId,
      reason: "identity-collision",
    });
    throw new ArtifactIdentityCollisionError(primaryId, variant.artifactId);
  }

  #putCanonical(
    input: ArtifactPutInput,
    at: string,
    artifactId: string,
    bytes: Uint8Array,
  ): ArtifactDescriptor {
    const parents = sortedUniqueArtifactValues(input.parents ?? [], "artifact parents");
    for (const parent of parents) {
      assertArtifactHash(parent, "parent artifact identity");
      if (parent === artifactId || !this.#artifacts.has(parent)) {
        this.#reject(at, input.actor.actorId, "put", artifactId, "missing-or-self-parent");
        throw new ArtifactStoreIntegrityError(`artifact parent ${parent} is not available`);
      }
    }
    const retention = checkedArtifactRetention(input.retention, at);
    const existing = this.#artifacts.get(artifactId);
    if (existing) {
      if (!equalArtifactBytes(existing.bytes, bytes)) {
        throw new ArtifactStoreIntegrityError(`artifact bytes cannot replace ${artifactId}`);
      }
      const same =
        equalArtifactValues(existing.parents, parents) &&
        canonicalArtifactJson(existing.retention) === canonicalArtifactJson(retention);
      if (!same) {
        this.#reject(at, input.actor.actorId, "put", artifactId, "immutable-metadata-conflict");
        throw new ArtifactStoreIntegrityError(`artifact metadata cannot replace ${artifactId}`);
      }
      this.#record(at, input.actor.actorId, "put", artifactId, "already-present", {});
      return copyArtifactDescriptor(existing);
    }
    const stored: StoredArtifactRecord = {
      artifactId,
      byteLength: bytes.byteLength,
      parents,
      retention,
      createdAt: at,
      createdBy: input.actor.actorId,
      bytes,
    };
    this.#artifacts.set(artifactId, stored);
    this.#record(at, input.actor.actorId, "put", artifactId, "created", {
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
    return pruneImmutableArtifactScope(
      this.#artifacts,
      this.#references,
      ids,
      at,
      (recordedTarget, outcome, details) =>
        this.#record(at, input.actor.actorId, "prune", recordedTarget, outcome, details),
    );
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
    const artifact = this.#artifacts.get(input.artifactId);
    const primaryId = this.#collisionPrimaryByVariant.get(input.artifactId);
    if (
      artifact !== undefined &&
      primaryId !== undefined &&
      artifactCollisionVariantIdForBytes(primaryId, artifact.bytes) !== input.artifactId
    ) {
      throw new ArtifactStoreIntegrityError(`collision variant ${input.artifactId} is not intact`);
    }
    const bytes = artifact?.bytes;
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
    const snapshot = buildImmutableArtifactSnapshot(
      this.#artifacts.values(),
      this.#references.values(),
      this.#audit,
    );
    return {
      serialized: `${JSON.stringify(snapshot, null, 2)}\n`,
      snapshotHash: snapshot.snapshotHash,
    };
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
    assertArtifactAuditChronological(this.#audit, at);
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
    return appendImmutableArtifactAuditEvent(
      this.#audit,
      occurredAt,
      actor,
      action,
      target,
      outcome,
      details,
    );
  }
}
