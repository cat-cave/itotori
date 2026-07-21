// itotori-cli-extract-command (P1, user-shaped CLI) — tests.
//
// Proves the user-shaped `itotori extract` command produces a bridge:
//
//   1. FAST (no kaifuu-cli, no real bytes) — the invocation shape mirrors the
//      suite runner's Phase 1 (`kaifuu extract --engine reallive --game-root
//      ... --game-id ... --scene <N> --bundle-output ...`) for BOTH per-scene
//      AND --whole-seen, plus the validation / failure paths. A faked
//      `runProcess` captures the argv so CI touches NO real bytes.
//   2. Native-output redaction — a simulated protected-span drift cannot put
//      source dialogue in an error. The generic corpus-manifest suite owns the
//      opt-in real-corpus proof.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildExtractArgs,
  extractCapabilities,
  KaifuuExtractError,
  KAIFUU_NATIVE_OUTPUT_REDACTED,
  REALLIVE_SCENE_ID_MAX,
  registeredExtractEngines,
  resolveExtractAdapter,
  runKaifuuExtract,
  type KaifuuExtractArgs,
  type KaifuuProcessResult,
} from "../src/extract/kaifuu-extract-seam.js";

const IDENTITY = {
  engine: "reallive",
  gameId: "sample-game",
  gameVersion: "1.0",
  sourceProfileId: "profile-1",
  sourceLocale: "ja-JP",
} as const;

// ---------------------------------------------------------------------------
// (1) FAST unit tests — invocation shape + validation (no real bytes)
// ---------------------------------------------------------------------------

describe("buildExtractArgs (argv shape)", () => {
  it("per-scene: mirrors run.mjs Phase 1 ordering", () => {
    const a = buildExtractArgs({
      ...IDENTITY,
      gameRoot: "/games/sample-game",
      scene: 6010,
      bundleOutputPath: "/run/bridge.json",
    });
    expect(a).toEqual([
      "extract",
      "--engine",
      "reallive",
      "--game-root",
      "/games/sample-game",
      "--game-id",
      "sample-game",
      "--game-version",
      "1.0",
      "--source-profile-id",
      "profile-1",
      "--source-locale",
      "ja-JP",
      "--scene",
      "6010",
      "--bundle-output",
      "/run/bridge.json",
    ]);
  });

  it("whole-seen: emits --whole-seen (no --scene) + optional decompile report", () => {
    const a = buildExtractArgs({
      ...IDENTITY,
      vaultCanonicalId: "vault-id",
      wholeSeen: true,
      bundleOutputPath: "/run/bridge.json",
      decompileReportOutputPath: "/run/decompile.json",
    });
    expect(a).toContain("--whole-seen");
    expect(a).not.toContain("--scene");
    expect(a[a.indexOf("--vault-canonical-id") + 1]).toBe("vault-id");
    expect(a[a.indexOf("--decompile-report-output") + 1]).toBe("/run/decompile.json");
  });
});

describe("runKaifuuExtract (invocation shape mirrors run.mjs Phase 1)", () => {
  it("per-scene: invokes kaifuu-cli extract with the right args + reports status 0", () => {
    let captured: { command: string; args: string[] } | undefined;
    const res = runKaifuuExtract({
      ...IDENTITY,
      gameRoot: "/games/sample-game",
      scene: 6010,
      bundleOutputPath: "/run/bridge.json",
      // ITOTORI_KAIFUU_BIN unset -> cargo fallback; runProcess is faked.
      env: {},
      runProcess: (command, args): KaifuuProcessResult => {
        captured = { command, args };
        return { status: 0, stdout: "ok", stderr: "" };
      },
    });
    expect(res.status).toBe(0);
    expect(res.mode).toBe("per-scene");
    expect(res.bundleOutputPath).toBe("/run/bridge.json");
    expect(res.stdout).toBe(KAIFUU_NATIVE_OUTPUT_REDACTED);
    expect(res.stderr).toBe("");
    // Slice from "extract" to skip the binary-resolution prefix (cargo fallback
    // when ITOTORI_KAIFUU_BIN is unset; a resolved binary has no prefix).
    const a = captured!.args;
    const extractIdx = a.indexOf("extract");
    expect(a.slice(extractIdx)).toEqual([
      "extract",
      "--engine",
      "reallive",
      "--game-root",
      "/games/sample-game",
      "--game-id",
      "sample-game",
      "--game-version",
      "1.0",
      "--source-profile-id",
      "profile-1",
      "--source-locale",
      "ja-JP",
      "--scene",
      "6010",
      "--bundle-output",
      "/run/bridge.json",
    ]);
  });

  it("whole-seen: invokes with --whole-seen and reports mode=whole-seen", () => {
    let captured: string[] | undefined;
    const res = runKaifuuExtract({
      ...IDENTITY,
      gameRoot: "/games/sample-game",
      wholeSeen: true,
      bundleOutputPath: "/run/bridge.json",
      env: {},
      runProcess: (_command, args): KaifuuProcessResult => {
        captured = args;
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    expect(res.mode).toBe("whole-seen");
    expect(captured).toContain("--whole-seen");
    expect(captured).not.toContain("--scene");
  });

  it("resolves --vault-canonical-id sourcing (by-id) without --game-root", () => {
    let captured: string[] | undefined;
    runKaifuuExtract({
      ...IDENTITY,
      vaultCanonicalId: "vault-id",
      scene: 1,
      bundleOutputPath: "/run/bridge.json",
      env: {},
      runProcess: (_command, args): KaifuuProcessResult => {
        captured = args;
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    expect(captured![captured!.indexOf("--vault-canonical-id") + 1]).toBe("vault-id");
    expect(captured!.some((token) => token === "--game-root")).toBe(false);
  });

  it("falls back to the ITOTORI_REAL_GAME_ROOT env when no sourcing flag is given", () => {
    let spawned = false;
    runKaifuuExtract({
      ...IDENTITY,
      scene: 1,
      bundleOutputPath: "/run/bridge.json",
      env: { ITOTORI_REAL_GAME_ROOT: "/env-game-root" },
      runProcess: (): KaifuuProcessResult => {
        spawned = true;
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    // kaifuu-cli reads ITOTORI_REAL_GAME_ROOT itself; the wrapper only needed to
    // NOT refuse on missing sourcing — the spawn happened.
    expect(spawned).toBe(true);
  });

  it("redacts protected-span decode drift dialogue on a non-zero exit", () => {
    const sourceDialogue = "PRIVATE-SOURCE-DIALOGUE-SENTINEL-4e0d4cb3";
    let caught: KaifuuExtractError | undefined;
    try {
      runKaifuuExtract({
        ...IDENTITY,
        gameRoot: "/games/sample-game",
        scene: 1,
        bundleOutputPath: "/run/bridge.json",
        env: {},
        runProcess: (): KaifuuProcessResult => ({
          status: 4,
          stdout: `kaifuu.reallive.protected_span_drift: ${sourceDialogue}`,
          stderr: `kaifuu.reallive.protected_span_drift: source=${sourceDialogue}`,
        }),
      });
    } catch (error) {
      caught = error as KaifuuExtractError;
    }
    expect(caught).toBeInstanceOf(KaifuuExtractError);
    expect(caught?.status).toBe(4);
    expect(caught?.message).toContain(KAIFUU_NATIVE_OUTPUT_REDACTED);
    expect(caught?.stderr).toBe(KAIFUU_NATIVE_OUTPUT_REDACTED);
    expect(caught?.message).not.toContain(sourceDialogue);
    expect(caught?.stderr).not.toContain(sourceDialogue);
    expect(caught?.stack).not.toContain(sourceDialogue);
  });

  it("refuses --whole-seen together with --scene (mutually exclusive)", () => {
    expect(() =>
      runKaifuuExtract({
        ...IDENTITY,
        gameRoot: "/games/sample-game",
        wholeSeen: true,
        scene: 1,
        bundleOutputPath: "/run/bridge.json",
        env: {},
        runProcess: () => ({ status: 0, stdout: "", stderr: "" }),
      }),
    ).toThrow(/mutually exclusive/u);
  });

  it("refuses when neither --scene nor --whole-seen is given", () => {
    expect(() =>
      runKaifuuExtract({
        ...IDENTITY,
        gameRoot: "/games/sample-game",
        bundleOutputPath: "/run/bridge.json",
        env: {},
        runProcess: () => ({ status: 0, stdout: "", stderr: "" }),
      }),
    ).toThrow(/--scene .* or --whole-seen/u);
  });

  it("refuses an out-of-range scene id", () => {
    expect(() =>
      runKaifuuExtract({
        ...IDENTITY,
        gameRoot: "/games/sample-game",
        scene: REALLIVE_SCENE_ID_MAX + 1,
        bundleOutputPath: "/run/bridge.json",
        env: {},
        runProcess: () => ({ status: 0, stdout: "", stderr: "" }),
      }),
    ).toThrow(/u16/u);
  });

  it("refuses when no sourcing route is resolvable", () => {
    expect(() =>
      runKaifuuExtract({
        ...IDENTITY,
        scene: 1,
        bundleOutputPath: "/run/bridge.json",
        env: {},
        runProcess: () => ({ status: 0, stdout: "", stderr: "" }),
      }),
    ).toThrow(/sourcing requires/u);
  });

  it("logs the resolved invocation through the log seam", () => {
    const lines: string[] = [];
    runKaifuuExtract({
      ...IDENTITY,
      gameRoot: "/games/sample-game",
      scene: 7,
      bundleOutputPath: "/run/bridge.json",
      env: {},
      log: (message) => {
        lines.push(message);
      },
      runProcess: () => ({ status: 0, stdout: "", stderr: "" }),
    });
    expect(
      lines.some((line) => line.startsWith("kaifuu-extract:") && line.includes("--scene 7")),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Softpal engine — the SAME seam, dispatched through `--engine softpal`.
// ---------------------------------------------------------------------------

describe("buildExtractArgs (softpal argv shape)", () => {
  it("passes the game root positionally + --bundle-output (matches the CLI arm)", () => {
    const a = buildExtractArgs({
      engine: "softpal",
      gameRoot: "/games/softpal-title/game",
      bundleOutputPath: "/run/bridge.json",
    });
    expect(a).toEqual([
      "extract",
      "--engine",
      "softpal",
      "/games/softpal-title/game", // positional root — NOT a --game-root flag
      "--bundle-output",
      "/run/bridge.json",
    ]);
    // Softpal uses none of the RealLive scene/vault/identity flags.
    expect(a).not.toContain("--scene");
    expect(a).not.toContain("--whole-seen");
    expect(a).not.toContain("--game-id");
    expect(a).not.toContain("--game-root");
  });

  it("omits the positional root when it falls back to the softpal env var", () => {
    const a = buildExtractArgs({
      engine: "softpal",
      bundleOutputPath: "/run/bridge.json",
    });
    expect(a).toEqual(["extract", "--engine", "softpal", "--bundle-output", "/run/bridge.json"]);
  });
});

describe("runKaifuuExtract (softpal dispatch)", () => {
  it("dispatches --engine softpal and reports engine=softpal mode=whole-game", () => {
    let captured: string[] | undefined;
    const res = runKaifuuExtract({
      engine: "softpal",
      gameRoot: "/games/softpal-title/game",
      bundleOutputPath: "/run/bridge.json",
      env: {},
      runProcess: (_command, args): KaifuuProcessResult => {
        captured = args;
        return { status: 0, stdout: "units=39848", stderr: "" };
      },
    });
    expect(res.engine).toBe("softpal");
    expect(res.mode).toBe("whole-game");
    expect(res.bundleOutputPath).toBe("/run/bridge.json");
    const extractIdx = captured!.indexOf("extract");
    expect(captured!.slice(extractIdx)).toEqual([
      "extract",
      "--engine",
      "softpal",
      "/games/softpal-title/game",
      "--bundle-output",
      "/run/bridge.json",
    ]);
  });

  it("refuses softpal when no game root or softpal env var is resolvable", () => {
    expect(() =>
      runKaifuuExtract({
        engine: "softpal",
        bundleOutputPath: "/run/bridge.json",
        env: {},
        runProcess: () => ({ status: 0, stdout: "", stderr: "" }),
      }),
    ).toThrow(/softpal.*sourcing requires/u);
  });

  it("redacts softpal native output on a non-zero exit", () => {
    let caught: KaifuuExtractError | undefined;
    try {
      runKaifuuExtract({
        engine: "softpal",
        gameRoot: "/games/softpal-title/game",
        bundleOutputPath: "/run/bridge.json",
        env: {},
        runProcess: (): KaifuuProcessResult => ({
          status: 3,
          stdout: "PRIVATE-SOFTPAL-DIALOGUE",
          stderr: "PRIVATE-SOFTPAL-DIALOGUE",
        }),
      });
    } catch (error) {
      caught = error as KaifuuExtractError;
    }
    expect(caught).toBeInstanceOf(KaifuuExtractError);
    expect(caught?.message).toContain("softpal");
    expect(caught?.message).not.toContain("PRIVATE-SOFTPAL-DIALOGUE");
    expect(caught?.stderr).toBe(KAIFUU_NATIVE_OUTPUT_REDACTED);
  });
});

// ---------------------------------------------------------------------------
// RPG Maker MV/MZ engine — the SAME seam, dispatched through `--engine rpg-maker`.
// (The kaifuu-cli RPG Maker bundle extract path is now selectable from the app.)
// ---------------------------------------------------------------------------

const RPG_IDENTITY = {
  gameId: "sample-rpg",
  gameVersion: "1.0",
  sourceProfileId: "profile-1",
  sourceLocale: "ja-JP",
} as const;

describe("buildExtractArgs (rpg-maker argv shape)", () => {
  it("emits --game-dir + identity flags + --bundle-output (matches the CLI arm)", () => {
    const a = buildExtractArgs({
      engine: "rpg-maker",
      ...RPG_IDENTITY,
      gameDir: "/games/rpg-title/www",
      bundleOutputPath: "/run/bridge.json",
      findingsOutputPath: "/run/findings.json",
    });
    expect(a).toEqual([
      "extract",
      "--engine",
      "rpg-maker",
      "--game-dir",
      "/games/rpg-title/www",
      "--game-id",
      "sample-rpg",
      "--game-version",
      "1.0",
      "--source-profile-id",
      "profile-1",
      "--source-locale",
      "ja-JP",
      "--bundle-output",
      "/run/bridge.json",
      "--findings-output",
      "/run/findings.json",
    ]);
    // RPG Maker uses none of the RealLive scene/vault flags.
    expect(a).not.toContain("--scene");
    expect(a).not.toContain("--whole-seen");
    expect(a).not.toContain("--vault-canonical-id");
  });

  it("omits --game-dir when it falls back to the rpg-maker env var", () => {
    const a = buildExtractArgs({
      engine: "rpg-maker",
      ...RPG_IDENTITY,
      bundleOutputPath: "/run/bridge.json",
    });
    expect(a).not.toContain("--game-dir");
    expect(a).not.toContain("--findings-output");
  });
});

describe("runKaifuuExtract (rpg-maker dispatch)", () => {
  it("dispatches --engine rpg-maker and reports engine=rpg-maker mode=whole-game", () => {
    let captured: string[] | undefined;
    const res = runKaifuuExtract({
      engine: "rpg-maker",
      ...RPG_IDENTITY,
      gameDir: "/games/rpg-title/www",
      bundleOutputPath: "/run/bridge.json",
      env: {},
      runProcess: (_command, args): KaifuuProcessResult => {
        captured = args;
        return { status: 0, stdout: "units=100", stderr: "" };
      },
    });
    expect(res.engine).toBe("rpg-maker");
    expect(res.mode).toBe("whole-game");
    const extractIdx = captured!.indexOf("extract");
    expect(captured!.slice(extractIdx, extractIdx + 3)).toEqual([
      "extract",
      "--engine",
      "rpg-maker",
    ]);
  });

  it("refuses rpg-maker when no game www/ dir or env var is resolvable", () => {
    expect(() =>
      runKaifuuExtract({
        engine: "rpg-maker",
        ...RPG_IDENTITY,
        bundleOutputPath: "/run/bridge.json",
        env: {},
        runProcess: () => ({ status: 0, stdout: "", stderr: "" }),
      }),
    ).toThrow(/rpg-maker.*sourcing requires/u);
  });

  it("resolves rpg-maker sourcing from the ITOTORI_REAL_GAME_ROOT_RPG_MAKER_MV_MZ env", () => {
    let spawned = false;
    runKaifuuExtract({
      engine: "rpg-maker",
      ...RPG_IDENTITY,
      bundleOutputPath: "/run/bridge.json",
      env: { ITOTORI_REAL_GAME_ROOT_RPG_MAKER_MV_MZ: "/env-www" },
      runProcess: () => {
        spawned = true;
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    expect(spawned).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Registry — engine discrimination, no default, boundary rejection, CLI parse.
// ---------------------------------------------------------------------------

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

// Env-gated REAL-byte proof: spawns the REAL `kaifuu-cli extract --engine
// softpal <root>` through the production seam (no faked runProcess) and asserts
// the real bridge it wrote. Runs only on an operator machine with the built
// binary + ITOTORI_REAL_GAME_ROOT_SOFTPAL exported to a real Softpal root.
// Optionally asserts an exact unit count via ITOTORI_SOFTPAL_EXPECTED_UNITS.
describe("runKaifuuExtract (env-gated real Softpal byte oracle)", () => {
  const softpalRoot = process.env.ITOTORI_REAL_GAME_ROOT_SOFTPAL;
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
      const expected = process.env.ITOTORI_SOFTPAL_EXPECTED_UNITS;
      if (expected !== undefined && expected.length > 0) {
        expect(bridge.units!.length).toBe(Number.parseInt(expected, 10));
      }
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});
