import { type AuthorizationActor, localUserId } from "@itotori/db";

export const localUserActor: AuthorizationActor = { userId: localUserId };
