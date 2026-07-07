import {
  AuthorizationError,
  type AuthorizationActor,
  type ItotoriDatabase,
  localUserId,
  type Permission,
  permissionValues,
  requirePermission,
} from "@itotori/db";

/**
 * The default app-side authorization actor.
 *
 * auth-003 DECISION: this STAYS the legacy `local-user` actor. The local
 * operator now ALSO has a multi-user principal representation (a default account
 * + `local-operator` principal + editable all-permissions set, seeded by
 * `bootstrapDefaultAccountPrincipal`), but the default actor deliberately keeps
 * resolving through the legacy `itotori_user_permission_grants` all-grant so
 * every existing `{ userId: "local-user" }` caller authorizes unchanged and no
 * behavior regresses. `local-user` is intentionally NOT registered in
 * `itotori_auth_users` (reserved by migration 0061); the multi-user principal is
 * the SEPARATE, non-colliding `local-operator`. Multi-user / auth-admin flows
 * that need a principal-backed actor use the operator principal directly.
 */
export const localUserActor: AuthorizationActor = { userId: localUserId };

export interface ItotoriAuthorizationPort {
  requirePermission(permission: Permission): Promise<void>;
}

export class ItotoriAuthorizationService implements ItotoriAuthorizationPort {
  constructor(
    private readonly db: ItotoriDatabase,
    private readonly actor: AuthorizationActor = localUserActor,
  ) {}

  async requirePermission(permission: Permission): Promise<void> {
    await requirePermission(this.db, this.actor, permission);
  }
}

/**
 * Permission view consumed by the reviewer detail SPA route
 * (ITOTORI-082). Resolved here (and not inside the route loader) so
 * that all `requirePermission` callsites stay confined to the
 * canonical auth / api-handler boundary per the API mutation
 * permission matrix audit.
 */
export type ReviewerQueuePermissionView = {
  actorUserId: string;
  canReadQueue: boolean;
  canManageQueue: boolean;
  denialReasons: string[];
};

export async function resolveReviewerQueuePermissionView(
  authorization: ItotoriAuthorizationPort,
  actorUserId: string,
): Promise<ReviewerQueuePermissionView> {
  const [canReadQueue, readDenial] = await tryRequirePermission(
    authorization,
    permissionValues.queueRead,
  );
  const [canManageQueue, manageDenial] = await tryRequirePermission(
    authorization,
    permissionValues.queueManage,
  );
  const denialReasons: string[] = [];
  if (readDenial !== null) {
    denialReasons.push(readDenial);
  }
  if (manageDenial !== null) {
    denialReasons.push(manageDenial);
  }
  return {
    actorUserId,
    canReadQueue,
    canManageQueue,
    denialReasons,
  };
}

async function tryRequirePermission(
  authorization: ItotoriAuthorizationPort,
  permission: Permission,
): Promise<[boolean, string | null]> {
  try {
    await authorization.requirePermission(permission);
    return [true, null];
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return [false, error.message];
    }
    throw error;
  }
}
