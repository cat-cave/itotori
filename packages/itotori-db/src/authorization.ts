import { and, eq } from "drizzle-orm";
import type { ItotoriDatabase } from "./connection.js";
import { userPermissionGrants, users } from "./schema.js";

// Source of truth for permission values. SQL migration constraints must be
// updated to match these constants; see docs/permissions.md.
export const permissionValues = {
  projectImport: "project.import",
  draftWrite: "draft.write",
  patchExport: "patch.export",
  runtimeIngest: "runtime.ingest",
  feedbackImport: "feedback.import",
  queueManage: "queue.manage",
  queueRead: "queue.read",
  catalogRead: "catalog.read",
  catalogWrite: "catalog.write",
  auditWrite: "audit.write",
  styleGuideApprove: "style_guide.approve",
  authAdmin: "auth.admin",
  systemReset: "system.reset",
} as const;

export type Permission = (typeof permissionValues)[keyof typeof permissionValues];

export const allPermissions = [
  permissionValues.projectImport,
  permissionValues.draftWrite,
  permissionValues.patchExport,
  permissionValues.runtimeIngest,
  permissionValues.feedbackImport,
  permissionValues.queueManage,
  permissionValues.queueRead,
  permissionValues.catalogRead,
  permissionValues.catalogWrite,
  permissionValues.auditWrite,
  permissionValues.styleGuideApprove,
  permissionValues.authAdmin,
  permissionValues.systemReset,
] as const satisfies readonly Permission[];

export const localUserId = "local-user";
export const localUserDisplayName = "Local user";

export type AuthorizationActor = {
  userId: string;
};

export class AuthorizationError extends Error {
  constructor(
    readonly actor: AuthorizationActor,
    readonly permission: Permission,
  ) {
    super(`user ${actor.userId} is missing permission ${permission}`);
    this.name = "AuthorizationError";
  }
}

export async function requirePermission(
  db: ItotoriDatabase,
  actor: AuthorizationActor,
  permission: Permission,
): Promise<void> {
  const grant = await db
    .select({ permission: userPermissionGrants.permission })
    .from(userPermissionGrants)
    .where(
      and(
        eq(userPermissionGrants.userId, actor.userId),
        eq(userPermissionGrants.permission, permission),
      ),
    )
    .limit(1);

  if (grant.length === 0) {
    throw new AuthorizationError(actor, permission);
  }
}

export async function bootstrapLocalUser(db: ItotoriDatabase): Promise<AuthorizationActor> {
  await db
    .insert(users)
    .values({ userId: localUserId, displayName: localUserDisplayName })
    .onConflictDoNothing();

  for (const permission of allPermissions) {
    await db
      .insert(userPermissionGrants)
      .values({ userId: localUserId, permission })
      .onConflictDoNothing();
  }

  return { userId: localUserId };
}
