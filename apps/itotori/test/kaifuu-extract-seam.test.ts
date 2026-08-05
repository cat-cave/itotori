import { describe, expect, it } from "vitest";

import {
  buildExtractArgs,
  KaifuuExtractError,
  KAIFUU_NATIVE_OUTPUT_REDACTED,
  REALLIVE_SCENE_ID_MAX,
  runKaifuuExtract,
  type KaifuuProcessResult,
} from "../src/extract/kaifuu-extract-seam.js";
import {
  NATIVE_CONTENT_REDACTED,
  NATIVE_SECRET_REDACTED,
} from "../src/native-bin/native-diagnostics.js";

import { IDENTITY, RPG_IDENTITY } from "./kaifuu-extract-seam.support.js";

describe("buildExtractArgs (argv shape)", () => {
  it("unit-set: uses the shared native scope vocabulary", () => {
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
      "--scope",
      "unit-set",
      "--unit-ids",
      "6010",
      "--bundle-output",
      "/run/bridge.json",
    ]);
  });

  it("all: uses the shared scope spelling + optional decompile report", () => {
    const a = buildExtractArgs({
      ...IDENTITY,
      vaultCanonicalId: "vault-id",
      wholeSeen: true,
      bundleOutputPath: "/run/bridge.json",
      decompileReportOutputPath: "/run/decompile.json",
    });
    expect(a[a.indexOf("--scope") + 1]).toBe("all");
    expect(a).not.toContain("--whole-seen");
    expect(a).not.toContain("--scene");
    expect(a[a.indexOf("--vault-canonical-id") + 1]).toBe("vault-id");
    expect(a[a.indexOf("--decompile-report-output") + 1]).toBe("/run/decompile.json");
  });
});

describe("runKaifuuExtract (invocation shape mirrors run.mjs Phase 1)", () => {
  it("unit-set: invokes kaifuu-cli extract with the shared scope args + reports status 0", () => {
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
      "--scope",
      "unit-set",
      "--unit-ids",
      "6010",
      "--bundle-output",
      "/run/bridge.json",
    ]);
  });

  it("all: invokes with --scope all and reports mode=whole-seen", () => {
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
    expect(captured).toContain("--scope");
    expect(captured![captured!.indexOf("--scope") + 1]).toBe("all");
    expect(captured).not.toContain("--whole-seen");
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

  it("rejects RealLive sourcing when neither an explicit root nor a vault id is given", () => {
    expect(() =>
      runKaifuuExtract({
        ...IDENTITY,
        scene: 1,
        bundleOutputPath: "/run/bridge.json",
        env: {},
        runProcess: (): KaifuuProcessResult => ({ status: 0, stdout: "", stderr: "" }),
      }),
    ).toThrow(/sourcing requires/u);
  });

  it("redacts a protected content span while retaining its diagnostic context", () => {
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
          stdout: "",
          stderr:
            `kaifuu.reallive.protected_span_drift: scene=7 path=/synthetic/source offset=42 ` +
            `kind=control_span source=${sourceDialogue}`,
        }),
      });
    } catch (error) {
      caught = error as KaifuuExtractError;
    }
    expect(caught).toBeInstanceOf(KaifuuExtractError);
    expect(caught?.status).toBe(4);
    expect(caught?.message).toContain("kaifuu.reallive.protected_span_drift");
    expect(caught?.message).toContain("scene=7");
    expect(caught?.message).toContain("path=/synthetic/source");
    expect(caught?.message).toContain("offset=42");
    expect(caught?.message).toContain("kind=control_span");
    expect(caught?.message).toContain(NATIVE_CONTENT_REDACTED);
    expect(caught?.message).toMatch(/bytes \(sha256 [a-f0-9]{64}\)/u);
    expect(caught?.stderr).toContain(NATIVE_CONTENT_REDACTED);
    expect(caught?.message).not.toContain(sourceDialogue);
    expect(caught?.stderr).not.toContain(sourceDialogue);
    expect(caught?.stack).not.toContain(sourceDialogue);
  });

  it("redacts secret-bearing values without hiding safe native failure details", () => {
    const secret = "operator-api-key-sentinel-4e0d4cb3";
    let caught: KaifuuExtractError | undefined;
    try {
      runKaifuuExtract({
        ...IDENTITY,
        gameRoot: "/games/sample-game",
        scene: 1,
        bundleOutputPath: "/run/bridge.json",
        env: { OPENROUTER_API_KEY: secret },
        runProcess: (): KaifuuProcessResult => ({
          status: 4,
          stdout: "",
          stderr:
            "kaifuu.reallive.metadata_invalid: offset=42 " +
            `OPENROUTER_API_KEY=${secret}; pass --game-version`,
        }),
      });
    } catch (error) {
      caught = error as KaifuuExtractError;
    }
    expect(caught).toBeInstanceOf(KaifuuExtractError);
    expect(caught?.message).toContain("kaifuu.reallive.metadata_invalid");
    expect(caught?.message).toContain("offset=42");
    expect(caught?.message).toContain("--game-version");
    expect(caught?.message).toContain(NATIVE_SECRET_REDACTED);
    expect(caught?.stderr).toContain(NATIVE_SECRET_REDACTED);
    expect(caught?.message).not.toContain(secret);
    expect(caught?.stderr).not.toContain(secret);
    expect(caught?.stack).not.toContain(secret);
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
    ).toThrow(/choose exactly one scope: --scene, --scenes, --unit-range, or --whole-seen/u);
  });

  it("refuses when no supported run scope is given", () => {
    expect(() =>
      runKaifuuExtract({
        ...IDENTITY,
        gameRoot: "/games/sample-game",
        bundleOutputPath: "/run/bridge.json",
        env: {},
        runProcess: () => ({ status: 0, stdout: "", stderr: "" }),
      }),
    ).toThrow(/choose exactly one scope: --scene, --scenes, --unit-range, or --whole-seen/u);
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
      lines.some(
        (line) =>
          line.startsWith("kaifuu-extract:") && line.includes("--scope unit-set --unit-ids 7"),
      ),
    ).toBe(true);
  });
});

describe("buildExtractArgs (softpal argv shape)", () => {
  it("passes --game-root + --scope all + --bundle-output", () => {
    const a = buildExtractArgs({
      engine: "softpal",
      gameRoot: "/games/softpal-title/game",
      bundleOutputPath: "/run/bridge.json",
    });
    expect(a).toEqual([
      "extract",
      "--engine",
      "softpal",
      "--game-root",
      "/games/softpal-title/game",
      "--scope",
      "all",
      "--bundle-output",
      "/run/bridge.json",
    ]);
    // Softpal uses none of the RealLive scene/vault/identity flags.
    expect(a).not.toContain("--scene");
    expect(a).not.toContain("--whole-seen");
    expect(a).not.toContain("--game-id");
    expect(a).toContain("--game-root");
  });

  it("uses --scope all when it falls back to the softpal env var", () => {
    const a = buildExtractArgs({
      engine: "softpal",
      bundleOutputPath: "/run/bridge.json",
    });
    expect(a).toEqual([
      "extract",
      "--engine",
      "softpal",
      "--scope",
      "all",
      "--bundle-output",
      "/run/bridge.json",
    ]);
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
      "--game-root",
      "/games/softpal-title/game",
      "--scope",
      "all",
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

  it("redacts labelled softpal content on a non-zero exit", () => {
    const sourceDialogue = "PRIVATE-SOFTPAL-DIALOGUE";
    let caught: KaifuuExtractError | undefined;
    try {
      runKaifuuExtract({
        engine: "softpal",
        gameRoot: "/games/softpal-title/game",
        bundleOutputPath: "/run/bridge.json",
        env: {},
        runProcess: (): KaifuuProcessResult => ({
          status: 3,
          stdout: "",
          stderr: `kaifuu.softpal.decode_failed: unit=12 text=${sourceDialogue}`,
        }),
      });
    } catch (error) {
      caught = error as KaifuuExtractError;
    }
    expect(caught).toBeInstanceOf(KaifuuExtractError);
    expect(caught?.message).toContain("softpal");
    expect(caught?.message).toContain("unit=12");
    expect(caught?.message).toContain(NATIVE_CONTENT_REDACTED);
    expect(caught?.message).not.toContain(sourceDialogue);
    expect(caught?.stderr).toContain(NATIVE_CONTENT_REDACTED);
  });
});

describe("buildExtractArgs (rpg-maker argv shape)", () => {
  it("emits --game-root + shared scope + identity flags + --bundle-output", () => {
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
      "--game-root",
      "/games/rpg-title/www",
      "--game-id",
      "sample-rpg",
      "--game-version",
      "1.0",
      "--source-profile-id",
      "profile-1",
      "--source-locale",
      "ja-JP",
      "--scope",
      "all",
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

  it("omits --game-root when no source directory is supplied", () => {
    const a = buildExtractArgs({
      engine: "rpg-maker",
      ...RPG_IDENTITY,
      bundleOutputPath: "/run/bridge.json",
    });
    expect(a).not.toContain("--game-root");
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
});
