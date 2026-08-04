import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  detectPatchbackEngineFromAdapters,
  enginePatchbackAdapters,
  materializePatchbackProduceInput,
  PatchbackEngineSelectionError,
} from "../src/patchback/index.js";

const MATERIALIZE_INPUT = {
  gameId: "test-game",
  gameVersion: "1.0.0",
  sourceProfileId: "test-profile",
  sourceLocale: "ja-JP",
};

describe("source-detected dashboard input materialization", () => {
  it("surfaces an actionable typed no-engine-detected failure for an empty source", () => {
    withTempRoot((root) => {
      expectSelectionError(
        () => materializePatchbackProduceInput({ dataRoot: root, ...MATERIALIZE_INPUT }),
        "no-engine-detected",
      );
    });
  });

  it("surfaces an actionable typed ambiguous-engine failure for conflicting source markers", () => {
    withTempRoot((root) => {
      writeFile(root, ["REALLIVEDATA", "Seen.txt"], "");
      writeFile(root, ["REALLIVEDATA", "Gameexe.ini"], "");
      writeFile(root, ["www", "data", "System.json"], "{}");

      expectSelectionError(
        () => materializePatchbackProduceInput({ dataRoot: root, ...MATERIALIZE_INPUT }),
        "ambiguous-engine",
      );
    });
  });

  it("fails closed when the matching adapter is removed instead of selecting a fallback", () => {
    withTempRoot((root) => {
      writeFile(root, ["REALLIVEDATA", "Seen.txt"], "");
      writeFile(root, ["REALLIVEDATA", "Gameexe.ini"], "");
      const withoutMatchingAdapter = enginePatchbackAdapters().filter(
        (adapter) => adapter.engineId !== "reallive",
      );

      expectSelectionError(
        () => detectPatchbackEngineFromAdapters(root, withoutMatchingAdapter),
        "no-engine-detected",
      );
    });
  });
});

function withTempRoot(run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "itotori-patchback-detect-"));
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function writeFile(root: string, path: readonly string[], contents: string): void {
  const target = join(root, ...path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

function expectSelectionError(
  operation: () => unknown,
  code: PatchbackEngineSelectionError["code"],
): void {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(PatchbackEngineSelectionError);
    if (error instanceof PatchbackEngineSelectionError) {
      expect(error.code).toBe(code);
      expect(error.message).toContain("source root");
      return;
    }
    throw error;
  }
  throw new Error(`expected PatchbackEngineSelectionError with code '${code}'`);
}
