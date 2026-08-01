import { sql } from "drizzle-orm";

import type { AuthorizationActor } from "./authorization.js";
import { permissionValues, requirePermission } from "./authorization.js";
import type { ItotoriDatabase } from "./connection.js";
import {
  ArtifactIdentityCollisionError,
  ArtifactStoreIntegrityError,
  artifactIdForBytes,
  type ArtifactDescriptor,
  type ArtifactReference,
  type ArtifactRetentionPolicy,
} from "./immutable-artifact-store.js";
import { checkedArtifactRetention } from "./immutable-artifact-store-support.js";
import {
  assertArtifactHash,
  canonicalArtifactTimestamp,
  decodeArtifactBytes,
  nonBlankArtifactValue,
  sortedUniqueArtifactValues,
} from "./immutable-artifact-snapshot.js";
import type { LlmMemoCipher } from "./repositories/llm-call-memo-repository.js";

type ArtifactRow = {
  artifactId: string;
  byteLength: number;
  parents: readonly string[];
  retention: ArtifactRetentionPolicy;
  createdAt: string;
  createdBy: string;
  deletionState: string;
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
  constructor(
    private readonly db: ItotoriDatabase,
    private readonly cipher: LlmMemoCipher,
  ) {}

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
    const actualId = artifactIdForBytes(bytes);
    const artifactId = input.expectedId ?? actualId;
    assertArtifactHash(artifactId, "expected artifact identity");
    if (artifactId !== actualId) throw new ArtifactIdentityCollisionError(artifactId);
    const parents = sortedUniqueArtifactValues(input.parents ?? [], "artifact parents");
    if (parents.includes(artifactId)) {
      throw new ArtifactStoreIntegrityError("an artifact cannot name itself as a parent");
    }
    const retention = checkedArtifactRetention(input.retention, at);
    for (const lockedId of [artifactId, ...parents].toSorted()) {
      await this.db.execute(sql`
        select pg_advisory_xact_lock(hashtextextended(${lockedId}, 0))
      `);
    }
    await this.#requireParents(parents);

    const sealed = await this.cipher.seal(Buffer.from(bytes).toString("base64"));
    let ownsSealedPayload = true;
    try {
      const inserted = await this.db.execute(sql`
        insert into itotori_immutable_artifacts (
          artifact_id, byte_length, parents, retention_classification,
          retention_basis, expires_at, created_at, created_by,
          content_ciphertext, content_key_ref, deletion_state
        ) values (
          ${artifactId}, ${bytes.byteLength}, ${sql.param(parents)}::text[], ${retention.classification},
          ${retention.basis}, ${retention.expiresAt}::timestamptz,
          ${at}::timestamptz, ${actor.userId}, ${Buffer.from(sealed.ciphertext)},
          ${sealed.keyRef}, 'active'
        )
        on conflict (artifact_id) do nothing
        returning artifact_id
      `);
      if (inserted.rows.length === 1) {
        await this.#audit(actor, at, "put", artifactId, "created", {
          byteLength: bytes.byteLength,
          classification: retention.classification,
        });
        ownsSealedPayload = false;
        return {
          artifactId,
          byteLength: bytes.byteLength,
          parents,
          retention,
          createdAt: at,
          createdBy: actor.userId,
        };
      }

      const existing = await this.#metadata(artifactId);
      if (existing === undefined || existing.deletionState !== "active") {
        throw new ArtifactStoreIntegrityError(`artifact ${artifactId} is not available`);
      }
      if (!sameImmutableMetadata(existing, { parents, retention, byteLength: bytes.byteLength })) {
        throw new ArtifactStoreIntegrityError(`artifact metadata cannot replace ${artifactId}`);
      }
      await this.#audit(actor, at, "put", artifactId, "already-present", {});
      return descriptorFromRow(existing);
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
      select byte_length, content_ciphertext, content_key_ref
      from itotori_immutable_artifacts
      where artifact_id = ${input.artifactId} and deletion_state = 'active'
    `);
    const row = result.rows[0];
    if (row === undefined) {
      await this.#audit(actor, at, "read", input.artifactId, "missing", {});
      return undefined;
    }
    const ciphertext = requiredBytes(row.content_ciphertext, "artifact ciphertext");
    const encoded = await this.cipher.open(ciphertext, requiredString(row.content_key_ref));
    const bytes = decodeArtifactBytes(encoded, input.artifactId);
    if (
      bytes.byteLength !== Number(row.byte_length) ||
      artifactIdForBytes(bytes) !== input.artifactId
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

  async #requireParents(parents: readonly string[]): Promise<void> {
    if (parents.length === 0) return;
    for (const parent of parents) assertArtifactHash(parent, "parent artifact identity");
    const result = await this.db.execute(sql`
      select artifact_id from itotori_immutable_artifacts
      where artifact_id = any(${sql.param(parents)}::text[]) and deletion_state = 'active'
    `);
    if (result.rows.length !== parents.length) {
      throw new ArtifactStoreIntegrityError("one or more artifact parents are unavailable");
    }
  }

  async #metadata(artifactId: string): Promise<ArtifactRow | undefined> {
    const result = await this.db.execute(sql`
      select artifact_id, byte_length, parents, retention_classification,
        retention_basis, expires_at, created_at, created_by, deletion_state
      from itotori_immutable_artifacts where artifact_id = ${artifactId}
    `);
    const row = result.rows[0];
    return row === undefined ? undefined : artifactRow(row);
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
      createdAt: timestamp(row.created_at),
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
  ): Promise<void> {
    await this.db.execute(sql`
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

function artifactRow(row: Record<string, unknown>): ArtifactRow {
  const classification = String(row.retention_classification);
  const basis = String(row.retention_basis);
  const parents = row.parents;
  if (classification !== "public" && classification !== "restricted") {
    throw new ArtifactStoreIntegrityError("stored retention classification is invalid");
  }
  if (!isRetentionBasis(basis) || !Array.isArray(parents) || !parents.every(isString)) {
    throw new ArtifactStoreIntegrityError("stored immutable artifact metadata is invalid");
  }
  return {
    artifactId: String(row.artifact_id),
    byteLength: Number(row.byte_length),
    parents,
    retention: {
      classification,
      basis,
      expiresAt: timestamp(row.expires_at),
    },
    createdAt: timestamp(row.created_at),
    createdBy: String(row.created_by),
    deletionState: String(row.deletion_state),
  };
}

function descriptorFromRow(row: ArtifactRow): ArtifactDescriptor {
  return {
    artifactId: row.artifactId,
    byteLength: row.byteLength,
    parents: [...row.parents],
    retention: { ...row.retention },
    createdAt: row.createdAt,
    createdBy: row.createdBy,
  };
}

function sameImmutableMetadata(
  row: ArtifactRow,
  input: { parents: readonly string[]; retention: ArtifactRetentionPolicy; byteLength: number },
): boolean {
  return (
    row.byteLength === input.byteLength &&
    row.parents.length === input.parents.length &&
    row.parents.every((parent, index) => parent === input.parents[index]) &&
    row.retention.classification === input.retention.classification &&
    row.retention.basis === input.retention.basis &&
    row.retention.expiresAt === input.retention.expiresAt
  );
}

function timestamp(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime()))
    throw new ArtifactStoreIntegrityError("stored timestamp is invalid");
  return date.toISOString();
}

function requiredBytes(value: unknown, label: string): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new ArtifactStoreIntegrityError(`${label} is missing`);
  return new Uint8Array(value);
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ArtifactStoreIntegrityError("artifact key reference is missing");
  }
  return value;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isRetentionBasis(value: string): value is ArtifactRetentionPolicy["basis"] {
  return ["lineage", "expiry", "release", "append-only", "declared-scope"].includes(value);
}
