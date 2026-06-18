import { expect } from "vitest";
import type { AuthorizationActor, Permission } from "../src/authorization.js";

export type DeniedMutationExpectation = {
  actor: AuthorizationActor;
  permission: Permission;
  run: () => Promise<unknown>;
};

export async function assertDeniedRepositoryMutation({
  actor,
  permission,
  run,
}: DeniedMutationExpectation): Promise<void> {
  await expect(run()).rejects.toMatchObject({
    name: "AuthorizationError",
    actor,
    permission,
  });
}

export type ForbiddenApiMutationResponse = {
  statusCode: number;
  body: {
    code?: unknown;
    error?: unknown;
  };
};

export function assertForbiddenApiMutation(
  response: ForbiddenApiMutationResponse,
  { actor, permission }: Pick<DeniedMutationExpectation, "actor" | "permission">,
): void {
  expect(response.statusCode).toBe(403);
  expect(response.body).toMatchObject({ code: "forbidden" });
  expect(String(response.body.error)).toContain(
    `user ${actor.userId} is missing permission ${permission}`,
  );
}
