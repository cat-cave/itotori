import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { runItotoriCliCommand, type ItotoriCliDependencies } from "../src/cli-handlers.js";
import { KAIFUU_NATIVE_OUTPUT_REDACTED } from "../src/extract/kaifuu-extract-seam.js";
import type { NativeCliProcessResult } from "../src/native-bin/cli-bin-resolver.js";

const MISSING_ARCHIVE_DIAGNOSTIC =
  "REALLIVEDATA/Seen.txt not found under /synthetic/owned-source-root-00; " +
  "pass --game-root pointing at a RealLive game root";

function baseDependencies(projectPath: string, projectDocument: unknown): ItotoriCliDependencies {
  return {
    io: {
      readJson: (path) => {
        if (path !== projectPath) throw new Error(`unexpected readJson path: ${path}`);
        return projectDocument;
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
  const temporaryRoots: string[] = [];

  afterEach(() => {
    while (temporaryRoots.length > 0) {
      const root = temporaryRoots.pop();
      if (root !== undefined) rmSync(root, { recursive: true, force: true });
    }
  });

  it("relays the native missing-archive diagnostic through the public command", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "itotori-extract-cli-"));
    temporaryRoots.push(projectDir);
    const projectPath = join(projectDir, "project.json");
    const projectDocument = {
      schemaVersion: 1,
      engine: "reallive",
      adapter: {},
      source: { root: "/synthetic/owned-source-root-00" },
      identity: {
        id: "fixture",
        version: "1",
        sourceLocale: "ja-JP",
        sourceProfileId: "fixture-profile",
      },
      extract: {
        output: join(projectDir, "bridge.json"),
        scope: { kind: "all" },
      },
      structure: {
        output: join(projectDir, "structure.json"),
      },
    };
    writeFileSync(projectPath, `${JSON.stringify(projectDocument)}\n`);

    const calls: Array<{ command: string; args: string[] }> = [];
    const dependencies = baseDependencies(projectPath, projectDocument);
    dependencies.nativeCli = {
      env: {},
      runProcess: (command, args): NativeCliProcessResult => {
        calls.push({ command, args });
        return { status: 1, stdout: "", stderr: MISSING_ARCHIVE_DIAGNOSTIC };
      },
    };

    let caught: Error | undefined;
    try {
      await runItotoriCliCommand(["extract", "--project", projectPath], dependencies);
    } catch (error) {
      if (error instanceof Error) caught = error;
      else throw error;
    }

    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toContain("extract");
    expect(Buffer.byteLength(MISSING_ARCHIVE_DIAGNOSTIC, "utf8")).toBe(120);
    expect(caught?.message).toContain(MISSING_ARCHIVE_DIAGNOSTIC);
    expect(caught?.message).not.toContain(KAIFUU_NATIVE_OUTPUT_REDACTED);
  });
});
