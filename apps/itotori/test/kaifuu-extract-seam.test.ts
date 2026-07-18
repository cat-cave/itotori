// itotori-cli-extract-command (P1, user-shaped CLI) — tests.
//
// Proves the user-shaped `itotori extract` command produces a bridge:
//
//   1. FAST (no kaifuu-cli, no real bytes) — the invocation shape mirrors the
//      suite runner's Phase 1 (`kaifuu extract --engine reallive --game-root
//      ... --game-id ... --scene <N> --bundle-output ...`) for BOTH per-scene
//      AND --whole-seen, plus Softpal whole-game (`--engine softpal`) through
//      the SAME parametric seam, plus the validation / failure paths. A faked
//      `runProcess` captures the argv so CI touches NO real bytes.
//   2. Native-output redaction — a simulated protected-span drift cannot put
//      source dialogue in an error. The generic corpus-manifest suite owns the
//      opt-in real-corpus proof.
import { describe, expect, it } from "vitest";
import {
  buildExtractArgs,
  KaifuuExtractError,
  KAIFUU_NATIVE_OUTPUT_REDACTED,
  REALLIVE_SCENE_ID_MAX,
  runKaifuuExtract,
  type KaifuuProcessResult,
} from "../src/extract/kaifuu-extract-seam.js";

const IDENTITY = {
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

  it("softpal whole-game: dispatches --engine softpal without RealLive mode flags", () => {
    const a = buildExtractArgs({
      ...IDENTITY,
      engine: "softpal",
      gameRoot: "/games/softpal-title",
      bundleOutputPath: "/run/softpal-bridge.json",
    });
    expect(a).toEqual([
      "extract",
      "--engine",
      "softpal",
      "--game-root",
      "/games/softpal-title",
      "--game-id",
      "sample-game",
      "--game-version",
      "1.0",
      "--source-profile-id",
      "profile-1",
      "--source-locale",
      "ja-JP",
      "--bundle-output",
      "/run/softpal-bridge.json",
    ]);
    expect(a).not.toContain("--scene");
    expect(a).not.toContain("--whole-seen");
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

  it("softpal: dispatches the REAL seam with --engine softpal (not a mock path)", () => {
    let captured: string[] | undefined;
    const res = runKaifuuExtract({
      ...IDENTITY,
      engine: "softpal",
      gameRoot: "/games/softpal-title",
      bundleOutputPath: "/run/softpal-bridge.json",
      env: {},
      runProcess: (_command, args): KaifuuProcessResult => {
        captured = args;
        return { status: 0, stdout: "ok", stderr: "" };
      },
    });
    expect(res.status).toBe(0);
    expect(res.engine).toBe("softpal");
    expect(res.mode).toBe("whole-game");
    expect(res.bundleOutputPath).toBe("/run/softpal-bridge.json");
    const extractIdx = captured!.indexOf("extract");
    expect(captured!.slice(extractIdx)).toEqual([
      "extract",
      "--engine",
      "softpal",
      "--game-root",
      "/games/softpal-title",
      "--game-id",
      "sample-game",
      "--game-version",
      "1.0",
      "--source-profile-id",
      "profile-1",
      "--source-locale",
      "ja-JP",
      "--bundle-output",
      "/run/softpal-bridge.json",
    ]);
  });

  it("softpal: refuses RealLive --scene (whole-game only)", () => {
    expect(() =>
      runKaifuuExtract({
        ...IDENTITY,
        engine: "softpal",
        gameRoot: "/games/softpal-title",
        scene: 1,
        bundleOutputPath: "/run/bridge.json",
        env: {},
        runProcess: () => ({ status: 0, stdout: "", stderr: "" }),
      }),
    ).toThrow(/whole-game extract only/u);
  });

  it("softpal: refuses RealLive --whole-seen (whole-game is implicit)", () => {
    expect(() =>
      runKaifuuExtract({
        ...IDENTITY,
        engine: "softpal",
        gameRoot: "/games/softpal-title",
        wholeSeen: true,
        bundleOutputPath: "/run/bridge.json",
        env: {},
        runProcess: () => ({ status: 0, stdout: "", stderr: "" }),
      }),
    ).toThrow(/whole-game extract is implicit/u);
  });
});
