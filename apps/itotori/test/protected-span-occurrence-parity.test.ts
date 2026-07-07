// ITOTORI-144 — Drift guard: the standalone protected-span check tool and the
// deterministic pre-export QA MUST share one duplicate-span occurrence
// implementation. These tests pin that both paths agree on a source with
// REPEATED protected-span tokens; if either path re-inlines a divergent copy,
// the repeat-handling scenarios below break.

import { describe, expect, it } from "vitest";
import { protectedSpanCheck } from "../src/agents/examples.js";
import { runDeterministicPreExportQa } from "../src/services/deterministic-pre-export-qa.js";
import { missingRequiredProtectedSpanOccurrences } from "../src/services/protected-span-occurrences.js";
import type { ProjectState } from "../src/services/project-workflow.js";

const BRIDGE_UNIT_ID = "019ed020-0000-7000-8000-000000000144";

/**
 * Builds a minimal single-unit project whose protected spans are exactly the
 * repeated-token `spanRaws`, drafted to `targetText`. Mirrors the
 * deterministicPreExportQaJobFixture bridge shape so runDeterministicPreExportQa
 * exercises the same occurrence path the export gate uses.
 */
function projectWithProtectedSpans(spanRaws: string[], targetText: string): ProjectState {
  return {
    projectId: "project-itotori-144",
    localeBranchId: "locale-en-us",
    targetLocale: "en-US",
    drafts: { [BRIDGE_UNIT_ID]: targetText },
    bridge: {
      schemaVersion: "0.1.0",
      bridgeId: "019ed020-0000-7000-8000-000000000020",
      sourceBundleHash: "hash-itotori-144",
      sourceLocale: "ja-JP",
      extractorName: "kaifuu-fixture",
      extractorVersion: "0.0.0",
      units: [
        {
          bridgeUnitId: BRIDGE_UNIT_ID,
          sourceUnitKey: "repeated.scene.001.line.001",
          occurrenceId: "occurrence-1",
          sourceHash: "source-hash",
          sourceLocale: "ja-JP",
          // Source carries the repeated tokens; no terminal punctuation so the
          // punctuation check stays out of the protected-span comparison.
          sourceText: spanRaws.join(" "),
          textSurface: "dialogue",
          protectedSpans: spanRaws.map((raw) => ({
            kind: "placeholder",
            raw,
            start: 0,
            end: raw.length,
            preserveMode: "exact" as const,
          })),
          patchRef: {
            assetId: "source.json",
            writeMode: "replace",
            sourceUnitKey: "repeated.scene.001.line.001",
          },
        },
      ],
    },
  };
}

/** Span raws flagged by the standalone tool.protected-span-check. */
function toolMissingSpans(spanRaws: string[], targetText: string): string[] {
  return protectedSpanCheck({
    targetText,
    protectedSpans: spanRaws,
  }).missingProtectedSpans;
}

/** Span raws flagged by the deterministic pre-export QA protected-span check. */
function preExportMissingSpans(spanRaws: string[], targetText: string): string[] {
  const result = runDeterministicPreExportQa(projectWithProtectedSpans(spanRaws, targetText));
  return result.failures
    .filter((failure) => failure.checkCode === "protected-span-missing")
    .map((failure) => failure.expected);
}

describe("ITOTORI-144 shared protected-span occurrence logic", () => {
  it("the shared helper counts non-overlapping literal repeats", () => {
    expect(missingRequiredProtectedSpanOccurrences(["{x}", "{x}"], "{x} {x}")).toEqual([]);
    expect(missingRequiredProtectedSpanOccurrences(["{x}", "{x}"], "{x}")).toEqual(["{x}"]);
    expect(missingRequiredProtectedSpanOccurrences(["{x}", "{x}"], "none")).toEqual(["{x}", "{x}"]);
  });

  const scenarios: Array<{
    name: string;
    spans: string[];
    target: string;
    expectedMissing: string[];
  }> = [
    {
      name: "repeats satisfied exactly (2 required, 2 present)",
      spans: ["{player}", "{player}"],
      target: "Hi {player} and {player}!",
      expectedMissing: [],
    },
    {
      name: "one repeat short (2 required, 1 present)",
      spans: ["{player}", "{player}"],
      target: "Hi {player}!",
      expectedMissing: ["{player}"],
    },
    {
      name: "two repeats short (3 required, 1 present)",
      spans: ["{x}", "{x}", "{x}"],
      target: "{x}",
      expectedMissing: ["{x}", "{x}"],
    },
    {
      name: "mixed distinct + repeat, one repeat short",
      spans: ["{a}", "{b}", "{a}"],
      target: "{a} {b}",
      expectedMissing: ["{a}"],
    },
    {
      name: "repeats over-satisfied (2 required, 3 present)",
      spans: ["{x}", "{x}"],
      target: "{x} {x} {x}",
      expectedMissing: [],
    },
    {
      name: "all repeats dropped entirely (2 required, 0 present)",
      spans: ["{x}", "{x}"],
      target: "nothing here",
      expectedMissing: ["{x}", "{x}"],
    },
  ];

  describe.each(scenarios)(
    "repeated-token scenario: $name",
    ({ spans, target, expectedMissing }) => {
      it("standalone tool matches the shared occurrence logic", () => {
        expect(toolMissingSpans(spans, target)).toEqual(expectedMissing);
        expect(toolMissingSpans(spans, target)).toEqual(
          missingRequiredProtectedSpanOccurrences(spans, target),
        );
      });

      it("deterministic pre-export QA matches the shared occurrence logic", () => {
        expect(preExportMissingSpans(spans, target)).toEqual(expectedMissing);
        expect(preExportMissingSpans(spans, target)).toEqual(
          missingRequiredProtectedSpanOccurrences(spans, target),
        );
      });

      it("standalone tool and pre-export QA agree (no drift)", () => {
        expect(toolMissingSpans(spans, target)).toEqual(preExportMissingSpans(spans, target));
      });
    },
  );

  it("the pre-export QA surfaces the required-vs-observed repeat count derived from the shared logic", () => {
    // 2 required {player}, only 1 present → the deterministic QA message reports
    // the shortage using the shared occurrence counter.
    const result = runDeterministicPreExportQa(
      projectWithProtectedSpans(["{player}", "{player}"], "Hi {player}!"),
    );
    const failure = result.failures.find((f) => f.checkCode === "protected-span-missing");
    expect(failure).toBeDefined();
    expect(failure?.expected).toBe("{player}");
    expect(failure?.message).toMatch(/1 occurrence\(s\).*2 are required/u);
  });
});
