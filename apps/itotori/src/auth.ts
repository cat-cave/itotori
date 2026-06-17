import {
  type AuthorizationActor,
  type ItotoriDatabase,
  localUserId,
  type Permission,
  requirePermission,
} from "@itotori/db";

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
