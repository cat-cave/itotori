import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { writeFixedSuccessMutationArtifact } from "../../../../scripts/ci/behavior-fixed-success-mutation-contract.mjs";

export const cell = "cell::account.authenticate-session::all";

function replaceOnce(source, find, replacement, label) {
  const parts = source.split(find);
  if (parts.length !== 2) {
    throw new Error(`${label}-mutation-marker-count:${parts.length - 1}`);
  }
  return parts.join(replacement);
}

function compileMutatedPackage(root, packageRoot) {
  const result = spawnSync("pnpm", ["exec", "tsc", "-p", resolve(packageRoot, "tsconfig.json")], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `authenticate-session-mutation-build-failed:${result.status}\n${result.stderr}${result.stdout}`,
    );
  }
}

/**
 * Builds an isolated product copy that mints JWT-shaped session tokens and no-ops
 * revocation. The behavior boundary must observe those broken guarantees and turn
 * red; no observation is fabricated in the driver.
 */
export function prepareAuthenticateSessionFixedSuccessMutation(root, workRoot) {
  const mutationRoot = resolve(workRoot, "authenticate-session-fixed-success-mutation");
  const sourcePackage = resolve(root, "packages", "itotori-db");
  const mutatedPackage = resolve(mutationRoot, "packages", "itotori-db");
  rmSync(mutationRoot, { force: true, recursive: true });
  mkdirSync(resolve(mutationRoot, "packages"), { recursive: true });
  cpSync(sourcePackage, mutatedPackage, { recursive: true });
  copyFileSync(resolve(root, "tsconfig.base.json"), resolve(mutationRoot, "tsconfig.base.json"));

  const sessionPath = resolve(mutatedPackage, "src", "repositories", "auth-session-service.ts");
  const source = readFileSync(sessionPath, "utf8");
  let mutated = replaceOnce(
    source,
    'export function createOpaqueSessionId(): string {\n  return randomBytes(32).toString("base64url");\n}',
    'export function createOpaqueSessionId(): string {\n  // Mutated: mint JWT-shaped claims blobs instead of opaque tokens.\n  return `eyJhbGciOiJub25lIn0.${randomBytes(16).toString("base64url")}.signature`;\n}',
    "opaque-session-id",
  );
  mutated = replaceOnce(
    mutated,
    "async revokeSession(sessionId: string, revokedAt = new Date()): Promise<boolean> {\n    const rows = await this.db\n      .update(authSessions)\n      .set({ revokedAt })\n      .where(and(eq(authSessions.sessionId, sessionId), isNull(authSessions.revokedAt)))\n      .returning({ sessionId: authSessions.sessionId });\n    return rows.length > 0;\n  }",
    "async revokeSession(sessionId: string, revokedAt = new Date()): Promise<boolean> {\n    void sessionId;\n    void revokedAt;\n    return true;\n  }",
    "revoke-session-noop",
  );
  writeFileSync(sessionPath, mutated, "utf8");
  compileMutatedPackage(root, mutatedPackage);

  const emitted = readFileSync(
    resolve(mutatedPackage, "dist", "repositories", "auth-session-service.js"),
    "utf8",
  );
  if (!emitted.includes("eyJhbGciOiJub25lIn0") || !emitted.includes("void sessionId")) {
    throw new Error("authenticate-session-mutation-build-marker-missing");
  }
  if (!emitted.includes(".signature`") && !emitted.includes(".signature")) {
    throw new Error("authenticate-session-mutation-jwt-marker-missing");
  }
  return mutationRoot;
}

export function prepareFixedSuccessMutation(root, workRoot) {
  const mutationRoot = prepareAuthenticateSessionFixedSuccessMutation(root, workRoot);
  return {
    mutationRoot,
    mutationArtifactPath: writeFixedSuccessMutationArtifact(mutationRoot, cell),
  };
}
