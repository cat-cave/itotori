import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import pg from "pg";

import {
  ArtifactIdentityCollisionError,
  ArtifactStoreIntegrityError,
  artifactIdForBytes,
  createDatabaseContext,
  ItotoriImmutableArtifactRetentionRepository,
  migrate,
  openDatabaseImmutableArtifactRepository,
} from "../dist/index.js";

class ArtifactBehaviorCipher {
  #keys = new Map();
  #ordinal = 0;

  async seal(plaintext) {
    const key = randomBytes(32);
    const keyRef = `artifact-behavior-key:${(this.#ordinal += 1)}`;
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    this.#keys.set(keyRef, key);
    return { ciphertext: Buffer.concat([nonce, cipher.getAuthTag(), encrypted]), keyRef };
  }

  async open(ciphertext, keyRef) {
    const key = this.#keys.get(keyRef);
    if (key === undefined) throw new Error("artifact behavior key was released");
    const bytes = Buffer.from(ciphertext);
    const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8");
  }

  async releaseKeyReference(keyRef) {
    this.#keys.delete(keyRef);
  }
}

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
    error instanceof Error &&
    /version/i.test(error.name) &&
    /incompatible|unsupported|version/i.test(error.message)
  );
}

async function artifactExpiry(pool, artifactId) {
  const result = await pool.query(
    "select expires_at from itotori_immutable_artifacts where artifact_id = $1",
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
) {
  const client = await pool.connect();
  let inTransaction = false;
  try {
    await client.query("begin");
    inTransaction = true;
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

async function withIsolatedDatabase(operation) {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined) throw new Error("artifact-driver-database-unavailable");
  const schemaName = `itotori_artifact_behavior_${process.pid}_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  let context;
  try {
    await admin.query(`create schema "${schemaName}"`);
    const isolated = new URL(databaseUrl);
    isolated.searchParams.set("options", `-csearch_path=${schemaName}`);
    await migrate(isolated.toString());
    context = createDatabaseContext(isolated.toString());
    return await operation(context);
  } finally {
    try {
      await context?.close();
    } finally {
      try {
        await admin.query(`drop schema if exists "${schemaName}" cascade`);
      } finally {
        await admin.end();
      }
    }
  }
}

export async function observeDatabaseArtifactRepository(actor, encoder) {
  if (process.env.DATABASE_URL === undefined) {
    return {
      retention: false,
      expiry: false,
      mutation: false,
      typedIncompatibleVersion: false,
      audit: false,
    };
  }
  return await withIsolatedDatabase(async (context) => {
    const cipher = new ArtifactBehaviorCipher();
    const repository = openDatabaseImmutableArtifactRepository(context.db, cipher);
    const retention = new ItotoriImmutableArtifactRetentionRepository(context, cipher);
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
    const collision = await captureError(async () => {
      await reloadedRepository.put(actor, {
        bytes: encoder.encode("database conflicting lineage child"),
        expectedId: databaseChild.artifactId,
        retention: {
          classification: "restricted",
          basis: "expiry",
          expiresAt: "2026-12-31T00:00:00.000Z",
        },
        at: "2026-01-01T00:03:00.000Z",
      });
    });
    const collisionRefused =
      collision instanceof ArtifactIdentityCollisionError &&
      bytesEqual(
        await reloadedRepository.read(actor, {
          artifactId: databaseChild.artifactId,
          at: "2026-01-01T00:04:00.000Z",
        }),
        databaseChildBytes,
      );
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
    const databaseRetain = Reflect.get(repository, "retain");
    const initialExpiry = await artifactExpiry(context.pool, intact.artifactId);
    const retainUntil = "2027-01-10T00:00:00.000Z";
    const deniedRetention =
      typeof databaseRetain === "function"
        ? await captureError(async () => {
            await Reflect.apply(databaseRetain, repository, [
              { userId: "ordinary-artifact-reader" },
              { artifactId: intact.artifactId, until: retainUntil, at: "2026-01-03T00:02:30.000Z" },
            ]);
          })
        : undefined;
    const afterDeniedRetention = await artifactExpiry(context.pool, intact.artifactId);
    const authorizedRetention =
      typeof databaseRetain === "function"
        ? await captureError(async () => {
            await Reflect.apply(databaseRetain, repository, [
              actor,
              { artifactId: intact.artifactId, until: retainUntil, at: "2026-01-03T00:02:45.000Z" },
            ]);
          })
        : undefined;
    const afterAuthorizedRetention = await artifactExpiry(context.pool, intact.artifactId);
    const retentionAuthorized =
      typeof databaseRetain === "function" &&
      initialExpiry === "2027-01-02T00:00:00.000Z" &&
      permissionDenied(deniedRetention, "retention.manage") &&
      afterDeniedRetention === initialExpiry &&
      authorizedRetention === undefined &&
      afterAuthorizedRetention === retainUntil;
    const auditEvents = await context.pool.query(
      `select audit_event_id from itotori_immutable_artifact_audit_events where target = $1`,
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
      ).every(Boolean);
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
    const formatColumn = await context.pool.query(
      `select count(*)::text as count
       from information_schema.columns
       where table_schema = current_schema()
         and table_name = 'itotori_immutable_artifacts'
         and column_name = 'format_version'`,
    );
    let typedIncompatibleVersion = false;
    if (Number(formatColumn.rows[0]?.count ?? "0") === 1) {
      const versioned = await repository.put(actor, {
        bytes: encoder.encode("database format-version control"),
        retention: {
          classification: "restricted",
          basis: "expiry",
          expiresAt: "2027-01-02T00:00:00.000Z",
        },
        at: "2026-01-03T00:04:00.000Z",
      });
      const versionUpdate = await context.pool
        .query(
          "update itotori_immutable_artifacts set format_version = $1 where artifact_id = $2 returning artifact_id",
          ["999999", versioned.artifactId],
        )
        .catch(() => undefined);
      const versionFailure =
        versionUpdate?.rowCount === 1
          ? await captureError(async () => {
              const bytes = await repository.read(actor, {
                artifactId: versioned.artifactId,
                at: "2026-01-03T00:05:00.000Z",
              });
              if (bytes !== undefined) throw new Error("artifact-version-read-succeeded");
            })
          : undefined;
      typedIncompatibleVersion =
        versionUpdate?.rowCount === 1 && typedVersionFailure(versionFailure);
    }
    const mutationReadDetected = artifactTamperDetected(tamperFailure);
    return {
      reload,
      collision: collisionRefused,
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
