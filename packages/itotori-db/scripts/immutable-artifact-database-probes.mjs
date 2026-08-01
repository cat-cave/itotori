import {
  ArtifactIdentityCollisionError,
  ArtifactIncompatibleVersionError,
  ArtifactStoreIntegrityError,
  artifactIdForBytes,
  bootstrapDefaultAccountPrincipal,
  ItotoriAuthSessionService,
  ItotoriImmutableArtifactRetentionRepository,
  ItotoriPrincipalRepository,
  localOperatorPrincipalId,
  MissingRequiredInputError,
  openDatabaseImmutableArtifactRepository,
} from "../dist/index.js";
import { artifactCollisionVariantIdForBytes } from "../dist/immutable-artifact-store.js";
import { openDatabaseImmutableArtifactRepositoryForTesting } from "../dist/immutable-artifact-database-repository.js";
import {
  ArtifactBehaviorCipher,
  retentionTempShadowRejected,
  withIsolatedArtifactDatabase,
} from "./immutable-artifact-database-probe-support.mjs";

async function captureError(operation) {
  try {
    await operation();
    return undefined;
  } catch (error) {
    return error;
  }
}

function permissionDenied(error, permission) {
  return error instanceof Error && error.message.includes(permission);
}

function bytesEqual(left, right) {
  return left !== undefined && Buffer.from(left).equals(Buffer.from(right));
}

function databaseError(error) {
  if (typeof error !== "object" || error === null || typeof error.code !== "string") {
    return undefined;
  }
  return { code: error.code, message: typeof error.message === "string" ? error.message : "" };
}

function immutableMutationRejected(error) {
  const database = databaseError(error);
  return (
    database?.code === "42501" ||
    (database !== undefined &&
      (database.code === "P0001" || database.code === "55000") &&
      /immutable|append.?only|read.?only|not allowed/i.test(database.message))
  );
}

function requiredAuditFieldRejected(error) {
  return databaseError(error)?.code === "23502" || immutableMutationRejected(error);
}

function artifactTamperDetected(error) {
  return (
    error instanceof ArtifactStoreIntegrityError ||
    (error instanceof Error &&
      /auth(?:entication|enticate| tag)|integrity|ciphertext|intact/i.test(error.message))
  );
}

function typedVersionFailure(error) {
  return (
    error instanceof ArtifactIncompatibleVersionError &&
    error.observedVersion === "999999" &&
    error.supportedVersions.includes("itotori.immutable-artifact.v1") &&
    error.migrationPath.length > 0
  );
}

async function artifactExpiry(pool, artifactId) {
  const result = await pool.query(
    `select itotori_immutable_artifact_effective_expiry(artifact_id) as expires_at
     from itotori_immutable_artifacts where artifact_id = $1`,
    [artifactId],
  );
  const value = result.rows[0]?.expires_at;
  return result.rowCount === 1 && value !== undefined ? new Date(value).toISOString() : undefined;
}

async function databaseMutationRejected(
  pool,
  query,
  values,
  expectedError = immutableMutationRejected,
  beforeQuery,
) {
  const client = await pool.connect();
  let inTransaction = false;
  try {
    await client.query("begin");
    inTransaction = true;
    if (beforeQuery !== undefined) await client.query(beforeQuery);
    const result = await client.query(query, values);
    if (result.rowCount !== 1) return false;
    await client.query("commit");
    inTransaction = false;
    return false;
  } catch (error) {
    return expectedError(error);
  } finally {
    if (inTransaction) await client.query("rollback").catch(() => undefined);
    client.release();
  }
}

function auditMutationRejected(pool, auditEventId, assignment) {
  return databaseMutationRejected(
    pool,
    `update itotori_immutable_artifact_audit_events set ${assignment} where audit_event_id = $1 returning audit_event_id`,
    [auditEventId],
    assignment.endsWith("= null") ? requiredAuditFieldRejected : immutableMutationRejected,
  );
}

function auditDeletionRejected(pool, auditEventId) {
  return databaseMutationRejected(
    pool,
    "delete from itotori_immutable_artifact_audit_events where audit_event_id = $1 returning audit_event_id",
    [auditEventId],
  );
}

function auditTruncationRejected(pool) {
  return databaseMutationRejected(pool, "truncate itotori_immutable_artifact_audit_events", []);
}

export async function observeDatabaseArtifactRepository(actor, encoder) {
  if (!process.env.DATABASE_URL) {
    throw new MissingRequiredInputError("DATABASE_URL");
  }
  return await withIsolatedArtifactDatabase(async (context) => {
    const cipher = new ArtifactBehaviorCipher();
    const repository = openDatabaseImmutableArtifactRepository(context.db, cipher);
    const retention = new ItotoriImmutableArtifactRetentionRepository(context, cipher);
    await bootstrapDefaultAccountPrincipal(context.db);
    const sessions = new ItotoriAuthSessionService(context.db);
    const authorizedSession = await sessions.createLoginSession({
      principalId: localOperatorPrincipalId,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    const retentionActor = {
      userId: "local-operator",
      sessionId: authorizedSession.sessionId,
    };
    const principals = new ItotoriPrincipalRepository(context.db);
    await principals.createPrincipal(actor, {
      kind: "human_user",
      principalId: "principal-artifact-ordinary",
      userId: "ordinary-artifact-reader",
      displayName: "Ordinary artifact reader",
    });
    const ordinarySession = await sessions.createLoginSession({
      principalId: "principal-artifact-ordinary",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    const ordinaryActor = {
      userId: "ordinary-artifact-reader",
      sessionId: ordinarySession.sessionId,
    };
    const tempShadowRejected = await retentionTempShadowRejected(
      context.pool,
      ordinarySession.sessionId,
    );
    const databaseParent = await repository.put(actor, {
      bytes: encoder.encode("database lineage parent"),
      retention: {
        classification: "restricted",
        basis: "expiry",
        expiresAt: "2026-12-31T00:00:00.000Z",
      },
      at: "2026-01-01T00:00:00.000Z",
    });
    const databaseChildBytes = encoder.encode("database lineage child");
    const databaseChild = await repository.put(actor, {
      bytes: databaseChildBytes,
      parents: [databaseParent.artifactId],
      retention: {
        classification: "restricted",
        basis: "expiry",
        expiresAt: "2026-12-31T00:00:00.000Z",
      },
      at: "2026-01-01T00:01:00.000Z",
    });
    const reloadedRepository = openDatabaseImmutableArtifactRepository(context.db, cipher);
    const reload =
      databaseChild.artifactId === artifactIdForBytes(databaseChildBytes) &&
      bytesEqual(
        await reloadedRepository.read(actor, {
          artifactId: databaseChild.artifactId,
          at: "2026-01-01T00:02:00.000Z",
        }),
        databaseChildBytes,
      );
    const lineage =
      databaseChild.parents.length === 1 && databaseChild.parents[0] === databaseParent.artifactId;
    const collisionPrimaryBytes = encoder.encode("database forced primary collision bytes A");
    const collisionVariantBytes = encoder.encode("database forced primary collision bytes B");
    const collisionPrimaryId = artifactIdForBytes(collisionPrimaryBytes);
    const primaryHashForBytes = (bytes) =>
      bytesEqual(bytes, collisionPrimaryBytes) || bytesEqual(bytes, collisionVariantBytes)
        ? collisionPrimaryId
        : artifactIdForBytes(bytes);
    const collisionRepository = openDatabaseImmutableArtifactRepositoryForTesting(
      context.db,
      cipher,
      primaryHashForBytes,
    );
    const collisionPrimary = await collisionRepository.put(actor, {
      bytes: collisionPrimaryBytes,
      retention: {
        classification: "restricted",
        basis: "expiry",
        expiresAt: "2026-12-31T00:00:00.000Z",
      },
      at: "2026-01-01T00:03:00.000Z",
    });
    const collision = await captureError(async () => {
      await collisionRepository.put(actor, {
        bytes: collisionVariantBytes,
        expectedId: collisionPrimaryId,
        retention: {
          classification: "restricted",
          basis: "expiry",
          expiresAt: "2026-12-31T00:00:00.000Z",
        },
        at: "2026-01-01T00:03:01.000Z",
      });
    });
    const collisionVariantId =
      collision instanceof ArtifactIdentityCollisionError ? collision.variantArtifactId : undefined;
    const collisionReload = openDatabaseImmutableArtifactRepository(context.db, cipher);
    const originalCollisionBytes = await collisionReload.read(actor, {
      artifactId: collisionPrimaryId,
      at: "2026-01-01T00:04:00.000Z",
    });
    const collisionVariant =
      collisionVariantId === undefined
        ? undefined
        : await collisionReload.read(actor, {
            artifactId: collisionVariantId,
            at: "2026-01-01T00:04:30.000Z",
          });
    const collisionLink =
      collisionVariantId === undefined
        ? { rowCount: 0 }
        : await context.pool.query(
            `select claimed_artifact_id, variant_artifact_id
             from itotori_immutable_artifact_collision_variants
             where claimed_artifact_id = $1 and variant_artifact_id = $2`,
            [collisionPrimaryId, collisionVariantId],
          );
    const collisionPreserved =
      collision instanceof ArtifactIdentityCollisionError &&
      collision.claimedArtifactId === collisionPrimaryId &&
      collisionPrimary.artifactId === collisionPrimaryId &&
      collisionVariantId ===
        artifactCollisionVariantIdForBytes(collisionPrimaryId, collisionVariantBytes) &&
      collisionVariantId !== collisionPrimaryId &&
      bytesEqual(originalCollisionBytes, collisionPrimaryBytes) &&
      bytesEqual(collisionVariant, collisionVariantBytes) &&
      collisionLink.rowCount === 1;
    const expired = await repository.put(actor, {
      bytes: encoder.encode("database expired bytes"),
      retention: {
        classification: "restricted",
        basis: "expiry",
        expiresAt: "2026-01-02T00:00:00.000Z",
      },
      at: "2026-01-01T00:00:00.000Z",
    });
    const deletion = await retention.deleteExpired(actor, new Date("2026-01-03T00:00:00.000Z"));
    const removed = await repository.read(actor, {
      artifactId: expired.artifactId,
      at: "2026-01-03T00:01:00.000Z",
    });
    const expiredStorage = await context.pool.query(
      `select deletion_state, content_ciphertext, content_key_ref
       from itotori_immutable_artifacts where artifact_id = $1`,
      [expired.artifactId],
    );
    const expiredRow = expiredStorage.rows[0];
    const expiredMaterialGone =
      expiredStorage.rowCount === 0 ||
      (expiredStorage.rowCount === 1 &&
        expiredRow?.deletion_state === "deleted" &&
        expiredRow.content_ciphertext === null &&
        expiredRow.content_key_ref === null);
    const intact = await repository.put(actor, {
      bytes: encoder.encode("database tamper control"),
      retention: {
        classification: "restricted",
        basis: "expiry",
        expiresAt: "2027-01-02T00:00:00.000Z",
      },
      at: "2026-01-03T00:02:00.000Z",
    });
    const initialExpiry = await artifactExpiry(context.pool, intact.artifactId);
    const retainUntil = "2027-01-03T00:00:00.000Z";
    const rawNullSessionSpoof = await captureError(async () => {
      await context.pool.query(
        `select itotori_extend_immutable_artifact_retention(
           null::text, $1, $2::timestamptz, $3::timestamptz
         )`,
        [intact.artifactId, retainUntil, "2026-01-03T00:02:30.000Z"],
      );
    });
    const rawPrivilegedActorSpoof = await captureError(async () => {
      await context.pool.query(
        `insert into itotori_immutable_artifact_retention_extensions (
           artifact_id, expires_at, authorized_session_id, authorized_by, occurred_at
         ) values ($1, $2::timestamptz, $3, $4, $5::timestamptz)`,
        [
          intact.artifactId,
          retainUntil,
          ordinarySession.sessionId,
          retentionActor.userId,
          "2026-01-03T00:02:30.000Z",
        ],
      );
    });
    const rawRetentionUpdateRejected = await databaseMutationRejected(
      context.pool,
      "update itotori_immutable_artifacts set expires_at = $1::timestamptz where artifact_id = $2 returning artifact_id",
      [retainUntil, intact.artifactId],
      immutableMutationRejected,
      "select set_config('itotori.immutable_artifact_retention_extension', 'authorized', true)",
    );
    const deniedRetention = await captureError(async () => {
      await repository.retain(ordinaryActor, {
        artifactId: intact.artifactId,
        until: retainUntil,
        at: "2026-01-03T00:02:30.000Z",
      });
    });
    const wrongSessionSpoof = await captureError(async () => {
      await repository.retain(
        { userId: retentionActor.userId, sessionId: ordinarySession.sessionId },
        { artifactId: intact.artifactId, until: retainUntil, at: "2026-01-03T00:02:30.000Z" },
      );
    });
    const afterDeniedRetention = await artifactExpiry(context.pool, intact.artifactId);
    const authorizedRetention = await captureError(async () => {
      await repository.retain(retentionActor, {
        artifactId: intact.artifactId,
        until: retainUntil,
        at: "2026-01-03T00:02:45.000Z",
      });
    });
    const afterAuthorizedRetention = await artifactExpiry(context.pool, intact.artifactId);
    const retentionAudit = await context.pool.query(
      `select audit_event_id from itotori_immutable_artifact_audit_events
       where action = 'retain' and target = $1 and outcome = 'retained' and actor_id = $2`,
      [intact.artifactId, retentionActor.userId],
    );
    const baseExpiry = await context.pool.query(
      "select expires_at from itotori_immutable_artifacts where artifact_id = $1",
      [intact.artifactId],
    );
    const retentionAuthorized =
      initialExpiry === "2027-01-02T00:00:00.000Z" &&
      databaseError(rawNullSessionSpoof)?.code === "42501" &&
      databaseError(rawNullSessionSpoof)?.message.includes("retention.manage") &&
      databaseError(rawPrivilegedActorSpoof)?.code === "42501" &&
      databaseError(rawPrivilegedActorSpoof)?.message.includes("retention.manage") &&
      tempShadowRejected &&
      rawRetentionUpdateRejected &&
      permissionDenied(deniedRetention, "retention.manage") &&
      permissionDenied(wrongSessionSpoof, "retention.manage") &&
      afterDeniedRetention === initialExpiry &&
      authorizedRetention === undefined &&
      afterAuthorizedRetention === retainUntil &&
      new Date(baseExpiry.rows[0]?.expires_at).toISOString() === initialExpiry &&
      retentionAudit.rowCount === 1;
    const auditEvents = await context.pool.query(
      `select audit_event_id from itotori_immutable_artifact_audit_events
       where target = $1 and action = 'put' and outcome = 'created'`,
      [intact.artifactId],
    );
    const auditEventId = auditEvents.rows[0]?.audit_event_id;
    const audit =
      auditEvents.rowCount === 1 &&
      (
        await Promise.all(
          [
            "actor_id = 'tampered-actor'",
            "target = 'tampered-target'",
            "outcome = 'rewritten'",
            "occurred_at = '2000-01-01T00:00:00.000Z'",
            "actor_id = null",
            "target = null",
            "outcome = null",
          ].map((assignment) => auditMutationRejected(context.pool, auditEventId, assignment)),
        )
      ).every(Boolean) &&
      (await auditDeletionRejected(context.pool, auditEventId)) &&
      (await auditTruncationRejected(context.pool));
    const ciphertextRow = await context.pool.query(
      "select content_ciphertext from itotori_immutable_artifacts where artifact_id = $1",
      [intact.artifactId],
    );
    const tamperedCiphertext = Buffer.from(ciphertextRow.rows[0]?.content_ciphertext ?? []);
    if (tamperedCiphertext.length > 0) tamperedCiphertext[0] ^= 1;
    const ciphertextMutationRejected =
      tamperedCiphertext.length > 0 &&
      (await databaseMutationRejected(
        context.pool,
        "update itotori_immutable_artifacts set content_ciphertext = $1 where artifact_id = $2 returning artifact_id",
        [tamperedCiphertext, intact.artifactId],
      ));
    const tamperFailure =
      ciphertextMutationRejected || tamperedCiphertext.length === 0
        ? undefined
        : await captureError(async () => {
            const update = await context.pool.query(
              "update itotori_immutable_artifacts set content_ciphertext = $1 where artifact_id = $2 returning artifact_id",
              [tamperedCiphertext, intact.artifactId],
            );
            if (update.rowCount !== 1) throw new Error("artifact-tamper-target-missing");
            if (
              (await repository.read(actor, {
                artifactId: intact.artifactId,
                at: "2026-01-03T00:03:00.000Z",
              })) !== undefined
            ) {
              throw new Error("artifact-tamper-read-succeeded");
            }
          });
    const versioned = await repository.put(actor, {
      bytes: encoder.encode("database format-version control"),
      retention: {
        classification: "restricted",
        basis: "expiry",
        expiresAt: "2027-01-02T00:00:00.000Z",
      },
      at: "2026-01-03T00:04:00.000Z",
    });
    const versionUpdate = await context.pool.query(
      "update itotori_immutable_artifacts set format_version = $1 where artifact_id = $2 returning artifact_id",
      ["999999", versioned.artifactId],
    );
    const versionFailure =
      versionUpdate.rowCount === 1
        ? await captureError(async () => {
            const bytes = await repository.read(actor, {
              artifactId: versioned.artifactId,
              at: "2026-01-03T00:05:00.000Z",
            });
            if (bytes !== undefined) throw new Error("artifact-version-read-succeeded");
          })
        : undefined;
    const typedIncompatibleVersion =
      versionUpdate.rowCount === 1 && typedVersionFailure(versionFailure);
    const mutationReadDetected = artifactTamperDetected(tamperFailure);
    return {
      reload,
      collision: collisionPreserved,
      lineage,
      retention: retentionAuthorized,
      expiry:
        deletion.deletedArtifacts === 1 &&
        deletion.releasedKeyRefs === 1 &&
        removed === undefined &&
        expiredMaterialGone,
      mutation: ciphertextMutationRejected || mutationReadDetected,
      mutationDatabaseRejected: ciphertextMutationRejected,
      mutationReadDetected,
      typedIncompatibleVersion,
      audit,
    };
  });
}
