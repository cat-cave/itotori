import { existsSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { resolvePrivateCorpus } from "../../src/private-inventory.js";
import { createDecodeExtractRunner } from "../../src/extract/decode-extract-runner.js";

describe("in-studio decode/extract runner (real primary_corpus byte proof)", () => {
  it("produces a REAL v0.2 bridge from a real game root via the real kaifuu-cli (per-scene)", async () => {
    const corpusRoot = resolvePrivateCorpus("reallive", 1, "encrypted");
    if (!corpusRoot || !existsSync(corpusRoot)) {
      throw new Error(
        "in-studio decode/extract real-byte proof requires the selected RealLive corpus in the private inventory",
      );
    }
    const scene = 2031;
    // No injected runExtract -> the REAL kaifuu-cli runs.
    const runner = createDecodeExtractRunner();
    const outcome = await runner.runDecodeExtract({
      engine: "reallive",
      gameId: "primary_corpus-real",
      gameVersion: "1.0",
      sourceProfileId: "primary_corpus-hd-real",
      sourceLocale: "ja-JP",
      gameRoot: corpusRoot,
      scene,
    });
    expect(outcome.mode).toBe("per-scene");
    expect(outcome.bridge.schemaVersion).toBe("0.2.0");
    expect(outcome.bridge.units.length).toBeGreaterThan(0);
  }, 300_000);
});
