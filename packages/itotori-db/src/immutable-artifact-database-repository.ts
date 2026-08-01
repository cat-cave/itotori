import { sql } from "drizzle-orm";

import type { AuthorizationActor } from "./authorization.js";
import { AuthorizationError, permissionValues, requirePermission } from "./authorization.js";
import type { ItotoriDatabase } from "./connection.js";
import {
  ArtifactIdentityCollisionError,
  ArtifactStoreIntegrityError,
  artifactIdForBytes,
  type ArtifactDescriptor,
  type ArtifactReference,
  type ArtifactRetentionPolicy,
} from "./immutable-artifact-store.js";
import { artifactCollisionVariantIdForBytes } from "./immutable-artifact-store-collision.js";
import { checkedArtifactRetention } from "./immutable-artifact-store-support.js";
import {
  assertArtifactHash,
  assertImmutableArtifactFormatVersion,
  canonicalArtifactTimestamp,
  decodeArtifactBytes,
  immutableArtifactFormatVersion,
  nonBlankArtifactValue,
  sortedUniqueArtifactValues,
} from "./immutable-artifact-snapshot.js";
import {
  databaseArtifactDescriptor,
  databaseArtifactRow,
  databaseTimestamp,
  requiredDatabaseBytes,
  requiredDatabaseString,
  sameDatabaseArtifactMetadata,
  type ArtifactDatabaseRow,
} from "./immutable-artifact-database-repository-support.js";
import type { LlmMemoCipher } from "./repositories/llm-call-memo-repository.js";

type ArtifactDatabaseExecutor = Pick<ItotoriDatabase, "execute">;

type DatabaseImmutableArtifactRepositoryOptions = {
  /** Test-only seam for exercising a real same-primary-hash collision path. */
  primaryHashForBytes?: (bytes: Uint8Array) => string;
};

export type ProjectArtifactReferenceInput = {
  projectId: string;
  projectArtifactId: string;
  artifactId: string;
  purpose: ArtifactReference["purpose"];
  at: string;
};

export function projectArtifactReferenceId(projectId: string, projectArtifactId: string): string {
  return `project-artifact:${encodeURIComponent(projectId)}:${encodeURIComponent(projectArtifactId)}`;
}

/** Production artifact persistence. Content-bearing columns are only selected
 * by read(), after the exact content.read permission check has succeeded. */
export class DatabaseImmutableArtifactRepository {
  readonly #primaryHashForBytes: (bytes: Uint8Array) => string;

  constructor(
    private readonly db: ItotoriDatabase,
    private readonly cipher: LlmMemoCipher,
    options: DatabaseImmutableArtifactRepositoryOptions = {},
  ) {
    this.#primaryHashForBytes = options.primaryHashForBytes ?? artifactIdForBytes;
  }

  async put(
    actor: AuthorizationActor,
    input: {
      bytes: Uint8Array;
      retention: ArtifactRetentionPolicy;
      at: string;
      expectedId?: string;
      parents?: readonly string[];
    },
  ): Promise<ArtifactDescriptor> {
    await requirePermission(this.db, actor, permissionValues.runtimeIngest);
    const at = canonicalArtifactTimestamp(input.at, "put timestamp");
    const bytes = new Uint8Array(input.bytes);
    const primaryId = this.#primaryHashForBytes(bytes);
    assertArtifactHash(primaryId, "computed artifact identity");
    const claimedId = input.expectedId ?? primaryId;
    assertArtifactHash(claimedId, "expected artifact identity");
    if (claimedId !== primaryId) {
      await this.#audit(actor, at, "put", claimedId, "rejected", {
        actualArtifactId: primaryId,
        reason: "content-hash-mismatch",
      });
      throw new ArtifactStoreIntegrityError(`expected ${claimedId}, received ${primaryId}`);
    }
    const parents = sortedUniqueArtifactValues(input.parents ?? [], "artifact parents");
    const retention = checkedArtifactRetention(input.retention, at);
    const fingerprint = artifactCollisionVariantIdForBytes(primaryId, bytes);
    const sealed = await this.cipher.seal(Buffer.from(bytes).toString("base64"));
    let ownsSealedPayload = true;
    try {
      const stored = await this.db.transaction(async (tx) => {
        for (const lockedId of [primaryId, fingerprint, ...parents].toSorted()) {
          await tx.execute(sql`
            select pg_advisory_xact_lock(hashtextextended(${lockedId}, 0))
          `);
        }
        const incumbent = await this.#metadata(primaryId, tx);
        if (incumbent === undefined && primaryId !== artifactIdForBytes(bytes)) {
          throw new ArtifactStoreIntegrityError(
            "first artifact must use its canonical sha256 identity",
          );
        }
        if (incumbent !== undefined && incumbent.deletionState !== "active") {
          throw new ArtifactStoreIntegrityError(`artifact ${primaryId} is not available`);
        }
        // Pre-enforcement rows use their primary identity as a sentinel rather
        // than a byte fingerprint. Treat that sentinel as unknown: accepting it
        // as a duplicate could discard a real post-upgrade SHA-256 collision.
        const incumbentMatchesBytes =
          incumbent !== undefined && incumbent.contentFingerprint === fingerprint;
        if (incumbentMatchesBytes) {
          this.#assertSameMetadata(incumbent, parents, retention, primaryId, bytes.byteLength);
          await this.#audit(actor, at, "put", primaryId, "already-present", {}, tx);
          return { descriptor: databaseArtifactDescriptor(incumbent), persisted: false };
        }
        const collision = incumbent !== undefined;
        const targetId = collision ? fingerprint : primaryId;
        if (parents.includes(targetId)) {
          throw new ArtifactStoreIntegrityError("an artifact cannot name itself as a parent");
        }
        await this.#requireParents(parents, tx);
        const existing = collision ? await this.#metadata(targetId, tx) : undefined;
        if (existing !== undefined) {
          if (existing.deletionState !== "active" || existing.contentFingerprint !== fingerprint) {
            throw new ArtifactStoreIntegrityError(`collision address ${targetId} is unavailable`);
          }
          if ((await this.#collisionPrimaryForVariant(targetId, tx)) !== primaryId) {
            throw new ArtifactStoreIntegrityError(
              `collision address ${targetId} belongs to another primary`,
            );
          }
          this.#assertSameMetadata(existing, parents, retention, targetId, bytes.byteLength);
        }
        const inserted =
          existing === undefined &&
          (
            await tx.execute(sql`
          insert into itotori_immutable_artifacts (
            artifact_id, byte_length, parents, retention_classification,
            retention_basis, expires_at, created_at, created_by, format_version,
            content_fingerprint, content_ciphertext, content_key_ref, deletion_state
          ) values (
            ${targetId}, ${bytes.byteLength}, ${sql.param(parents)}::text[], ${retention.classification},
            ${retention.basis}, ${retention.expiresAt}::timestamptz,
            ${at}::timestamptz, ${actor.userId}, ${immutableArtifactFormatVersion},
            ${fingerprint}, ${Buffer.from(sealed.ciphertext)}, ${sealed.keyRef}, 'active'
          )
          returning artifact_id
        `)
          ).rows.length === 1;
        const descriptor =
          existing === undefined
            ? {
                artifactId: targetId,
                byteLength: bytes.byteLength,
                parents,
                retention,
                createdAt: at,
                createdBy: actor.userId,
              }
            : databaseArtifactDescriptor(existing);
        await this.#audit(
          actor,
          at,
          "put",
          targetId,
          inserted ? "created" : "already-present",
          inserted
            ? { byteLength: bytes.byteLength, classification: retention.classification }
            : {},
          tx,
        );
        if (collision) {
          await this.#bindCollision(primaryId, targetId, actor.userId, at, tx);
          await this.#audit(
            actor,
            at,
            "put",
            primaryId,
            "rejected",
            {
              actualArtifactId: targetId,
              reason: "identity-collision",
            },
            tx,
          );
        }
        return { descriptor, persisted: inserted, collision };
      });
      if (stored.persisted) ownsSealedPayload = false;
      if (stored.collision === true) {
        throw new ArtifactIdentityCollisionError(primaryId, stored.descriptor.artifactId);
      }
      return stored.descriptor;
    } finally {
      if (ownsSealedPayload) await this.cipher.releaseKeyReference(sealed.keyRef);
    }
  }

  async addProjectReference(
    actor: AuthorizationActor,
    input: ProjectArtifactReferenceInput,
  ): Promise<ArtifactReference> {
    await requirePermission(this.db, actor, permissionValues.runtimeIngest);
    const at = canonicalArtifactTimestamp(input.at, "reference timestamp");
    const projectId = nonBlankArtifactValue(input.projectId, "project identity");
    const projectArtifactId = nonBlankArtifactValue(
      input.projectArtifactId,
      "project artifact identity",
    );
    assertArtifactHash(input.artifactId, "referenced artifact identity");
    const referenceId = projectArtifactReferenceId(projectId, projectArtifactId);
    await this.db.execute(sql`
      select pg_advisory_xact_lock(hashtextextended(${input.artifactId}, 0))
    `);
    const artifact = await this.#metadata(input.artifactId);
    if (artifact === undefined || artifact.deletionState !== "active") {
      throw new ArtifactStoreIntegrityError(`artifact ${input.artifactId} is missing`);
    }
    if (
      input.purpose === "release" &&
      (artifact.retention.classification !== "public" || artifact.retention.basis !== "release")
    ) {
      throw new ArtifactStoreIntegrityError(`artifact ${input.artifactId} is not releasable`);
    }
    const inserted = await this.db.execute(sql`
      insert into itotori_immutable_artifact_references (
        reference_id, project_id, project_artifact_id, artifact_id,
        purpose, created_at, created_by
      ) values (
        ${referenceId}, ${projectId}, ${projectArtifactId}, ${input.artifactId},
        ${input.purpose}, ${at}::timestamptz, ${actor.userId}
      )
      on conflict (reference_id) do nothing
      returning reference_id
    `);
    const reference =
      inserted.rows.length === 1
        ? {
            referenceId,
            artifactId: input.artifactId,
            purpose: input.purpose,
            createdAt: at,
            createdBy: actor.userId,
          }
        : await this.#projectReference(projectId, projectArtifactId);
    if (
      reference === undefined ||
      reference.artifactId !== input.artifactId ||
      reference.purpose !== input.purpose
    ) {
      throw new ArtifactStoreIntegrityError(`reference ${referenceId} cannot be replaced`);
    }
    await this.#audit(actor, at, "reference-add", referenceId, "added", {
      artifactId: input.artifactId,
    });
    return reference;
  }

  async resolveProjectReference(
    actor: AuthorizationActor,
    input: { projectId: string; projectArtifactId: string; at: string },
  ): Promise<ArtifactReference | undefined> {
    await requirePermission(this.db, actor, permissionValues.contentRead);
    const at = canonicalArtifactTimestamp(input.at, "reference resolution timestamp");
    const reference = await this.#projectReference(input.projectId, input.projectArtifactId);
    await this.#audit(
      actor,
      at,
      "reference-resolve",
      projectArtifactReferenceId(input.projectId, input.projectArtifactId),
      reference === undefined ? "missing" : "resolved",
      {},
    );
    return reference;
  }

  async read(
    actor: AuthorizationActor,
    input: { artifactId: string; at: string },
  ): Promise<Uint8Array | undefined> {
    await requirePermission(this.db, actor, permissionValues.contentRead);
    const at = canonicalArtifactTimestamp(input.at, "read timestamp");
    assertArtifactHash(input.artifactId, "artifact identity");
    const result = await this.db.execute(sql`
      select byte_length, format_version, content_fingerprint, content_ciphertext, content_key_ref
      from itotori_immutable_artifacts
      where artifact_id = ${input.artifactId} and deletion_state = 'active'
    `);
    const row = result.rows[0];
    if (row === undefined) {
      await this.#audit(actor, at, "read", input.artifactId, "missing", {});
      return undefined;
    }
    assertImmutableArtifactFormatVersion(row.format_version);
    const ciphertext = requiredDatabaseBytes(row.content_ciphertext, "artifact ciphertext");
    const encoded = await this.cipher.open(ciphertext, requiredDatabaseString(row.content_key_ref));
    const bytes = decodeArtifactBytes(encoded, input.artifactId);
    const fingerprint = requiredDatabaseString(
      row.content_fingerprint,
      "artifact content fingerprint",
    );
    const collisionPrimary = await this.#collisionPrimaryForVariant(input.artifactId);
    const canonicalIdentity = artifactIdForBytes(bytes);
    const isLegacyCanonicalArtifact =
      collisionPrimary === undefined &&
      fingerprint === input.artifactId &&
      canonicalIdentity === input.artifactId;
    const isCurrentCanonicalArtifact =
      collisionPrimary === undefined &&
      fingerprint === artifactCollisionVariantIdForBytes(input.artifactId, bytes) &&
      canonicalIdentity === input.artifactId;
    const isCollisionVariant =
      collisionPrimary !== undefined &&
      fingerprint === input.artifactId &&
      artifactCollisionVariantIdForBytes(collisionPrimary, bytes) === input.artifactId;
    if (
      bytes.byteLength !== Number(row.byte_length) ||
      (!isLegacyCanonicalArtifact && !isCurrentCanonicalArtifact && !isCollisionVariant)
    ) {
      throw new ArtifactStoreIntegrityError(
        `artifact ${input.artifactId} ciphertext is not intact`,
      );
    }
    await this.#audit(actor, at, "read", input.artifactId, "served", {
      byteLength: bytes.byteLength,
    });
    return new Uint8Array(bytes);
  }

  async retain(
    actor: AuthorizationActor,
    input: { artifactId: string; until: string; at: string },
  ): Promise<void> {
    await requirePermission(this.db, actor, permissionValues.retentionManage);
    if (actor.sessionId === undefined) {
      throw new AuthorizationError(actor, permissionValues.retentionManage);
    }
    const until = canonicalArtifactTimestamp(input.until, "retention deadline");
    const at = canonicalArtifactTimestamp(input.at, "retention timestamp");
    assertArtifactHash(input.artifactId, "retained artifact identity");
    await this.db.execute(sql`
      select itotori_extend_immutable_artifact_retention(
        ${actor.sessionId}, ${input.artifactId}, ${until}::timestamptz, ${at}::timestamptz
      )
    `);
  }

  async #requireParents(
    parents: readonly string[],
    db: ArtifactDatabaseExecutor = this.db,
  ): Promise<void> {
    if (parents.length === 0) return;
    for (const parent of parents) assertArtifactHash(parent, "parent artifact identity");
    const result = await db.execute(sql`
      select artifact_id from itotori_immutable_artifacts
      where artifact_id = any(${sql.param(parents)}::text[]) and deletion_state = 'active'
    `);
    if (result.rows.length !== parents.length) {
      throw new ArtifactStoreIntegrityError("one or more artifact parents are unavailable");
    }
  }

  async #metadata(
    artifactId: string,
    db: ArtifactDatabaseExecutor = this.db,
  ): Promise<ArtifactDatabaseRow | undefined> {
    const result = await db.execute(sql`
      select artifact_id, byte_length, parents, retention_classification,
        retention_basis, expires_at as base_expires_at,
        itotori_immutable_artifact_effective_expiry(artifact_id) as effective_expires_at,
        created_at, created_by, deletion_state, format_version, content_fingerprint
      from itotori_immutable_artifacts where artifact_id = ${artifactId}
    `);
    const row = result.rows[0];
    return row === undefined ? undefined : databaseArtifactRow(row);
  }

  #assertSameMetadata(
    row: ArtifactDatabaseRow,
    parents: readonly string[],
    retention: ArtifactRetentionPolicy,
    artifactId: string,
    byteLength: number,
  ): void {
    if (!sameDatabaseArtifactMetadata(row, { parents, retention, byteLength })) {
      throw new ArtifactStoreIntegrityError(`artifact metadata cannot replace ${artifactId}`);
    }
  }

  async #collisionPrimaryForVariant(
    variantArtifactId: string,
    db: ArtifactDatabaseExecutor = this.db,
  ): Promise<string | undefined> {
    const result = await db.execute(sql`
      select claimed_artifact_id
      from itotori_immutable_artifact_collision_variants
      where variant_artifact_id = ${variantArtifactId}
    `);
    const row = result.rows[0];
    return row === undefined ? undefined : requiredDatabaseString(row.claimed_artifact_id);
  }

  async #bindCollision(
    claimedArtifactId: string,
    variantArtifactId: string,
    actorId: string,
    at: string,
    db: ArtifactDatabaseExecutor,
  ): Promise<void> {
    await db.execute(sql`
      insert into itotori_immutable_artifact_collision_variants (
        claimed_artifact_id, variant_artifact_id, recorded_at, recorded_by
      ) values (
        ${claimedArtifactId}, ${variantArtifactId}, ${at}::timestamptz, ${actorId}
      )
      on conflict (variant_artifact_id) do nothing
    `);
    if ((await this.#collisionPrimaryForVariant(variantArtifactId, db)) !== claimedArtifactId) {
      throw new ArtifactStoreIntegrityError(
        `collision address ${variantArtifactId} belongs to another primary`,
      );
    }
  }

  async #projectReference(
    projectId: string,
    projectArtifactId: string,
  ): Promise<ArtifactReference | undefined> {
    const result = await this.db.execute(sql`
      select reference_id, artifact_id, purpose, created_at, created_by
      from itotori_immutable_artifact_references
      where project_id = ${projectId} and project_artifact_id = ${projectArtifactId}
        and removed_at is null
    `);
    const row = result.rows[0];
    if (row === undefined) return undefined;
    const purpose = String(row.purpose);
    if (purpose !== "lineage" && purpose !== "release") {
      throw new ArtifactStoreIntegrityError("artifact reference purpose is invalid");
    }
    return {
      referenceId: String(row.reference_id),
      artifactId: String(row.artifact_id),
      purpose,
      createdAt: databaseTimestamp(row.created_at),
      createdBy: String(row.created_by),
    };
  }

  async #audit(
    actor: AuthorizationActor,
    at: string,
    action: string,
    target: string,
    outcome: string,
    details: Readonly<Record<string, string | number>>,
    db: ArtifactDatabaseExecutor = this.db,
  ): Promise<void> {
    await db.execute(sql`
      insert into itotori_immutable_artifact_audit_events (
        occurred_at, actor_id, action, target, outcome, details
      ) values (
        ${at}::timestamptz, ${actor.userId}, ${action}, ${target}, ${outcome},
        ${JSON.stringify(details)}::jsonb
      )
    `);
  }
}

export function openDatabaseImmutableArtifactRepository(
  db: ItotoriDatabase,
  cipher: LlmMemoCipher,
): DatabaseImmutableArtifactRepository {
  return new DatabaseImmutableArtifactRepository(db, cipher);
}

/** Test-only factory. It is intentionally not re-exported from the package API. */
export function openDatabaseImmutableArtifactRepositoryForTesting(
  db: ItotoriDatabase,
  cipher: LlmMemoCipher,
  primaryHashForBytes: (bytes: Uint8Array) => string,
): DatabaseImmutableArtifactRepository {
  return new DatabaseImmutableArtifactRepository(db, cipher, { primaryHashForBytes });
}
