import { describe, expect, it } from "vitest";

import { runItotoriCliCommand, type ItotoriCliDependencies } from "../src/cli-handlers.js";
import { KAIFUU_NATIVE_OUTPUT_REDACTED } from "../src/extract/kaifuu-extract-seam.js";
import type { NativeCliProcessResult } from "../src/native-bin/cli-bin-resolver.js";

const MISSING_ARCHIVE_DIAGNOSTIC =
  "kaifuu.reallive.layout_not_found: no known RealLive layout under /synthetic/owned-source-root-00; " +
  "probed: /synthetic/owned-source-root-00/REALLIVEDATA/Seen.txt (data-directory), " +
  "/synthetic/owned-source-root-00/Seen.txt (flat-root); " +
  "also searched nested directories up to depth 4 for either layout; " +
  "pass --game-root pointing at a RealLive game root";

function baseDependencies(): ItotoriCliDependencies {
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

describe("itotori extract", () => {
  it("relays the native missing-archive diagnostic through the public command", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const dependencies = baseDependencies();
    dependencies.nativeCli = {
      env: {},
      runProcess: (command, args): NativeCliProcessResult => {
        calls.push({ command, args });
        return { status: 1, stdout: "", stderr: MISSING_ARCHIVE_DIAGNOSTIC };
      },
    };

    let caught: Error | undefined;
    try {
      await runItotoriCliCommand(
        [
          "extract",
          "--engine",
          "reallive",
          "--game-root",
          "/synthetic/owned-source-root-00",
          "--game-id",
          "fixture",
          "--game-version",
          "1",
          "--source-profile-id",
          "fixture-profile",
          "--source-locale",
          "ja-JP",
          "--scene",
          "1",
          "--bundle-output",
          "/synthetic/bridge.json",
        ],
        dependencies,
      );
    } catch (error) {
      if (error instanceof Error) caught = error;
      else throw error;
    }

    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toContain("extract");
    expect(Buffer.byteLength(MISSING_ARCHIVE_DIAGNOSTIC, "utf8")).toBe(347);
    expect(caught?.message).toContain(MISSING_ARCHIVE_DIAGNOSTIC);
    expect(caught?.message).not.toContain(KAIFUU_NATIVE_OUTPUT_REDACTED);
  });
});
