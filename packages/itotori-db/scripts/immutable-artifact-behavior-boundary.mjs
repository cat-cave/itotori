import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ArtifactIdentityCollisionError,
  ArtifactIncompatibleVersionError,
  ArtifactStoreIntegrityError,
  artifactIdForBytes,
  localUserId,
  openLocalImmutableArtifactRepository,
} from "../dist/index.js";
import {
  ImmutableArtifactStore,
  artifactCollisionVariantIdForBytes,
} from "../dist/immutable-artifact-store.js";
import { observeDatabaseArtifactRepository } from "./immutable-artifact-database-probes.mjs";
const actor = { userId: localUserId };
const encoder = new TextEncoder();
const publicRelease = (expiresAt) => ({ classification: "public", basis: "release", expiresAt });
const publicExpiry = (expiresAt) => ({ classification: "public", basis: "expiry", expiresAt });
function bytesEqual(left, right) {
  return left !== undefined && Buffer.from(left).equals(Buffer.from(right));
}
function record(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label}-invalid`);
  }
  return value;
}
function array(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label}-invalid`);
  return value;
}
function text(value, label) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label}-invalid`);
  return value;
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
function mutateSnapshotBytes(serialized) {
  const root = record(JSON.parse(serialized), "artifact-snapshot");
  const first = record(
    array(root.artifacts, "artifact-snapshot-artifacts")[0],
    "artifact-snapshot-row",
  );
  const bytes = text(first.bytesBase64, "artifact-snapshot-bytes");
  first.bytesBase64 = `${bytes[0] === "A" ? "B" : "A"}${bytes.slice(1)}`;
  return `${JSON.stringify(root)}\n`;
}
function mutateSnapshotVersion(serialized) {
  const root = record(JSON.parse(serialized), "artifact-snapshot");
  root.schemaVersion = "itotori.immutable-artifact-store.v2";
  return `${JSON.stringify(root)}\n`;
}
function mutateSnapshotAudit(serialized) {
  const root = record(JSON.parse(serialized), "artifact-snapshot");
  const events = array(root.auditEvents, "artifact-snapshot-audit-events");
  if (events.length < 2) throw new Error("artifact-snapshot-audit-events-missing");
  record(events[0], "artifact-snapshot-audit-event").actor = "tampered-artifact-actor";
  events.reverse();
  return `${JSON.stringify(root)}\n`;
}
function snapshotHasArtifactBytes(serialized, artifactId, bytes) {
  return array(
    record(JSON.parse(serialized), "artifact-collision-snapshot").artifacts,
    "artifact-collision-artifacts",
  ).some((row, index) => {
    const artifact = record(row, `artifact-collision-row-${index}`);
    return (
      artifact.artifactId === artifactId &&
      bytesEqual(
        Buffer.from(text(artifact.bytesBase64, "artifact-collision-bytes"), "base64"),
        bytes,
      )
    );
  });
}
function snapshotHasCollisionLink(serialized, primaryArtifactId, variantArtifactId) {
  return array(
    record(JSON.parse(serialized), "artifact-collision-snapshot").auditEvents,
    "artifact-collision-audit-events",
  ).some((row, index) => {
    const event = record(row, `artifact-collision-audit-event-${index}`);
    const details = record(event.details, `artifact-collision-audit-details-${index}`);
    return (
      event.action === "put" &&
      event.outcome === "rejected" &&
      event.target === primaryArtifactId &&
      details.reason === "identity-collision" &&
      details.actualArtifactId === variantArtifactId
    );
  });
}
async function observeLocalHashCollision() {
  const collisionActor = { actorId: "artifact-collision-proof" };
  const authority = { hasCapability: () => true };
  const primaryBytes = encoder.encode("forced primary collision bytes A");
  const variantBytes = encoder.encode("forced primary collision bytes B");
  const primaryArtifactId = artifactIdForBytes(primaryBytes);
  const store = ImmutableArtifactStore.createForTesting(authority, (bytes) =>
    bytesEqual(bytes, primaryBytes) || bytesEqual(bytes, variantBytes)
      ? primaryArtifactId
      : artifactIdForBytes(bytes),
  );
  const primary = store.put({
    bytes: primaryBytes,
    retention: publicRelease("2026-01-10T00:00:00.000Z"),
    actor: collisionActor,
    at: "2026-01-04T00:03:00.000Z",
  });
  const collision = await captureError(async () =>
    store.put({
      bytes: variantBytes,
      retention: publicRelease("2026-01-10T00:00:00.000Z"),
      actor: collisionActor,
      at: "2026-01-04T00:03:01.000Z",
    }),
  );
  const variantArtifactId =
    collision instanceof ArtifactIdentityCollisionError ? collision.variantArtifactId : undefined;
  const snapshot = store.exportSnapshot({
    actor: collisionActor,
    at: "2026-01-04T00:03:02.000Z",
  });
  const reloaded = ImmutableArtifactStore.reload(
    snapshot.serialized,
    snapshot.snapshotHash,
    authority,
  );
  const original = reloaded.read({
    artifactId: primaryArtifactId,
    actor: collisionActor,
    at: "2026-01-04T00:03:03.000Z",
  });
  const variant =
    variantArtifactId === undefined
      ? undefined
      : reloaded.read({
          artifactId: variantArtifactId,
          actor: collisionActor,
          at: "2026-01-04T00:03:04.000Z",
        });
  const expectedVariantId = artifactCollisionVariantIdForBytes(primaryArtifactId, variantBytes);
  return {
    replacement:
      collision instanceof ArtifactIdentityCollisionError && bytesEqual(original, primaryBytes),
    collisionPreservesBoth:
      collision instanceof ArtifactIdentityCollisionError &&
      collision.claimedArtifactId === primaryArtifactId &&
      primary.artifactId === primaryArtifactId &&
      variantArtifactId === expectedVariantId &&
      bytesEqual(original, primaryBytes) &&
      bytesEqual(variant, variantBytes) &&
      snapshotHasArtifactBytes(snapshot.serialized, primaryArtifactId, primaryBytes) &&
      snapshotHasArtifactBytes(snapshot.serialized, expectedVariantId, variantBytes) &&
      snapshotHasCollisionLink(snapshot.serialized, primaryArtifactId, expectedVariantId),
  };
}
async function localSnapshotFailure(transform) {
  const root = mkdtempSync(join(tmpdir(), "itotori-artifact-snapshot-"));
  try {
    const repository = await openLocalImmutableArtifactRepository(root);
    await repository.put(actor, {
      bytes: encoder.encode("local snapshot control"),
      retention: publicRelease("2026-02-01T00:00:00.000Z"),
      at: "2026-01-01T00:00:00.000Z",
    });
    const path = join(root, "immutable-artifacts.json");
    writeFileSync(path, transform(readFileSync(path, "utf8")), "utf8");
    return await captureError(async () => await openLocalImmutableArtifactRepository(root));
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

async function observeLocalRepository() {
  const root = mkdtempSync(join(tmpdir(), "itotori-artifact-local-"));
  try {
    const repository = await openLocalImmutableArtifactRepository(root);
    const parent = await repository.put(actor, {
      bytes: encoder.encode("immutable parent bytes"),
      retention: publicRelease("2026-01-03T00:00:00.000Z"),
      at: "2026-01-01T00:00:00.000Z",
    });
    const childBytes = encoder.encode("immutable child bytes");
    const child = await repository.put(actor, {
      bytes: childBytes,
      parents: [parent.artifactId],
      retention: publicRelease("2026-01-03T00:00:00.000Z"),
      at: "2026-01-01T00:01:00.000Z",
    });
    const restored = await openLocalImmutableArtifactRepository(root);
    const reload =
      bytesEqual(
        await restored.read(actor, {
          artifactId: child.artifactId,
          at: "2026-01-01T00:02:00.000Z",
        }),
        childBytes,
      ) && child.artifactId === artifactIdForBytes(childBytes);
    const deniedRetention = await captureError(async () => {
      await restored.retain(
        { userId: "ordinary-artifact-reader" },
        {
          artifactId: child.artifactId,
          until: "2026-01-10T00:00:00.000Z",
          at: "2026-01-01T00:03:00.000Z",
        },
      );
    });
    const afterDeniedRetention = await restored.describe(actor, {
      artifactId: child.artifactId,
      at: "2026-01-01T00:03:30.000Z",
    });
    await restored.retain(actor, {
      artifactId: child.artifactId,
      until: "2026-01-10T00:00:00.000Z",
      at: "2026-01-01T00:04:00.000Z",
    });
    const retained = await restored.describe(actor, {
      artifactId: child.artifactId,
      at: "2026-01-01T00:05:00.000Z",
    });
    const retention =
      permissionDenied(deniedRetention, "retention.manage") &&
      afterDeniedRetention?.retention.expiresAt === "2026-01-03T00:00:00.000Z" &&
      retained?.retention.expiresAt === "2026-01-10T00:00:00.000Z";
    const expiring = await restored.put(actor, {
      bytes: encoder.encode("unreferenced expired bytes"),
      retention: publicExpiry("2026-01-02T00:00:00.000Z"),
      at: "2026-01-01T00:06:00.000Z",
    });
    const referenced = await restored.put(actor, {
      bytes: encoder.encode("referenced expired bytes"),
      retention: publicExpiry("2026-01-02T00:00:00.000Z"),
      at: "2026-01-01T00:07:00.000Z",
    });
    await restored.addReference(actor, {
      referenceId: "artifact-retention-reference",
      artifactId: referenced.artifactId,
      purpose: "lineage",
      at: "2026-01-01T00:08:00.000Z",
    });
    const receipt = await restored.prune(actor, {
      scope: [expiring.artifactId, referenced.artifactId],
      at: "2026-01-04T00:00:00.000Z",
    });
    const expiry =
      receipt.prunedArtifactIds.length === 1 &&
      receipt.prunedArtifactIds[0] === expiring.artifactId &&
      (await restored.read(actor, {
        artifactId: expiring.artifactId,
        at: "2026-01-04T00:01:00.000Z",
      })) === undefined;
    const prune = receipt.decisions.some(
      (decision) =>
        decision.artifactId === referenced.artifactId && decision.decision === "referenced",
    );
    const lineage =
      retained?.parents.length === 1 &&
      retained.parents[0] === parent.artifactId &&
      bytesEqual(
        await restored.read(actor, {
          artifactId: child.artifactId,
          at: "2026-01-04T00:02:00.000Z",
        }),
        childBytes,
      );
    const collision = await observeLocalHashCollision();
    const mutationFailure = await localSnapshotFailure(mutateSnapshotBytes);
    const versionFailure = await localSnapshotFailure(mutateSnapshotVersion);
    const auditFailure = await localSnapshotFailure(mutateSnapshotAudit);
    const auditTrail = await restored.auditTrail(actor, "2026-01-04T00:05:00.000Z");
    const audit =
      auditFailure instanceof ArtifactStoreIntegrityError &&
      auditTrail.length > 0 &&
      auditTrail.every(
        (event, index) =>
          event.ordinal === index &&
          event.actor.length > 0 &&
          event.target.length > 0 &&
          event.outcome.length > 0 &&
          (index === 0 || event.previousHash === auditTrail[index - 1]?.eventHash),
      );
    return {
      reload,
      retention,
      expiry,
      prune,
      lineage,
      replacement: collision.replacement,
      collisionPreservesBoth: collision.collisionPreservesBoth,
      mutation: mutationFailure instanceof ArtifactStoreIntegrityError,
      typedIncompatibleVersion:
        versionFailure instanceof ArtifactIncompatibleVersionError &&
        versionFailure.observedVersion === "itotori.immutable-artifact-store.v2" &&
        versionFailure.supportedVersions.includes("itotori.immutable-artifact-store.v1") &&
        versionFailure.migrationPath.length > 0,
      audit,
    };
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

function condition(name, passed, reason) {
  return { name, passed, reason };
}

async function observeArtifactBehavior() {
  const [local, database] = await Promise.all([
    observeLocalRepository(),
    observeDatabaseArtifactRepository(actor, encoder),
  ]);
  const conditions = [
    condition("reload", local.reload && database.reload, "artifact-reload-failed"),
    condition(
      "authorized-retention",
      local.retention && database.retention,
      "artifact-db-retention-extension-missing",
    ),
    condition("expiry", local.expiry && database.expiry, "artifact-expiry-failed"),
    condition(
      "collision",
      local.collisionPreservesBoth && database.collision,
      "artifact-collision-does-not-preserve-both-variants",
    ),
    condition(
      "mutation",
      local.mutation && database.mutation,
      database.mutationDatabaseRejected
        ? "artifact-db-ciphertext-write-rejected"
        : database.mutationReadDetected
          ? "artifact-tamper-read-detected"
          : "artifact-mutation-undetected",
    ),
    condition(
      "incompatible-version",
      local.typedIncompatibleVersion && database.typedIncompatibleVersion,
      "artifact-incompatible-version-not-typed",
    ),
    condition("audit", local.audit && database.audit, "artifact-db-audit-is-mutable"),
    condition(
      "lineage",
      local.lineage && database.lineage,
      "artifact-lineage-missing-after-reload",
    ),
    condition("prune", local.prune, "artifact-prune-scope-not-preserved"),
  ];
  const byName = new Map(conditions.map((entry) => [entry.name, entry]));
  const requireCondition = (name) => {
    const result = byName.get(name);
    if (result === undefined) throw new Error(`artifact-condition-missing:${name}`);
    return result;
  };
  const actions = [
    { action: "read and compare", ...requireCondition("reload") },
    { action: "expire eligible copy", ...requireCondition("expiry") },
    {
      action: "attempt replacement",
      passed: local.replacement && database.collision,
      reason: "artifact-replacement-not-refused",
    },
    { action: "mutate or truncate", ...requireCondition("audit") },
    { action: "prune unreferenced scope", ...requireCondition("prune") },
    { action: "resolve tampered bytes", ...requireCondition("mutation") },
    {
      action: "store different bytes under an existing identity",
      ...requireCondition("collision"),
    },
    {
      action: "reorder events or omit actor, target, or outcome",
      ...requireCondition("audit"),
    },
  ];
  return {
    schema: "itotori.immutable-artifact-observation.v1",
    actions,
    conditions,
    observedFields: conditions.filter(({ passed }) => passed).length + 1,
  };
}

observeArtifactBehavior()
  .then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  })
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
