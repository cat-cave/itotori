// Benchmark meta-validity SENSITIVITY honesty pin (path b).
//
// Methodology §9 (docs/itotori-translation-benchmark-methodology.md): residue /
// overflow sabotage kinds carry judge-INDEPENDENT weight (caught by real §3
// deterministic metrics / gates). meaning_shift / speaker_voice_drift are
// judge-dependent — taxonomy lists only llm_qa + human_review — so a fixture
// qualityScoreFn that recognizes SABOTAGE_*_MARKER is a test double, not proof
// of judge-independent sensitivity for those kinds.
//
// This pin freezes the taxonomy detector split so a future change cannot silently
// re-claim meaning/voice as metric-caught without updating expectedDetectorKinds.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function taxonomy(): {
  seededDefectKinds: Array<{
    id: string;
    expectedDetectorKinds: string[];
  }>;
} {
  return JSON.parse(
    readFileSync(
      new URL("../../../docs/localization-quality-taxonomy.json", import.meta.url),
      "utf8",
    ),
  ) as {
    seededDefectKinds: Array<{
      id: string;
      expectedDetectorKinds: string[];
    }>;
  };
}

function kind(id: string): { id: string; expectedDetectorKinds: string[] } {
  const found = taxonomy().seededDefectKinds.find((entry) => entry.id === id);
  if (found === undefined) {
    throw new Error(`taxonomy seededDefectKinds missing '${id}'`);
  }
  return found;
}

describe("benchmark sensitivity honesty (taxonomy detector split)", () => {
  it("meaning_shift and speaker_voice_drift are judge-only (not deterministic_qa)", () => {
    for (const id of ["meaning_shift", "speaker_voice_drift"] as const) {
      const detectors = new Set(kind(id).expectedDetectorKinds);
      expect(detectors.has("llm_qa"), `${id} must list llm_qa`).toBe(true);
      expect(detectors.has("human_review"), `${id} must list human_review`).toBe(true);
      expect(
        detectors.has("deterministic_qa"),
        `${id} must NOT claim deterministic_qa — meaning/voice sensitivity is judge-dependent; a fixture SABOTAGE_*_MARKER qualityScoreFn is a test double only`,
      ).toBe(false);
      expect(
        detectors.has("runtime_probe"),
        `${id} must NOT claim runtime_probe as a metric stand-in`,
      ).toBe(false);
    }
  });

  it("layout_overflow is metric/runtime-caught (judge-independent weight)", () => {
    const detectors = new Set(kind("layout_overflow").expectedDetectorKinds);
    expect(
      detectors.has("deterministic_qa") || detectors.has("runtime_probe"),
      "layout_overflow must list deterministic_qa and/or runtime_probe so overflow sabotage carries metric weight without a scripted judge",
    ).toBe(true);
  });
});
