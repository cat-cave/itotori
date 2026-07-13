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

/** The three Studio capabilities gated by exact permission grants. */
export type StudioCapability = "flag" | "steer" | "reveal";

/**
 * fnd-caps-context — Studio capability → exact Permission mapping.
 *
 * Capabilities are permissions, NOT roles. Each flag / steer / reveal
 * action is gated by one exact-match permission grant resolved through the
 * auth epic's effective-permission resolver (`requirePermission` →
 * `resolvePrincipalEffectivePermissions` / legacy grants). Nothing branches
 * on a role string.
 *
 *   canFlag   ← feedback.import  (playtester flags into canonical context)
 *   canSteer  ← draft.write      (director launch next pass — same as
 *                                  ovw-launch-pass-action)
 *   canReveal ← catalog.read     (privileged content detail / unredacted
 *                                  frames — same gate as detailed project
 *                                  + runtime status reads)
 */
export const studioCapabilityPermissions = {
  flag: permissionValues.feedbackImport,
  steer: permissionValues.draftWrite,
  reveal: permissionValues.catalogRead,
} as const satisfies Readonly<Record<StudioCapability, Permission>>;

/**
 * Per-capability denial explanations. A null value means the capability is
 * granted; a non-null string is the AuthorizationError message (or a stable
 * explanation) so the SPA can disable the action AND explain why.
 */
export type StudioCapabilityDenials = {
  flag: string | null;
  steer: string | null;
  reveal: string | null;
};

/**
 * fnd-caps-context — the client-facing permission view resolved from exact
 * grants. The SPA CapsProvider consumes this shape (never a role name).
 */
export type StudioCapabilityPermissionView = {
  actorUserId: string;
  canFlag: boolean;
  canSteer: boolean;
  canReveal: boolean;
  denials: StudioCapabilityDenials;
  denialReasons: string[];
};

/**
 * fnd-caps-context — resolve the actor's Studio capability view by probing
 * each capability's underlying Permission through the authorization port
 * (which is backed by the auth-002 effective-permission resolver). A missing
 * grant becomes `canX=false` + a denial explanation; non-AuthorizationError
 * failures rethrow.
 */
export async function resolveStudioCapabilityPermissionView(
  authorization: ItotoriAuthorizationPort,
  actorUserId: string,
): Promise<StudioCapabilityPermissionView> {
  const [canFlag, flagDenial] = await tryRequirePermission(
    authorization,
    studioCapabilityPermissions.flag,
  );
  const [canSteer, steerDenial] = await tryRequirePermission(
    authorization,
    studioCapabilityPermissions.steer,
  );
  const [canReveal, revealDenial] = await tryRequirePermission(
    authorization,
    studioCapabilityPermissions.reveal,
  );

  const denials: StudioCapabilityDenials = {
    flag: flagDenial,
    steer: steerDenial,
    reveal: revealDenial,
  };

  const denialReasons: string[] = [];
  for (const reason of Object.values(denials)) {
    if (reason !== null) {
      denialReasons.push(reason);
    }
  }

  return {
    actorUserId,
    canFlag,
    canSteer,
    canReveal,
    denials,
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
