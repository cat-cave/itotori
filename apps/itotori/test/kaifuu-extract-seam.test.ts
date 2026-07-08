// itotori-cli-extract-command (P1, user-shaped CLI) — tests.
//
// Proves the user-shaped `itotori extract` command produces a real bridge:
//
//   1. FAST (no kaifuu-cli, no real bytes) — the invocation shape mirrors the
//      suite runner's Phase 1 (`kaifuu extract --engine reallive --game-root
//      ... --game-id ... --scene <N> --bundle-output ...`) for BOTH per-scene
//      AND --whole-seen, plus the validation / failure paths. A faked
//      `runProcess` captures the argv so CI touches NO real bytes.
//   2. ENV-GATED real Sweetie — when ITOTORI_REAL_SWEETIE_ROOT is exported,
//      actually run the REAL kaifuu-cli extract against the operator's game
//      tree and assert a v0.2 BridgeBundle landed (no retail bytes committed;
//      the bridge is written to a scratch tmp path).
//
// Mirrors the patch-apply-seam test structure (the sibling M1 keystone).

import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildExtractArgs,
  KaifuuExtractError,
  REALLIVE_SCENE_ID_MAX,
  runKaifuuRealliveExtract,
  type KaifuuProcessResult,
} from "../src/extract/kaifuu-extract-seam.js";

const IDENTITY = {
  gameId: "sweetie",
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
      gameRoot: "/games/sweetie",
      scene: 6010,
      bundleOutputPath: "/run/bridge.json",
    });
    expect(a).toEqual([
      "extract",
      "--engine",
      "reallive",
      "--game-root",
      "/games/sweetie",
      "--game-id",
      "sweetie",
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

describe("runKaifuuRealliveExtract (invocation shape mirrors run.mjs Phase 1)", () => {
  it("per-scene: invokes kaifuu-cli extract with the right args + reports status 0", () => {
    let captured: { command: string; args: string[] } | undefined;
    const res = runKaifuuRealliveExtract({
      ...IDENTITY,
      gameRoot: "/games/sweetie",
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
    // Slice from "extract" to skip the binary-resolution prefix (cargo fallback
    // when ITOTORI_KAIFUU_BIN is unset; a resolved binary has no prefix).
    const a = captured!.args;
    const extractIdx = a.indexOf("extract");
    expect(a.slice(extractIdx)).toEqual([
      "extract",
      "--engine",
      "reallive",
      "--game-root",
      "/games/sweetie",
      "--game-id",
      "sweetie",
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
    const res = runKaifuuRealliveExtract({
      ...IDENTITY,
      gameRoot: "/games/sweetie",
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
    runKaifuuRealliveExtract({
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
    runKaifuuRealliveExtract({
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

  it("throws KaifuuExtractError on a non-zero exit", () => {
    let caught: KaifuuExtractError | undefined;
    try {
      runKaifuuRealliveExtract({
        ...IDENTITY,
        gameRoot: "/games/sweetie",
        scene: 1,
        bundleOutputPath: "/run/bridge.json",
        env: {},
        runProcess: (): KaifuuProcessResult => ({
          status: 4,
          stdout: "",
          stderr: "kaifuu.reallive.archive_parse: boom",
        }),
      });
    } catch (error) {
      caught = error as KaifuuExtractError;
    }
    expect(caught).toBeInstanceOf(KaifuuExtractError);
    expect(caught?.status).toBe(4);
    expect(caught?.message).toMatch(/status 4.*kaifuu\.reallive\.archive_parse/su);
  });

  it("refuses --whole-seen together with --scene (mutually exclusive)", () => {
    expect(() =>
      runKaifuuRealliveExtract({
        ...IDENTITY,
        gameRoot: "/games/sweetie",
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
      runKaifuuRealliveExtract({
        ...IDENTITY,
        gameRoot: "/games/sweetie",
        bundleOutputPath: "/run/bridge.json",
        env: {},
        runProcess: () => ({ status: 0, stdout: "", stderr: "" }),
      }),
    ).toThrow(/--scene .* or --whole-seen/u);
  });

  it("refuses an out-of-range scene id", () => {
    expect(() =>
      runKaifuuRealliveExtract({
        ...IDENTITY,
        gameRoot: "/games/sweetie",
        scene: REALLIVE_SCENE_ID_MAX + 1,
        bundleOutputPath: "/run/bridge.json",
        env: {},
        runProcess: () => ({ status: 0, stdout: "", stderr: "" }),
      }),
    ).toThrow(/u16/u);
  });

  it("refuses when no sourcing route is resolvable", () => {
    expect(() =>
      runKaifuuRealliveExtract({
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
    runKaifuuRealliveExtract({
      ...IDENTITY,
      gameRoot: "/games/sweetie",
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
// (2) ENV-GATED real-Sweetie proof — actually extract via the real kaifuu-cli
// ---------------------------------------------------------------------------

/**
 * Reads the env-gated real game root (an operator machine export, never
 * committed). When unset, every real-Sweetie test is skipped — no real bytes
 * reach CI.
 */
const REAL_SWEETIE_ROOT = process.env.ITOTORI_REAL_SWEETIE_ROOT;

describe("runKaifuuRealliveExtract (env-gated real-Sweetie byte proof)", () => {
  it.skipIf(!REAL_SWEETIE_ROOT)(
    "produces a REAL whole-game bridge from the Sweetie Seen.txt (--whole-seen)",
    () => {
      const bundleOutputPath = join(
        mkdtempSync(join(tmpdir(), "itotori-extract-whole-")),
        "bridge.json",
      );
      // No faked runProcess -> the REAL kaifuu-cli runs.
      const res = runKaifuuRealliveExtract({
        ...IDENTITY,
        gameId: "sweetie-real",
        gameRoot: REAL_SWEETIE_ROOT,
        wholeSeen: true,
        bundleOutputPath,
      });
      expect(res.status).toBe(0);
      expect(res.mode).toBe("whole-seen");
      // A real v0.2 bridge landed on disk.
      expect(existsSync(bundleOutputPath)).toBe(true);
      const bridge = JSON.parse(readFileSync(bundleOutputPath, "utf8")) as Record<string, unknown>;
      expect(typeof bridge.schemaVersion).toBe("string");
      expect(Array.isArray(bridge.units)).toBe(true);
      expect((bridge.units as unknown[]).length).toBeGreaterThan(0);
    },
    600_000,
  );

  it.skipIf(!REAL_SWEETIE_ROOT || !process.env.ITOTORI_REAL_SWEETIE_SCENE)(
    "produces a REAL per-scene bridge from the Sweetie Seen.txt (--scene)",
    () => {
      const sceneId = Number.parseInt(process.env.ITOTORI_REAL_SWEETIE_SCENE as string, 10);
      expect(Number.isInteger(sceneId) && sceneId >= 0).toBe(true);
      const bundleOutputPath = join(
        mkdtempSync(join(tmpdir(), "itotori-extract-scene-")),
        "bridge.json",
      );
      const res = runKaifuuRealliveExtract({
        ...IDENTITY,
        gameId: "sweetie-real",
        gameRoot: REAL_SWEETIE_ROOT,
        scene: sceneId,
        bundleOutputPath,
        decompileReportOutputPath: join(bundleOutputPath, "..", "decompile.json"),
      });
      expect(res.status).toBe(0);
      expect(res.mode).toBe("per-scene");
      expect(existsSync(bundleOutputPath)).toBe(true);
      const bridge = JSON.parse(readFileSync(bundleOutputPath, "utf8")) as Record<string, unknown>;
      expect(typeof bridge.schemaVersion).toBe("string");
      expect(Array.isArray(bridge.units)).toBe(true);
    },
    300_000,
  );
});
