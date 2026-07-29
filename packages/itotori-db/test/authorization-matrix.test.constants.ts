import type { AuthorizationActor } from "../src/authorization.js";

export const deniedActor: AuthorizationActor = { userId: "user-without-required-permission" };
