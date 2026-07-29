import { eq } from "drizzle-orm";
import {
  isReservedAuthUserId,
  localOperatorUserId,
  localUserDisplayName,
  localUserId,
} from "../authorization.js";
import type { ItotoriDatabase } from "../connection.js";
import {
  authAccountMemberships,
  authAccounts,
  authPermissionSets,
  authPrincipalPermissionSetGrants,
  authPrincipals,
  authServicePrincipals,
  authUsers,
} from "../schema.js";
import { ItotoriPrincipalRepositoryError } from "./principal-repository-types.js";
import type {
  AccountRecord,
  ActorIdentityRecord,
  CreateAccountInput,
  CreatePrincipalInput,
  PrincipalRecord,
} from "./principal-repository-types.js";

export async function createAccount(
  db: ItotoriDatabase,
  input: CreateAccountInput,
): Promise<AccountRecord> {
  await db.insert(authAccounts).values({
    accountId: input.accountId,
    slug: input.slug,
    name: input.name,
  });
  return { accountId: input.accountId, slug: input.slug, name: input.name };
}

export async function createPrincipal(
  db: ItotoriDatabase,
  input: CreatePrincipalInput,
): Promise<PrincipalRecord> {
  if (input.kind === "human_user" && isReservedAuthUserId(input.userId)) {
    throw new ItotoriPrincipalRepositoryError(
      `userId ${input.userId} is reserved for the legacy single-user substrate and ` +
        "cannot be registered as an auth principal",
    );
  }
  return db.transaction(async (tx) => {
    await tx.insert(authPrincipals).values({
      principalId: input.principalId,
      principalKind: input.kind,
    });
    if (input.kind === "human_user") {
      await tx.insert(authUsers).values({
        userId: input.userId,
        principalId: input.principalId,
        displayName: input.displayName,
        ...(input.email !== undefined ? { email: input.email } : {}),
      });
    } else {
      await tx.insert(authServicePrincipals).values({
        servicePrincipalId: input.servicePrincipalId,
        principalId: input.principalId,
        accountId: input.accountId,
        displayName: input.displayName,
      });
    }
    return {
      principalId: input.principalId,
      principalKind: input.kind,
      displayName: input.displayName,
    };
  });
}

export async function loadPrincipal(
  db: ItotoriDatabase,
  principalId: string,
): Promise<PrincipalRecord | undefined> {
  const rows = await db
    .select({ principalKind: authPrincipals.principalKind })
    .from(authPrincipals)
    .where(eq(authPrincipals.principalId, principalId))
    .limit(1);
  const principal = rows[0];
  if (principal === undefined) return undefined;
  const displayName =
    principal.principalKind === "human_user"
      ? (
          await db
            .select({ displayName: authUsers.displayName })
            .from(authUsers)
            .where(eq(authUsers.principalId, principalId))
            .limit(1)
        )[0]?.displayName
      : (
          await db
            .select({ displayName: authServicePrincipals.displayName })
            .from(authServicePrincipals)
            .where(eq(authServicePrincipals.principalId, principalId))
            .limit(1)
        )[0]?.displayName;
  if (displayName === undefined) {
    throw new ItotoriPrincipalRepositoryError(
      `principal ${principalId} (${principal.principalKind}) has no subtype identity row`,
    );
  }
  return { principalId, principalKind: principal.principalKind, displayName };
}

export async function loadActorIdentity(
  db: ItotoriDatabase,
  actorUserId: string,
): Promise<ActorIdentityRecord> {
  const identityUserId = actorUserId === localUserId ? localOperatorUserId : actorUserId;
  const userRows = await db
    .select({
      userId: authUsers.userId,
      principalId: authUsers.principalId,
      email: authUsers.email,
      displayName: authUsers.displayName,
    })
    .from(authUsers)
    .where(eq(authUsers.userId, identityUserId))
    .limit(1);
  const user = userRows[0];
  if (user === undefined) {
    return {
      actorUserId,
      userId: actorUserId,
      principalId: null,
      email: null,
      displayName: actorUserId === localUserId ? localUserDisplayName : actorUserId,
      accounts: [],
    };
  }

  const memberships = await db
    .select({
      membershipId: authAccountMemberships.membershipId,
      accountId: authAccountMemberships.accountId,
      accountSlug: authAccounts.slug,
      accountName: authAccounts.name,
      createdAt: authAccountMemberships.createdAt,
    })
    .from(authAccountMemberships)
    .innerJoin(authAccounts, eq(authAccounts.accountId, authAccountMemberships.accountId))
    .where(eq(authAccountMemberships.userId, user.userId));
  const permissionSetRows = await db
    .select({
      accountId: authPermissionSets.accountId,
      permissionSetId: authPrincipalPermissionSetGrants.permissionSetId,
    })
    .from(authPrincipalPermissionSetGrants)
    .innerJoin(
      authPermissionSets,
      eq(authPermissionSets.permissionSetId, authPrincipalPermissionSetGrants.permissionSetId),
    )
    .where(eq(authPrincipalPermissionSetGrants.principalId, user.principalId));
  const permissionSetIdsByAccount = new Map<string, string[]>();
  for (const row of permissionSetRows) {
    const ids = permissionSetIdsByAccount.get(row.accountId) ?? [];
    ids.push(row.permissionSetId);
    permissionSetIdsByAccount.set(row.accountId, ids);
  }

  return {
    actorUserId,
    userId: user.userId,
    principalId: user.principalId,
    email: user.email,
    displayName: user.displayName,
    accounts: memberships.map((membership) => ({
      membershipId: membership.membershipId,
      accountId: membership.accountId,
      accountSlug: membership.accountSlug,
      accountName: membership.accountName,
      permissionSetIds: [...(permissionSetIdsByAccount.get(membership.accountId) ?? [])].sort(),
      createdAt: membership.createdAt,
    })),
  };
}
