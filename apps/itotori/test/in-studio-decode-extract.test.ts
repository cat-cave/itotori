// p3-in-studio-decode-extract-trigger — behavior tests for the Studio
// decode/extract runner behind the `projects.decodeExtract` mutation.
//
//   1. REAL-SEAM (no subprocess): the runner drives the REAL
//      `kaifuu-cli extract --engine reallive` invocation seam (buildExtractArgs
//      argv), then reads + validates the v0.2 bridge kaifuu writes. A FAKE spawn
//      writes the canonical example bundle to the exact `--bundle-output` path
//      the seam built, so CI touches NO real bytes yet exercises the real argv +
//      real file read-back + real schema validation.
//   2. WIRE-CONTRACT: parseProjectDecodeExtractRequest dispatches the required
//      engine discriminant to the matching adapter-owned source + mode shape.
//   3. ENV-GATED real: when ITOTORI_REAL_SWEETIE_ROOT is exported, the runner
//      drives the REAL kaifuu-cli against the operator's game tree and asserts a
//      real v0.2 BridgeBundle with text units landed. No retail bytes committed.
//
// This proves the trigger runs the REAL decode path, not a mock: the argv is the
// real seam's, the read-back is the real file, and the env-gated proof spawns the
// real binary.

import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createDecodeExtractRunner } from "../src/extract/decode-extract-runner.js";
import {
  buildExtractArgs,
  KaifuuExtractError,
  runKaifuuExtract,
  type KaifuuProcessResult,
} from "../src/extract/kaifuu-extract-seam.js";
import { assertItotoriApiResponse, parseProjectDecodeExtractRequest } from "../src/api-schema.js";

const IDENTITY = {
  gameId: "sweetie",
  gameVersion: "1.0",
  sourceProfileId: "profile-1",
  sourceLocale: "ja-JP",
} as const;

// The RealLive engine discriminant the extract-adapter registry requires on
// every extract/decode request, including the public Studio request.
const REALLIVE = { engine: "reallive", ...IDENTITY } as const;

// The canonical v0.2 BridgeBundle example — the same shape kaifuu writes.
const EXAMPLE_BUNDLE = readFileSync(
  new URL(
    "../../../packages/localization-bridge-schema/test/examples/bridge-v0.2.json",
    import.meta.url,
  ),
  "utf8",
);

/**
 * A runExtract that drives the REAL kaifuu extract seam (real argv construction)
 * with a FAKE spawn: it captures the argv and writes the example v0.2 bundle to
 * the exact `--bundle-output` path the seam built, then reports success.
 */
function realSeamWithFakeSpawn(capture: { argv?: string[] }) {
  return (args: Parameters<typeof runKaifuuExtract>[0]) =>
    runKaifuuExtract({
      ...args,
      env: {},
      runProcess: (_command, argv): KaifuuProcessResult => {
        capture.argv = argv;
        const outIndex = argv.indexOf("--bundle-output");
        writeFileSync(argv[outIndex + 1]!, EXAMPLE_BUNDLE);
        return { status: 0, stdout: "", stderr: "" };
      },
    });
}

describe("in-studio decode/extract runner drives the REAL kaifuu extract seam", () => {
  it("per-scene: builds the real kaifuu argv and reads the produced v0.2 bridge back", async () => {
    const capture: { argv?: string[] } = {};
    const runner = createDecodeExtractRunner({ runExtract: realSeamWithFakeSpawn(capture) });

    const outcome = await runner.runDecodeExtract({
      ...REALLIVE,
      gameRoot: "/games/sweetie",
      scene: 2031,
    });

    // The runner drove the REAL extract seam argv (identify -> inventory ->
    // extract), not a stub: the captured argv equals buildExtractArgs' output.
    const argv = capture.argv!;
    const extractIndex = argv.indexOf("extract");
    const bundleOutput = argv[argv.indexOf("--bundle-output") + 1]!;
    expect(argv.slice(extractIndex)).toEqual(
      buildExtractArgs({
        ...REALLIVE,
        gameRoot: "/games/sweetie",
        scene: 2031,
        bundleOutputPath: bundleOutput,
      }),
    );
    // The bridge is the real read-back of the file kaifuu wrote, schema-validated.
    expect(outcome.mode).toBe("per-scene");
    expect(outcome.bridge.schemaVersion).toBe("0.2.0");
    expect(outcome.bridge.units.length).toBeGreaterThan(0);
    expect(outcome.command).toContain("extract");
  });

  it("whole-seen: drives --whole-seen and reports mode=whole-seen", async () => {
    const capture: { argv?: string[] } = {};
    const runner = createDecodeExtractRunner({ runExtract: realSeamWithFakeSpawn(capture) });

    const outcome = await runner.runDecodeExtract({
      ...REALLIVE,
      vaultCanonicalId: "vault-sweetie",
      wholeSeen: true,
    });

    expect(capture.argv).toContain("--whole-seen");
    expect(capture.argv).not.toContain("--scene");
    expect(capture.argv![capture.argv!.indexOf("--vault-canonical-id") + 1]).toBe("vault-sweetie");
    expect(outcome.mode).toBe("whole-seen");
    expect(outcome.bridge.units.length).toBeGreaterThan(0);
  });

  it("round-trips a Softpal API request through its adapter without RealLive fields", async () => {
    const capture: { argv?: string[] } = {};
    const runner = createDecodeExtractRunner({ runExtract: realSeamWithFakeSpawn(capture) });
    const request = parseProjectDecodeExtractRequest({
      engine: "softpal",
      gameRoot: "/games/softpal",
    });

    const outcome = await runner.runDecodeExtract(request);

    expect(capture.argv).toContain("softpal");
    expect(capture.argv).toContain("/games/softpal");
    expect(capture.argv).not.toContain("--scene");
    expect(capture.argv).not.toContain("--whole-seen");
    expect(outcome).toMatchObject({ engine: "softpal", mode: "whole-game" });
    expect(outcome.bridge.units.length).toBeGreaterThan(0);
    expect(() => assertItotoriApiResponse("projects.decodeExtract", outcome)).not.toThrow();
  });

  it("propagates a non-zero kaifuu extract failure as a KaifuuExtractError", async () => {
    const runner = createDecodeExtractRunner({
      runExtract: (args) =>
        runKaifuuExtract({
          ...args,
          env: {},
          runProcess: (): KaifuuProcessResult => ({
            status: 4,
            stdout: "",
            stderr: "kaifuu.reallive.archive_parse: boom",
          }),
        }),
    });

    await expect(
      runner.runDecodeExtract({ ...REALLIVE, gameRoot: "/games/sweetie", scene: 1 }),
    ).rejects.toBeInstanceOf(KaifuuExtractError);
  });
});

describe("parseProjectDecodeExtractRequest (wire contract)", () => {
  const base = { ...REALLIVE, gameRoot: "/games/sweetie", wholeSeen: true } as const;

  it("accepts a valid whole-seen game-root request", () => {
    expect(parseProjectDecodeExtractRequest(base)).toEqual(base);
  });

  it("accepts a valid per-scene vault request", () => {
    const request = { ...REALLIVE, vaultCanonicalId: "vault-1", scene: 2031 };
    expect(parseProjectDecodeExtractRequest(request)).toEqual(request);
  });

  it("accepts adapter-owned Softpal and RPG Maker request variants", () => {
    const softpal = { engine: "softpal", gameRoot: "/games/softpal" } as const;
    const rpgMaker = {
      engine: "rpg-maker",
      gameDir: "/games/rpg/www",
      ...IDENTITY,
    } as const;
    expect(parseProjectDecodeExtractRequest(softpal)).toEqual(softpal);
    expect(parseProjectDecodeExtractRequest(rpgMaker)).toEqual(rpgMaker);
  });

  it("rejects providing both sourcing routes", () => {
    expect(() =>
      parseProjectDecodeExtractRequest({
        ...REALLIVE,
        gameRoot: "/g",
        vaultCanonicalId: "v",
        wholeSeen: true,
      }),
    ).toThrow(/exactly one source/u);
  });

  it("rejects providing neither sourcing route", () => {
    expect(() => parseProjectDecodeExtractRequest({ ...REALLIVE, wholeSeen: true })).toThrow(
      /exactly one source/u,
    );
  });

  it("rejects both decode modes", () => {
    expect(() =>
      parseProjectDecodeExtractRequest({ ...REALLIVE, gameRoot: "/g", wholeSeen: true, scene: 1 }),
    ).toThrow(/exactly one mode/u);
  });

  it("rejects neither decode mode", () => {
    expect(() => parseProjectDecodeExtractRequest({ ...REALLIVE, gameRoot: "/g" })).toThrow(
      /exactly one mode/u,
    );
  });

  it("rejects a false wholeSeen flag instead of ignoring it", () => {
    expect(() =>
      parseProjectDecodeExtractRequest({
        ...REALLIVE,
        gameRoot: "/g",
        scene: 1,
        wholeSeen: false,
      }),
    ).toThrow(/wholeSeen must be true/u);
  });

  it("rejects an out-of-range scene id", () => {
    expect(() =>
      parseProjectDecodeExtractRequest({ ...REALLIVE, gameRoot: "/g", scene: 70_000 }),
    ).toThrow(/u16/u);
  });

  it("requires an engine and refuses RealLive-only fields on another adapter", () => {
    expect(() => parseProjectDecodeExtractRequest({ gameRoot: "/g" })).toThrow(
      /engine is required/u,
    );
    expect(() =>
      parseProjectDecodeExtractRequest({ engine: "softpal", gameRoot: "/g", scene: 1 }),
    ).toThrow(/scene is not supported by the softpal adapter/u);
  });
});

// ---------------------------------------------------------------------------
// ENV-GATED real-Sweetie proof — the runner drives the REAL kaifuu-cli.
// ---------------------------------------------------------------------------

const REAL_SWEETIE_ROOT = process.env.ITOTORI_REAL_SWEETIE_ROOT;

describe("in-studio decode/extract runner (env-gated real-Sweetie byte proof)", () => {
  it.skipIf(!REAL_SWEETIE_ROOT)(
    "produces a REAL v0.2 bridge from a real game root via the real kaifuu-cli (per-scene)",
    async () => {
      const sceneEnv = process.env.ITOTORI_REAL_SWEETIE_SCENE;
      const scene = sceneEnv ? Number.parseInt(sceneEnv, 10) : 2031;
      // No injected runExtract -> the REAL kaifuu-cli runs.
      const runner = createDecodeExtractRunner();
      const outcome = await runner.runDecodeExtract({
        engine: "reallive",
        gameId: "sweetie-real",
        gameVersion: "1.0",
        sourceProfileId: "sweetie-hd-real",
        sourceLocale: "ja-JP",
        gameRoot: REAL_SWEETIE_ROOT,
        scene,
      });
      expect(outcome.mode).toBe("per-scene");
      expect(outcome.bridge.schemaVersion).toBe("0.2.0");
      expect(outcome.bridge.units.length).toBeGreaterThan(0);
    },
    300_000,
  );
});
