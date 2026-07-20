import { describe, expect, it } from "vitest";

import type { RunModeValue } from "../src/contracts/index.js";
import type { FactSnapshot } from "../src/prepass/index.js";
import {
  InMemoryArtifactLedger,
  SourceWikiSelectionError,
  orchestrateSourceWiki,
  type AnalystRunner,
} from "../src/source-wiki/index.js";

describe("source-Wiki run policy", () => {
  it("rejects partial production and pilot context rosters before an analyst runs", async () => {
    let calls = 0;
    const runner: AnalystRunner = async () => {
      calls += 1;
      return [];
    };
    for (const runMode of ["production", "pilot"] as const satisfies readonly RunModeValue[]) {
      await expect(
        orchestrateSourceWiki({
          snapshot: {} as FactSnapshot,
          sourceLanguage: "ja-JP",
          runMode,
          roles: ["A1"],
          concurrency: 1,
          runner,
          ledger: new InMemoryArtifactLedger(),
        }),
      ).rejects.toThrow(SourceWikiSelectionError);
    }
    expect(calls).toBe(0);
  });
});
