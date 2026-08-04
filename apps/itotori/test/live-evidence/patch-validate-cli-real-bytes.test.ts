import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

import { runItotoriCliCommand, type ItotoriCliDependencies } from "../../src/cli-handlers.js";
import { resolvePrivateCorpus } from "../../src/private-inventory.js";

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

function resolveRealLiveDataDir(sourceRoot: string): string {
  let current = sourceRoot;
  for (let visited = 0; visited <= 4; visited += 1) {
    const directDataDir = join(current, "REALLIVEDATA");
    if (existsSync(join(directDataDir, "Seen.txt"))) return directDataDir;

    const children = readdirSync(current, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(current, entry.name));
    const childRoots = children.filter((child) =>
      existsSync(join(child, "REALLIVEDATA", "Seen.txt")),
    );
    if (childRoots.length === 1) return join(childRoots[0]!, "REALLIVEDATA");
    if (children.length !== 1) break;
    current = children[0]!;
  }

  throw new Error(
    `[patch-validate-real] selected private inventory corpus must contain REALLIVEDATA/Seen.txt: ${sourceRoot}`,
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
    if (current.depth >= 4) continue;
    for (const entry of entries) {
      if (entry.isDirectory()) {
        frontier.push({ dir: join(current.dir, entry.name), depth: current.depth + 1 });
      }
    }
  }
  return false;
}

describe("itotori patch + validate real-byte proof", () => {
  it("applies a real translated Sweetie bundle and validates replay + render output", async () => {
    const sourceRoot = resolvePrivateCorpus("reallive", 1, "encrypted");
    if (!sourceRoot) {
      throw new Error(
        "patch-validate real-byte proof requires a selected RealLive corpus in the private inventory",
      );
    }
    const validationRoot = join(sourceRoot, ".itotori", "patch-validate");
    const translatedBundlePath = join(validationRoot, "translated.json");
    const expectedTextPath = join(validationRoot, "expected.txt");
    if (!existsSync(translatedBundlePath) || !existsSync(expectedTextPath)) {
      throw new Error(
        "patch-validate real-byte proof requires .itotori/patch-validate/translated.json and expected.txt in the selected private corpus",
      );
    }
    const expectedText = readFileSync(expectedTextPath, "utf8").trim();
    if (expectedText.length === 0) {
      throw new Error(
        "patch-validate real-byte proof requires a non-empty .itotori/patch-validate/expected.txt",
      );
    }
    const scene = "1";
    const bgAsset = join(validationRoot, "background.g00");
    const sourceDataDir = resolveRealLiveDataDir(sourceRoot);
    const sourceSeen = join(sourceDataDir, "Seen.txt");
    const sourceGameexe = join(sourceDataDir, "Gameexe.ini");
    const workDir = mkdtempSync(join(tmpdir(), "itotori-cli-patch-validate-real-"));
    const targetRoot = join(workDir, "patched");
    const patchedSeen = join(targetRoot, relative(sourceRoot, sourceSeen));
    const replayLogPath = join(workDir, "replay-log.json");
    const renderArtifactsDir = join(workDir, "render-artifacts");
    const renderOutputPath = join(workDir, "render-evidence.json");

    expect(existsSync(sourceGameexe)).toBe(true);
    expect(hasG00Assets(sourceDataDir)).toBe(true);

    await runItotoriCliCommand(
      [
        "patch",
        "--source",
        sourceRoot,
        "--target",
        targetRoot,
        "--bundle",
        translatedBundlePath,
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
      expectedText,
      "--redaction",
      "on",
    ];
    if (bgAsset.length > 0) {
      validateArgs.push("--bg-asset", bgAsset);
    }
    await runItotoriCliCommand(validateArgs, baseDeps());
    expect(existsSync(replayLogPath)).toBe(true);
    expect(existsSync(renderOutputPath)).toBe(true);
  }, 600_000);
});
