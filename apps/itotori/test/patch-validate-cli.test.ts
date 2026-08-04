import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    resetDatabase: async () => {
      throw new Error("resetDatabase should not be called");
    },
    withServices: async () => {
      throw new Error("withServices should not be called");
    },
  };
}

/** A minimal on-disk RealLive game root so `itotori patch` DERIVES the engine
 * (reallive) from the source artifacts instead of a hard-coded insert. */
function makeRealLiveSourceRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "itotori-patch-cli-source-"));
  mkdirSync(join(root, "REALLIVEDATA"), { recursive: true });
  writeFileSync(join(root, "REALLIVEDATA", "Seen.txt"), "");
  writeFileSync(join(root, "REALLIVEDATA", "Gameexe.ini"), "");
  return root;
}

/** A minimal on-disk Softpal game root (loose SCRIPT.SRC + TEXT.DAT). */
function makeSoftpalSourceRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "itotori-patch-cli-softpal-"));
  writeFileSync(join(root, "SCRIPT.SRC"), "");
  writeFileSync(join(root, "TEXT.DAT"), "");
  return root;
}

describe("itotori patch", () => {
  it("derives the RealLive engine from the source and wraps kaifuu patch --engine reallive", async () => {
    const source = makeRealLiveSourceRoot();
    const calls: Array<{ command: string; args: string[] }> = [];
    await runItotoriCliCommand(
      [
        "patch",
        "--bundle",
        "/run/translated-bridge.json",
        "--source",
        source,
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
      "--source",
      source,
      "--target",
      "/tmp/patched",
      "--bundle",
      "/run/translated-bridge.json",
      "--scope",
      "dialogue-only",
      "--force",
    ]);
  });

  it("derives the Softpal engine from the source and wraps kaifuu patch --engine softpal", async () => {
    const source = makeSoftpalSourceRoot();
    const calls: Array<{ command: string; args: string[] }> = [];
    await runItotoriCliCommand(
      [
        "patch",
        "--bundle",
        "/run/translated-bridge.json",
        "--patch",
        "/run/patch-export.json",
        "--source",
        source,
        "--target",
        "/tmp/patched",
        "--scope",
        "dialogue-only",
      ],
      depsWithNativeRunner(calls),
    );

    expect(calls).toHaveLength(1);
    const patchIndex = calls[0]!.args.indexOf("patch");
    expect(calls[0]!.args.slice(patchIndex)).toEqual([
      "patch",
      "--engine",
      "softpal",
      "--source",
      source,
      "--patch",
      "/run/patch-export.json",
      "--output",
      "/tmp/patched",
    ]);
  });

  it("surfaces kaifuu stderr on failure", async () => {
    const source = makeRealLiveSourceRoot();
    const calls: Array<{ command: string; args: string[] }> = [];
    await expect(
      runItotoriCliCommand(
        [
          "patch",
          "--bundle",
          "/run/translated-bridge.json",
          "--source",
          source,
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
        "--engine",
        "reallive",
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
      "--artifact-root",
      "/tmp/patched",
      "--launch-descriptor",
      JSON.stringify({
        scene: 1,
        gameexePath: "/tmp/patched/REALLIVEDATA/Gameexe.ini",
        g00Dir: "/tmp/patched/REALLIVEDATA/g00",
      }),
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
          "--engine",
          "reallive",
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
