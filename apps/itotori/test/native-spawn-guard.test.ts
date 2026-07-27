import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { classifyNativeSpawnSource, findUnsanitizedNativeSpawns } from "./native-spawn-guard.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("native spawn credential guard", () => {
  it("rejects a resolver-derived native command when its child env is not scrubbed", () => {
    const rogue = `
      const resolved = resolveNativeCli("utsushi-cli", env);
      spawn(resolved.command, args, { env, stdio: "pipe" });
    `;
    const classification = classifyNativeSpawnSource(rogue);
    expect(classification.spawnsNativeBin).toBe(true);
    expect(classification.allSitesSanitized).toBe(false);
  });

  it("accepts the live player only with its scrubbed child environment and scans the app tree", async () => {
    const source = await readFile(
      resolve(repoRoot, "apps/itotori/src/play/browser-player-session.ts"),
      "utf8",
    );
    const classification = classifyNativeSpawnSource(source);
    expect(classification.sites).toHaveLength(1);
    expect(classification.allSitesSanitized).toBe(true);
    expect(
      findUnsanitizedNativeSpawns({
        repoRoot,
        scanRoots: ["apps/itotori/src"],
        allowedInlineScrub: new Set(["apps/itotori/src/native-bin/cli-bin-resolver.ts"]),
        benignDataReferences: new Set(["apps/itotori/src/corpus-manifest/trusted-cli.ts"]),
      }),
    ).toEqual([]);
  });
});
