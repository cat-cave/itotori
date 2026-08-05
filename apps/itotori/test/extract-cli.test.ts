import { describe, expect, it } from "vitest";

import { runItotoriCliCommand, type ItotoriCliDependencies } from "../src/cli-handlers.js";
import { KAIFUU_NATIVE_OUTPUT_REDACTED } from "../src/extract/kaifuu-extract-seam.js";
import type { NativeCliProcessResult } from "../src/native-bin/cli-bin-resolver.js";

const MISSING_METADATA_DIAGNOSTIC =
  "missing RealLive bridge metadata flag --game-version; pass --game-id, --game-version, " +
  "--source-profile-id, and --source-locale";

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
  it("relays the native missing-metadata diagnostic through the public command", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const dependencies = baseDependencies();
    dependencies.nativeCli = {
      env: {},
      runProcess: (command, args): NativeCliProcessResult => {
        calls.push({ command, args });
        return { status: 1, stdout: "", stderr: MISSING_METADATA_DIAGNOSTIC };
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
          "/synthetic/source",
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
    expect(caught?.message).toContain(MISSING_METADATA_DIAGNOSTIC);
    expect(caught?.message).not.toContain(KAIFUU_NATIVE_OUTPUT_REDACTED);
  });
});
