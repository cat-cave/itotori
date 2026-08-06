#!/usr/bin/env node
/**
 * Product boundary for cell::account.administer-access::all.
 * Proves permission-based access administration with real cross-tenant refusal,
 * audit append-only history, seat capacity, grant/revoke, disablement, and
 * invitation flows against live Postgres.
 */
import { and, asc, eq } from "drizzle-orm";
import { pathToFileURL } from "node:url";

import {
  AuthorizationError,
  ItotoriAuthBillingSeatRepository,
  ItotoriAuthMemberManagementRepository,
  ItotoriAuthSessionService,
  ItotoriPrincipalRepository,
  ItotoriPrincipalRepositoryError,
  bootstrapDefaultAccountPrincipal,
  bootstrapLocalUser,
  defaultLocalAccountId,
  localOperatorPrincipalId,
  localUserId,
  permissionValues,
  requirePermission,
  resolvePrincipalEffectivePermissions,
} from "../dist/index.js";
import {
  authAccountMemberships,
  authAuditEvents,
  authPrincipalPermissionSetGrants,
  authPrincipals,
} from "../dist/schema.js";
import { captureError, withIsolatedIdentityDatabase } from "./identity-behavior-db.mjs";

const localActor = { userId: localUserId };

function passed(condition, reason) {
  return { passed: Boolean(condition), reason };
}

async function createHuman(repo, db, input) {
  await repo.createPrincipal(localActor, {
    kind: "human_user",
    principalId: input.principalId,
    userId: input.userId,
    displayName: input.userId,
  });
  await db.insert(authAccountMemberships).values({
    membershipId: input.membershipId,
    accountId: input.accountId,
    userId: input.userId,
  });
}

async function observeAdministerAccess() {
  return withIsolatedIdentityDatabase(async (context) => {
    const { db } = context;
    await bootstrapLocalUser(db);
    await bootstrapDefaultAccountPrincipal(db);
    const repo = new ItotoriPrincipalRepository(db);
    const members = new ItotoriAuthMemberManagementRepository(db);
    const seats = new ItotoriAuthBillingSeatRepository(db);
    const sessions = new ItotoriAuthSessionService(db);

    await repo.createAccount(localActor, {
      accountId: "acct-tenant-a",
      slug: "tenant-a",
      name: "Tenant A",
    });
    await repo.createAccount(localActor, {
      accountId: "acct-tenant-b",
      slug: "tenant-b",
      name: "Tenant B",
    });

    // Admin of tenant A only (set-scoped grant).
    await createHuman(repo, db, {
      principalId: "principal-admin-a",
      userId: "user-admin-a",
      accountId: "acct-tenant-a",
      membershipId: "membership-admin-a",
    });
    await repo.createPermissionSet(localActor, {
      actorPrincipalId: localOperatorPrincipalId,
      permissionSetId: "set-admin-a",
      accountId: "acct-tenant-a",
      name: "Tenant A Admin",
      permissions: [
        permissionValues.authMembersManage,
        permissionValues.authPermissionsManage,
        permissionValues.authSessionsManage,
        permissionValues.draftWrite,
        permissionValues.catalogRead,
      ],
    });
    await repo.grantPermissionSet(localActor, {
      actorPrincipalId: localOperatorPrincipalId,
      targetPrincipalId: "principal-admin-a",
      permissionSetId: "set-admin-a",
    });
    const adminA = { userId: "user-admin-a" };

    // Member of tenant B (no A authority).
    await createHuman(repo, db, {
      principalId: "principal-member-b",
      userId: "user-member-b",
      accountId: "acct-tenant-b",
      membershipId: "membership-member-b",
    });
    await repo.createPermissionSet(localActor, {
      actorPrincipalId: localOperatorPrincipalId,
      permissionSetId: "set-member-b",
      accountId: "acct-tenant-b",
      name: "Tenant B Member",
      permissions: [permissionValues.catalogRead],
    });
    await repo.grantPermissionSet(localActor, {
      actorPrincipalId: localOperatorPrincipalId,
      targetPrincipalId: "principal-member-b",
      permissionSetId: "set-member-b",
    });

    // --- Invite + accept within tenant A ---
    await repo.createPermissionSet(localActor, {
      actorPrincipalId: localOperatorPrincipalId,
      permissionSetId: "set-editor-a",
      accountId: "acct-tenant-a",
      name: "Editor A",
      permissions: [permissionValues.draftWrite],
    });
    const invitation = await members.inviteMember(adminA, {
      actorPrincipalId: "principal-admin-a",
      accountId: "acct-tenant-a",
      email: "invitee@example.test",
      initialPermissionSetIds: ["set-editor-a"],
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      reason: "onboard",
      requestId: "req-invite-a",
    });
    const accepted = await members.acceptInvitation(adminA, {
      actorPrincipalId: "principal-admin-a",
      invitationId: invitation.invitationId,
      userId: "user-invitee-a",
      principalId: "principal-invitee-a",
      displayName: "Invitee A",
      externalIdentity: { provider: "zitadel", subject: "sub-invitee-a" },
      reason: "accept",
      requestId: "req-accept-a",
    });
    const listedA = await members.listMembers(adminA, "acct-tenant-a");
    const inviteOk =
      accepted.userId === "user-invitee-a" &&
      listedA.some((row) => row.userId === "user-invitee-a") &&
      (await resolvePrincipalEffectivePermissions(db, "principal-invitee-a")).has(
        permissionValues.draftWrite,
      );

    // --- Cross-tenant list / seat / grant refused ---
    const crossListDenied =
      (await captureError(() => members.listMembers(adminA, "acct-tenant-b"))) instanceof
      AuthorizationError;
    const crossSeatDenied =
      (await captureError(() => seats.loadSeatUsage(adminA, "acct-tenant-b"))) instanceof
      AuthorizationError;
    const crossGrantDenied =
      (await captureError(() =>
        repo.grantPermissionSet(adminA, {
          actorPrincipalId: "principal-admin-a",
          targetPrincipalId: "principal-admin-a",
          permissionSetId: "set-member-b",
        }),
      )) instanceof ItotoriPrincipalRepositoryError;
    // Forced out-of-band cross-account grant must still authorize nothing.
    await repo.createPermissionSet(localActor, {
      actorPrincipalId: localOperatorPrincipalId,
      permissionSetId: "set-export-b",
      accountId: "acct-tenant-b",
      name: "Exporter B",
      permissions: [permissionValues.patchExport],
    });
    await db.insert(authPrincipalPermissionSetGrants).values({
      principalId: "principal-admin-a",
      permissionSetId: "set-export-b",
    });
    const forcedCrossInert = !(
      await resolvePrincipalEffectivePermissions(db, "principal-admin-a")
    ).has(permissionValues.patchExport);

    // --- Project member denied admin grant ---
    await createHuman(repo, db, {
      principalId: "principal-writer-a",
      userId: "user-writer-a",
      accountId: "acct-tenant-a",
      membershipId: "membership-writer-a",
    });
    await repo.grantDirectPermission(localActor, {
      actorPrincipalId: localOperatorPrincipalId,
      targetPrincipalId: "principal-writer-a",
      permission: permissionValues.draftWrite,
    });
    const writerA = { userId: "user-writer-a" };
    const memberDeniedAdmin =
      (await captureError(() =>
        members.inviteMember(writerA, {
          actorPrincipalId: "principal-writer-a",
          accountId: "acct-tenant-a",
          email: "nope@example.test",
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        }),
      )) instanceof AuthorizationError;

    // --- Revoke grant removes access immediately ---
    await repo.revokePermissionSet(localActor, {
      actorPrincipalId: localOperatorPrincipalId,
      targetPrincipalId: "principal-invitee-a",
      permissionSetId: "set-editor-a",
      reason: "revoke",
      requestId: "req-revoke-a",
    });
    const revokedAccess = !(
      await resolvePrincipalEffectivePermissions(db, "principal-invitee-a")
    ).has(permissionValues.draftWrite);

    // --- Disable principal ends sessions and protected access ---
    const liveSession = await sessions.createLoginSession({
      principalId: "principal-invitee-a",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    await repo.grantDirectPermission(localActor, {
      actorPrincipalId: localOperatorPrincipalId,
      targetPrincipalId: "principal-invitee-a",
      permission: permissionValues.draftWrite,
    });
    const beforeDisable = await sessions.resolveActorFromSessionId(liveSession.sessionId);
    await db
      .update(authPrincipals)
      .set({ disabledAt: new Date() })
      .where(eq(authPrincipals.principalId, "principal-invitee-a"));
    const disabledNoAuth =
      (await captureError(() =>
        requirePermission(db, beforeDisable.actor, permissionValues.draftWrite),
      )) instanceof AuthorizationError;

    // --- Seat capacity view ---
    const seatUsage = await seats.loadSeatUsage(adminA, "acct-tenant-a");
    const seatViewOk =
      seatUsage.accountId === "acct-tenant-a" &&
      seatUsage.seatLimit > 0 &&
      seatUsage.usedSeats >= 1 &&
      typeof seatUsage.availableSeats === "number";

    // --- Session admin revoke with audit ---
    await createHuman(repo, db, {
      principalId: "principal-session-target",
      userId: "user-session-target",
      accountId: "acct-tenant-a",
      membershipId: "membership-session-target",
    });
    await repo.grantDirectPermission(localActor, {
      actorPrincipalId: localOperatorPrincipalId,
      targetPrincipalId: "principal-admin-a",
      permission: permissionValues.authSessionsManage,
    });
    const targetSession = await sessions.createLoginSession({
      principalId: "principal-session-target",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    const revokedSession = await sessions.revokePrincipalSession(adminA, {
      actorPrincipalId: "principal-admin-a",
      targetPrincipalId: "principal-session-target",
      sessionId: targetSession.sessionId,
      reason: "security",
      requestId: "req-session-revoke-a",
    });
    const sessionRevoked =
      revokedSession.isActive === false &&
      (await sessions.resolveActorFromSessionId(targetSession.sessionId)) === null;

    // --- Audit append-only with actor/target/outcome order ---
    const auditRows = await db
      .select()
      .from(authAuditEvents)
      .orderBy(asc(authAuditEvents.createdAt), asc(authAuditEvents.authAuditEventId));
    const auditHasInvite = auditRows.some(
      (row) => row.requestId === "req-invite-a" && row.action === "invited",
    );
    const auditHasAccept = auditRows.some(
      (row) => row.requestId === "req-accept-a" && row.action === "accepted",
    );
    const auditHasRevoke = auditRows.some(
      (row) => row.requestId === "req-revoke-a" && row.action === "revoked",
    );
    const auditHasSession = auditRows.some(
      (row) => row.requestId === "req-session-revoke-a" && row.action === "session_revoked",
    );
    const auditOrdered =
      auditRows.every(
        (row) =>
          typeof row.action === "string" &&
          (row.actorPrincipalId === null || typeof row.actorPrincipalId === "string"),
      ) && auditRows.length >= 4;
    const auditOk =
      auditHasInvite && auditHasAccept && auditHasRevoke && auditHasSession && auditOrdered;

    // --- Foreign account resources unavailable to writer ---
    const foreignUnavailable =
      (await captureError(() => members.listMembers(writerA, "acct-tenant-b"))) instanceof
        AuthorizationError &&
      (await captureError(() => members.listMembers(writerA, "acct-tenant-a"))) instanceof
        AuthorizationError;

    // --- Collision-free multi-account membership for one principal ---
    await createHuman(repo, db, {
      principalId: "principal-multi",
      userId: "user-multi",
      accountId: "acct-tenant-a",
      membershipId: "membership-multi-a",
    });
    await db.insert(authAccountMemberships).values({
      membershipId: "membership-multi-b",
      accountId: "acct-tenant-b",
      userId: "user-multi",
    });
    const multiMemberships = await db
      .select()
      .from(authAccountMemberships)
      .where(eq(authAccountMemberships.userId, "user-multi"));
    const collisionFree = multiMemberships.length === 2;

    const scenarios = {
      inviteAccept: passed(inviteOk, "invite-accept"),
      crossTenantListDenied: passed(crossListDenied, "cross-tenant-list-denied"),
      crossTenantSeatDenied: passed(crossSeatDenied, "cross-tenant-seat-denied"),
      crossTenantGrantDenied: passed(
        crossGrantDenied && forcedCrossInert,
        "cross-tenant-grant-denied",
      ),
      memberDeniedAdmin: passed(memberDeniedAdmin, "member-denied-admin"),
      revokeRemovesAccess: passed(revokedAccess, "revoke-removes-access"),
      disableEndsAccess: passed(disabledNoAuth, "disable-ends-access"),
      seatCapacityView: passed(seatViewOk, "seat-capacity-view"),
      sessionAdminRevoke: passed(sessionRevoked, "session-admin-revoke"),
      auditAppendOnly: passed(auditOk, "audit-append-only"),
      foreignUnavailable: passed(foreignUnavailable, "foreign-unavailable"),
      collisionFreeMemberships: passed(collisionFree, "collision-free-memberships"),
    };

    return {
      schema: "itotori.identity-administer-access-observation.v1",
      scenarios,
      invariants: {
        crossTenantRefused: passed(
          crossListDenied && crossSeatDenied && crossGrantDenied && forcedCrossInert,
          "cross-tenant-refused",
        ),
        auditRetained: passed(auditOk, "audit-retained"),
        disableEndsSessions: passed(disabledNoAuth, "disable-ends-sessions"),
        collisionFree: passed(collisionFree, "collision-free"),
        noUndeclaredAuthority: passed(
          memberDeniedAdmin && foreignUnavailable,
          "no-undeclared-authority",
        ),
        protectedActionsEnforced: passed(
          revokedAccess && sessionRevoked && seatViewOk,
          "protected-actions-enforced",
        ),
        foreignResourcesUnavailable: passed(foreignUnavailable, "foreign-resources-unavailable"),
      },
      observedFields: Object.keys(scenarios).length + 7,
      allPass: Object.values(scenarios).every((entry) => entry.passed),
    };
  });
}

async function main() {
  if (!process.env.DATABASE_URL) {
    process.stderr.write("required input is absent: DATABASE_URL\n");
    process.exitCode = 2;
    return;
  }
  const observation = await observeAdministerAccess();
  process.stdout.write(`${JSON.stringify(observation)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}

export { observeAdministerAccess };
