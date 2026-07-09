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

/** The four hi-fi Studio capabilities gated by exact permission grants. */
export type StudioCapability = "flag" | "decide" | "steer" | "reveal";

/**
 * fnd-caps-context — Studio capability → exact Permission mapping.
 *
 * Capabilities are permissions, NOT roles. Each flag / decide / steer / reveal
 * action is gated by one exact-match permission grant resolved through the
 * auth epic's effective-permission resolver (`requirePermission` →
 * `resolvePrincipalEffectivePermissions` / legacy grants). Nothing branches
 * on a role string.
 *
 *   canFlag   ← feedback.import  (playtester flags into the review queue)
 *   canDecide ← queue.manage     (reviewer approve / queue-correction)
 *   canSteer  ← draft.write      (director launch next pass — same as
 *                                  ovw-launch-pass-action)
 *   canReveal ← catalog.read     (privileged content detail / unredacted
 *                                  frames — same gate as detailed project
 *                                  + runtime status reads)
 */
export const studioCapabilityPermissions = {
  flag: permissionValues.feedbackImport,
  decide: permissionValues.queueManage,
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
  decide: string | null;
  steer: string | null;
  reveal: string | null;
  queueRead: string | null;
  queueManage: string | null;
};

/**
 * fnd-caps-context — the client-facing permission VIEW that extends the
 * reviewer-queue view beyond the queue. Sourced from exact permission grants
 * via {@link resolveStudioCapabilityPermissionView}; the SPA CapsProvider
 * consumes this shape (never a role name).
 */
export type StudioCapabilityPermissionView = ReviewerQueuePermissionView & {
  canFlag: boolean;
  canDecide: boolean;
  canSteer: boolean;
  canReveal: boolean;
  denials: StudioCapabilityDenials;
};

export async function resolveReviewerQueuePermissionView(
  authorization: ItotoriAuthorizationPort,
  actorUserId: string,
): Promise<ReviewerQueuePermissionView> {
  // Extend-beyond-queue: resolve the full studio capability view and project
  // the queue subset so both surfaces share ONE resolver path. Queue denial
  // reasons stay queue-scoped (callers of this view only care about
  // queue.read / queue.manage).
  const studio = await resolveStudioCapabilityPermissionView(authorization, actorUserId);
  const denialReasons: string[] = [];
  if (studio.denials.queueRead !== null) {
    denialReasons.push(studio.denials.queueRead);
  }
  if (studio.denials.queueManage !== null) {
    denialReasons.push(studio.denials.queueManage);
  }
  return {
    actorUserId: studio.actorUserId,
    canReadQueue: studio.canReadQueue,
    canManageQueue: studio.canManageQueue,
    denialReasons,
  };
}

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
  const [canReadQueue, queueReadDenial] = await tryRequirePermission(
    authorization,
    permissionValues.queueRead,
  );
  const [canManageQueue, queueManageDenial] = await tryRequirePermission(
    authorization,
    permissionValues.queueManage,
  );
  const [canFlag, flagDenial] = await tryRequirePermission(
    authorization,
    studioCapabilityPermissions.flag,
  );
  const [canDecide, decideDenial] = await tryRequirePermission(
    authorization,
    studioCapabilityPermissions.decide,
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
    decide: decideDenial,
    steer: steerDenial,
    reveal: revealDenial,
    queueRead: queueReadDenial,
    queueManage: queueManageDenial,
  };

  const denialReasons: string[] = [];
  for (const reason of Object.values(denials)) {
    if (reason !== null) {
      denialReasons.push(reason);
    }
  }

  return {
    actorUserId,
    canReadQueue,
    canManageQueue,
    canFlag,
    canDecide,
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
