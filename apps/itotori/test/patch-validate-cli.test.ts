import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { runItotoriCliCommand, type ItotoriCliDependencies } from "../src/cli-handlers.js";
import type { NativeCliProcessResult } from "../src/native-bin/cli-bin-resolver.js";

function depsWithNativeRunner(
  calls: Array<{ command: string; args: string[] }>,
  result: NativeCliProcessResult = { status: 0, stdout: "", stderr: "" },
): ItotoriCliDependencies {
  const dependencies = baseDeps();
  dependencies.nativeCli = {
    env: {},
    runProcess: (command, args) => {
      calls.push({ command, args });
      return result;
    },
  };
  return dependencies;
}

function baseDeps(): ItotoriCliDependencies {
  return {
    io: {
      readJson: () => {
        throw new Error("readJson should not be called");
      },
      writeJson: () => {
        throw new Error("writeJson should not be called");
      },
    },
    migrateDatabase: async () => {
      throw new Error("migrateDatabase should not be called");
    },
    withServices: async () => {
      throw new Error("withServices should not be called");
    },
  };
}

function resolveRealLiveDataDir(sourceRoot: string): string {
  let current = sourceRoot;
  for (let visited = 0; visited <= 4; visited += 1) {
    const directDataDir = join(current, "REALLIVEDATA");
    if (existsSync(join(directDataDir, "Seen.txt"))) {
      return directDataDir;
    }

    const children = readdirSync(current, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(current, entry.name));
    const childRoots = children.filter((child) =>
      existsSync(join(child, "REALLIVEDATA", "Seen.txt")),
    );
    if (childRoots.length === 1) {
      return join(childRoots[0]!, "REALLIVEDATA");
    }
    if (children.length !== 1) {
      break;
    }
    current = children[0]!;
  }

  throw new Error(
    `[patch-validate-real] ITOTORI_CLI_REAL_SWEETIE_ROOT must point at a RealLive tree with REALLIVEDATA/Seen.txt: ${sourceRoot}`,
  );
}

function hasG00Assets(gameDir: string): boolean {
  const frontier: Array<{ dir: string; depth: number }> = [{ dir: gameDir, depth: 0 }];
  while (frontier.length > 0) {
    const current = frontier.shift()!;
    const entries = readdirSync(current.dir, { withFileTypes: true });
    if (
      current.dir.toLowerCase().endsWith("/g00") &&
      entries.some((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".g00"))
    ) {
      return true;
    }
    if (current.depth >= 4) {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        frontier.push({ dir: join(current.dir, entry.name), depth: current.depth + 1 });
      }
    }
  }
  return false;
}

describe("itotori patch", () => {
  it("wraps kaifuu patch --engine reallive with translated bundle, source, target, scope, and force", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    await runItotoriCliCommand(
      [
        "patch",
        "--bundle",
        "/run/translated-bridge.json",
        "--source",
        "/games/sweetie",
        "--target",
        "/tmp/patched",
        "--scope",
        "dialogue-only",
        "--force",
      ],
      depsWithNativeRunner(calls),
    );

    expect(calls).toHaveLength(1);
    const patchIndex = calls[0]!.args.indexOf("patch");
    expect(patchIndex).toBeGreaterThanOrEqual(0);
    expect(calls[0]!.args.slice(patchIndex)).toEqual([
      "patch",
      "--engine",
      "reallive",
      "--bundle",
      "/run/translated-bridge.json",
      "--source",
      "/games/sweetie",
      "--target",
      "/tmp/patched",
      "--scope",
      "dialogue-only",
      "--force",
    ]);
  });

  it("surfaces kaifuu stderr on failure", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    await expect(
      runItotoriCliCommand(
        [
          "patch",
          "--bundle",
          "/run/translated-bridge.json",
          "--source",
          "/games/sweetie",
          "--target",
          "/tmp/patched",
          "--scope",
          "dialogue-only",
        ],
        depsWithNativeRunner(calls, {
          status: 1,
          stdout: "",
          stderr: "kaifuu.reallive.patchback_target_nonempty",
        }),
      ),
    ).rejects.toThrow(/kaifuu\.reallive\.patchback_target_nonempty/u);
  });
});

describe("itotori validate", () => {
  it("wraps utsushi replay-validate then render-validate with the real patched Seen inputs", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    await runItotoriCliCommand(
      [
        "validate",
        "--seen",
        "/tmp/patched/REALLIVEDATA/Seen.txt",
        "--scene",
        "1",
        "--replay-log",
        "/run/replay-log.json",
        "--gameexe",
        "/tmp/patched/REALLIVEDATA/Gameexe.ini",
        "--game-dir",
        "/tmp/patched/REALLIVEDATA",
        "--source-seen",
        "/games/sweetie/REALLIVEDATA/Seen.txt",
        "--artifact-root",
        "/run/render-artifacts",
        "--render-output",
        "/run/render-evidence.json",
        "--expect-text-contains",
        "Good morning",
        "--redaction",
        "on",
        "--bg-asset",
        "BG001",
      ],
      depsWithNativeRunner(calls),
    );

    expect(calls).toHaveLength(2);
    const replayIndex = calls[0]!.args.indexOf("replay-validate");
    expect(calls[0]!.args.slice(replayIndex)).toEqual([
      "replay-validate",
      "--engine",
      "reallive",
      "--seen",
      "/tmp/patched/REALLIVEDATA/Seen.txt",
      "--scene",
      "1",
      "--print-replay-log",
      "/run/replay-log.json",
      "--dispatch-report",
      "/run/replay-log.json.dispatch.json",
      "--require-semantic-reached-path",
    ]);

    const renderIndex = calls[1]!.args.indexOf("render-validate");
    expect(calls[1]!.args.slice(renderIndex)).toEqual([
      "render-validate",
      "--engine",
      "reallive",
      "--seen",
      "/tmp/patched/REALLIVEDATA/Seen.txt",
      "--scene",
      "1",
      "--gameexe",
      "/tmp/patched/REALLIVEDATA/Gameexe.ini",
      "--game-dir",
      "/tmp/patched/REALLIVEDATA",
      "--artifact-root",
      "/run/render-artifacts",
      "--redaction",
      "on",
      "--output",
      "/run/render-evidence.json",
      "--source-seen",
      "/games/sweetie/REALLIVEDATA/Seen.txt",
      "--bg-asset",
      "BG001",
      "--expect-text-contains",
      "Good morning",
    ]);
  });

  it("does not run render-validate when replay-validate fails", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    await expect(
      runItotoriCliCommand(
        [
          "validate",
          "--seen",
          "/tmp/patched/REALLIVEDATA/Seen.txt",
          "--scene",
          "1",
          "--replay-log",
          "/run/replay-log.json",
          "--gameexe",
          "/tmp/patched/REALLIVEDATA/Gameexe.ini",
          "--game-dir",
          "/tmp/patched/REALLIVEDATA",
          "--artifact-root",
          "/run/render-artifacts",
          "--render-output",
          "/run/render-evidence.json",
        ],
        depsWithNativeRunner(calls, {
          status: 1,
          stdout: "",
          stderr: "utsushi.reallive.nwa.out_of_profile_compression",
        }),
      ),
    ).rejects.toThrow(/utsushi\.reallive\.nwa\.out_of_profile_compression/u);
    expect(calls).toHaveLength(1);
  });
});

describe("itotori patch + validate (env-gated real Sweetie proof)", () => {
  const sourceRoot = process.env.ITOTORI_CLI_REAL_SWEETIE_ROOT;
  const translatedBundlePath = process.env.ITOTORI_CLI_REAL_SWEETIE_TRANSLATED_BUNDLE;
  const expectedText = process.env.ITOTORI_CLI_REAL_SWEETIE_EXPECT_TEXT;
  const scene = process.env.ITOTORI_CLI_REAL_SWEETIE_SCENE ?? "1";
  const bgAsset = process.env.ITOTORI_CLI_REAL_SWEETIE_BG_ASSET;

  it.skipIf(!sourceRoot || !translatedBundlePath || !expectedText)(
    "applies a real translated Sweetie bundle and validates replay + render output",
    async () => {
      const realSourceRoot = sourceRoot as string;
      const sourceDataDir = resolveRealLiveDataDir(realSourceRoot);
      const sourceSeen = join(sourceDataDir, "Seen.txt");
      const sourceGameexe = join(sourceDataDir, "Gameexe.ini");
      const workDir = mkdtempSync(join(tmpdir(), "itotori-cli-patch-validate-real-"));
      const targetRoot = join(workDir, "patched");
      const patchedSeen = join(targetRoot, relative(realSourceRoot, sourceSeen));
      const replayLogPath = join(workDir, "replay-log.json");
      const renderArtifactsDir = join(workDir, "render-artifacts");
      const renderOutputPath = join(workDir, "render-evidence.json");

      expect(existsSync(sourceGameexe)).toBe(true);
      expect(hasG00Assets(sourceDataDir)).toBe(true);

      await runItotoriCliCommand(
        [
          "patch",
          "--source",
          realSourceRoot,
          "--target",
          targetRoot,
          "--bundle",
          translatedBundlePath as string,
          "--scope",
          "dialogue-only",
          "--force",
        ],
        baseDeps(),
      );
      expect(existsSync(patchedSeen)).toBe(true);
      expect(readFileSync(patchedSeen).equals(readFileSync(sourceSeen))).toBe(false);

      const validateArgs = [
        "validate",
        "--seen",
        patchedSeen,
        "--scene",
        scene,
        "--replay-log",
        replayLogPath,
        "--gameexe",
        sourceGameexe,
        "--game-dir",
        sourceDataDir,
        "--source-seen",
        sourceSeen,
        "--artifact-root",
        renderArtifactsDir,
        "--render-output",
        renderOutputPath,
        "--expect-text-contains",
        expectedText as string,
        "--redaction",
        "on",
      ];
      if (bgAsset !== undefined && bgAsset.length > 0) {
        validateArgs.push("--bg-asset", bgAsset);
      }
      await runItotoriCliCommand(validateArgs, baseDeps());
      expect(existsSync(replayLogPath)).toBe(true);
      expect(existsSync(renderOutputPath)).toBe(true);
    },
    600_000,
  );
});
