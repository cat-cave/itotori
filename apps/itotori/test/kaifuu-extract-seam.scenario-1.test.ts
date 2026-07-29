import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolvePrivateCorpus } from "../src/private-inventory.js";
import {
  extractCapabilities,
  registeredExtractEngines,
  resolveExtractAdapter,
  runKaifuuExtract,
  type KaifuuExtractArgs,
} from "../src/extract/kaifuu-extract-seam.js";

describe("extract-adapter registry", () => {
  it("registers reallive, softpal, rpg-maker, and siglus adapters", () => {
    expect(registeredExtractEngines()).toEqual(["reallive", "softpal", "rpg-maker", "siglus"]);
    expect(extractCapabilities().map((capability) => capability.engine)).toEqual([
      "reallive",
      "softpal",
      "rpg-maker",
      "siglus",
    ]);
  });

  it("rejects an unregistered engine at the boundary (no reallive default)", () => {
    // A caller that bypasses the type union (e.g. a raw CLI string) is refused,
    // NOT silently routed to RealLive.
    const rogue = { engine: "kirikiri", bundleOutputPath: "/run/bridge.json" };
    expect(() => runKaifuuExtract(rogue as unknown as KaifuuExtractArgs)).toThrow(
      /is not a registered extract adapter/u,
    );
    expect(() => resolveExtractAdapter("kirikiri")).toThrow(
      /registered: reallive, softpal, rpg-maker, siglus/u,
    );
  });

  it("each adapter parses ONLY its own engine's CLI flags into a typed source", () => {
    const rpg = resolveExtractAdapter("rpg-maker").parseCli([
      "extract",
      "--engine",
      "rpg-maker",
      "--game-dir",
      "/games/rpg/www",
      "--game-id",
      "g",
      "--game-version",
      "1",
      "--source-profile-id",
      "p",
      "--source-locale",
      "ja-JP",
      "--bundle-output",
      "/run/bridge.json",
    ]);
    expect(rpg).toEqual({
      engine: "rpg-maker",
      gameId: "g",
      gameVersion: "1",
      sourceProfileId: "p",
      sourceLocale: "ja-JP",
      gameDir: "/games/rpg/www",
    });
    // RealLive-only mode flags are refused on the whole-game rpg-maker arm.
    expect(() =>
      resolveExtractAdapter("rpg-maker").parseCli(["--engine", "rpg-maker", "--scene", "1"]),
    ).toThrow(/rpg-maker is whole-game/u);

    const siglus = resolveExtractAdapter("siglus").parseCli([
      "extract",
      "--engine",
      "siglus",
      "--game-root",
      "/games/siglus",
      "--game-id",
      "g",
      "--game-version",
      "1",
      "--source-profile-id",
      "p",
      "--source-locale",
      "ja-JP",
      "--cipher-method",
      "exe_angou_xor_lzss",
      "--bundle-output",
      "/run/bridge.json",
    ]);
    expect(siglus).toMatchObject({ engine: "siglus", cipherMethod: "exe_angou_xor_lzss" });
    expect(() =>
      resolveExtractAdapter("siglus").parseCli([
        "extract",
        "--engine",
        "siglus",
        "--cipher-method",
        "not-declared",
      ]),
    ).toThrow(/out_of_profile_cipher_method/u);
  });
});

describe("runKaifuuExtract (env-gated real Softpal byte oracle)", () => {
  const softpalRoot = resolvePrivateCorpus("softpal", 1, "plain");
  const gated = softpalRoot === undefined || softpalRoot.length === 0 || !existsSync(softpalRoot);
  it.skipIf(gated)("drives the real softpal extract seam and writes a real bridge bundle", () => {
    const workDir = mkdtempSync(join(tmpdir(), "itotori-softpal-real-"));
    const bridgePath = join(workDir, "bridge.json");
    try {
      const res = runKaifuuExtract({
        engine: "softpal",
        gameRoot: softpalRoot!,
        bundleOutputPath: bridgePath,
      });
      expect(res.engine).toBe("softpal");
      expect(res.mode).toBe("whole-game");
      expect(res.status).toBe(0);
      const bridge = JSON.parse(readFileSync(bridgePath, "utf8")) as { units?: unknown[] };
      expect(Array.isArray(bridge.units)).toBe(true);
      expect(bridge.units!.length).toBeGreaterThan(0);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});
