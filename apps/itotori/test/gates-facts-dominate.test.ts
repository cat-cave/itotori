// Facts dominate findings; signals are never verdicts; the gate home is a
// genuine rehome (no import of an old agent/benchmark home or a model layer).

import { readdirSync, readFileSync } from "node:fs";

import { DefectBundleSchema } from "../src/contracts/index.js";
import type { BackTranslateResult, ReviewVerdict } from "../src/contracts/index.js";
import { describe, expect, it } from "vitest";

import {
  backTranslationSignals,
  buildDefect,
  joinDefects,
  voiceFingerprintSignals,
} from "../src/gates/index.js";

import { makeAccepted, makeSnapshot, makeUnit, sha } from "./support/gate-fixtures.js";

const SNAP = sha("loc-snapshot");

function passVerdict(unitId: string, rubric: ReviewVerdict["rubric"]): ReviewVerdict {
  return {
    schemaVersion: "itotori.review-verdict.v1",
    reviewId: `review:pass:${unitId}`,
    localizationSnapshotId: SNAP,
    roleId: "Q1",
    rubric,
    unitId,
    basis: { kind: "wiki-first", bibleRenderingIds: ["bible:x"] },
    verdict: "PASS",
    severity: "none",
    span: null,
    category: null,
    evidenceIds: ["human-note:e1"],
    repairConstraint: null,
  };
}

function failVerdict(unitId: string, rubric: ReviewVerdict["rubric"]): ReviewVerdict {
  return {
    schemaVersion: "itotori.review-verdict.v1",
    reviewId: `review:fail:${unitId}`,
    localizationSnapshotId: SNAP,
    roleId: "Q2",
    rubric,
    unitId,
    basis: { kind: "wiki-first", bibleRenderingIds: ["bible:x"] },
    verdict: "FAIL",
    severity: "major",
    span: { spanId: "span:1", surface: "target", text: "bad term" },
    category: "term-sense",
    evidenceIds: ["human-note:e1"],
    repairConstraint: "use the approved term",
  };
}

describe("facts dominate findings", () => {
  it("keeps a deterministic defect under a contrary reviewer PASS", () => {
    const deterministic = [
      buildDefect({
        unitId: "unit:d1",
        category: "glossary-exact",
        detail: "missing approved form",
        basisFactIds: ["glossary:t1"],
      }),
    ];
    const bundle = joinDefects({
      localizationSnapshotId: SNAP,
      draftBatchId: "batch:1",
      deterministic,
      reviews: [passVerdict("unit:d1", "terminology")],
      evaluatedGates: ["glossary-exact"],
    });

    expect(() => DefectBundleSchema.parse(bundle)).not.toThrow();
    expect(bundle.defects.some((defect) => defect.origin === "deterministic")).toBe(true);
    expect(bundle.resolution).toBe("repair");
  });

  it("suppresses a contradictory reviewer FAIL when the deterministic fact passed", () => {
    const bundle = joinDefects({
      localizationSnapshotId: SNAP,
      draftBatchId: "batch:2",
      deterministic: [],
      reviews: [failVerdict("unit:d2", "terminology")],
      evaluatedGates: ["glossary-exact"],
    });

    expect(bundle.defects).toHaveLength(0);
    expect(bundle.factDominance).toHaveLength(1);
    expect(bundle.factDominance[0]?.suppressedReviewId).toBe("review:fail:unit:d2");
    expect(bundle.resolution).toBe("none");
  });

  it("retains a reviewer FAIL if its deterministic gate did not run", () => {
    const bundle = joinDefects({
      localizationSnapshotId: SNAP,
      draftBatchId: "batch:3",
      deterministic: [],
      reviews: [failVerdict("unit:d3", "terminology")],
      evaluatedGates: [],
    });

    expect(bundle.factDominance).toHaveLength(0);
    expect(bundle.defects.some((defect) => defect.origin === "reviewer")).toBe(true);
  });

  it("does not suppress a meaning finding because no deterministic fact owns it", () => {
    const bundle = joinDefects({
      localizationSnapshotId: SNAP,
      draftBatchId: "batch:4",
      deterministic: [],
      reviews: [failVerdict("unit:d4", "meaning")],
      evaluatedGates: ["glossary-exact"],
    });

    expect(bundle.factDominance).toHaveLength(0);
    expect(bundle.defects).toHaveLength(1);
  });
});

describe("back-translation and voice are signals, not verdicts", () => {
  const backTranslate: BackTranslateResult = {
    schemaVersion: "itotori.tool.back-translate-result.v1",
    tool: "back_translate",
    snapshotId: SNAP,
    requestHash: sha("req"),
    resultHash: sha("res"),
    page: {
      kind: "complete",
      requestCursor: null,
      returnedRows: 1,
      returnedBytes: 1,
      maxRows: 10,
      maxBytes: 10,
      nextCursor: null,
    },
    diagnosticOnly: true,
    unitId: "unit:bt",
    sourceLanguage: "ja",
    targetLanguage: "en",
    backTranslation: "a different meaning",
    signals: [
      { kind: "omission-risk", confidence: "high", sourceSpanId: null, note: "clause dropped" },
    ],
  };

  it("keeps a tripped back-translation result outside the defect contract", () => {
    const signals = backTranslationSignals(backTranslate);

    expect(signals).toHaveLength(1);
    expect(signals[0]?.tripped).toBe(true);
    expect("gate" in signals[0]!).toBe(false);
    expect("origin" in signals[0]!).toBe(false);
  });

  it("leaves the release bundle clean despite tripped back-translation and voice signals", () => {
    const u0 = makeUnit({
      factId: "unit:v0",
      speaker: {
        knowledgeState: "known",
        speakerId: "spk-1",
        displayName: "A",
        revealState: "revealed",
      },
    });
    const u1 = makeUnit({
      factId: "unit:v1",
      speaker: {
        knowledgeState: "known",
        speakerId: "spk-1",
        displayName: "A",
        revealState: "revealed",
      },
    });
    const snapshot = makeSnapshot({ units: [u0, u1] });
    const voice = voiceFingerprintSignals(
      snapshot,
      [
        makeAccepted(u0, "x"),
        makeAccepted(u1, "a very much longer line than the first one indeed"),
      ],
      0.1,
    );

    expect(backTranslationSignals(backTranslate).some((signal) => signal.tripped)).toBe(true);
    expect(voice.some((signal) => signal.tripped)).toBe(true);

    const bundle = joinDefects({
      localizationSnapshotId: SNAP,
      draftBatchId: "batch:signals",
      deterministic: [],
      reviews: [],
      evaluatedGates: ["glossary-exact"],
    });
    expect(bundle.defects).toHaveLength(0);
    expect(bundle.resolution).toBe("none");
  });
});

describe("no-legacy gate boundary", () => {
  const gatesDir = new URL("../src/gates/", import.meta.url);

  it("imports neither retired gate homes nor a model layer", () => {
    const forbidden = [
      "/agents/",
      "../agents",
      "/orchestrator/",
      "../orchestrator",
      "/benchmark-stages/",
      "../benchmark-stages",
      "deterministic-pre-export-qa",
      "/llm/",
      "../llm",
    ];

    for (const file of readdirSync(gatesDir).filter((name) => name.endsWith(".ts"))) {
      const source = readFileSync(new URL(file, gatesDir), "utf8");
      const importLines = source
        .split("\n")
        .filter((line) => /^\s*import\b/.test(line) || /\bfrom\s+"/.test(line));
      for (const line of importLines) {
        for (const token of forbidden) {
          expect(line.includes(token), `${file}: ${line.trim()}`).toBe(false);
        }
      }
    }
  });
});
