import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { resolvePrivateCorpus } from "../../src/private-inventory.js";
import { runKaifuuExtract } from "../../src/extract/kaifuu-extract-seam.js";

describe("runKaifuuExtract (real Softpal byte oracle)", () => {
  it("drives the real softpal extract seam and writes a real bridge bundle", () => {
    const softpalRoot = resolvePrivateCorpus("softpal", 1, "plain");
    if (!softpalRoot || !existsSync(softpalRoot)) {
      throw new Error(
        "Softpal extract real-byte proof requires the selected Softpal corpus in the private inventory",
      );
    }
    const workDir = mkdtempSync(join(tmpdir(), "itotori-softpal-real-"));
    const bridgePath = join(workDir, "bridge.json");
    try {
      const result = runKaifuuExtract({
        engine: "softpal",
        gameRoot: softpalRoot,
        bundleOutputPath: bridgePath,
      });
      expect(result.engine).toBe("softpal");
      expect(result.mode).toBe("whole-game");
      expect(result.status).toBe(0);
      const bridge = JSON.parse(readFileSync(bridgePath, "utf8")) as { units?: unknown[] };
      expect(Array.isArray(bridge.units)).toBe(true);
      expect(bridge.units?.length).toBeGreaterThan(0);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});
