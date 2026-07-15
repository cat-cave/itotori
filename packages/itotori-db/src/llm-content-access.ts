import { type AuthorizationActor, permissionValues, requirePermission } from "./authorization.js";
import type { ItotoriDatabase } from "./connection.js";

export const llmContentReadPermission = permissionValues.contentRead;

export type LlmContentReadRequest = {
  contentRef: string;
  purpose: "dispatch-input" | "memo-replay" | "transcript-projection";
};

/** Mandatory authorization port used immediately before content decryption. */
export interface LlmContentReadAuthorizer {
  requireContentRead(request: LlmContentReadRequest): Promise<void>;
}

export function permissionBasedLlmContentRead(
  db: ItotoriDatabase,
  actor: AuthorizationActor,
): LlmContentReadAuthorizer {
  return {
    async requireContentRead(): Promise<void> {
      await requirePermission(db, actor, llmContentReadPermission);
    },
  };
}
