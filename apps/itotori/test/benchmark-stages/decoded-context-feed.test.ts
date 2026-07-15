// benchmark-decoded-context-feed — §5 anti-circularity boundary tests.
//
// Proves: (a) identical decoded-ground-truth context per unit across every
// contestant; (b) NO Itotori-interpretive context (scene summaries / character
// arcs / route-branch map / their artifact markers) leaks into the judge feed,
// while the decoded ground truth (speaker / scene / branch / source line) IS
// present. Synthetic fixtures only.

import { describe, expect, it } from "vitest";
import {
  DecodedContextFeedError,
  assertJudgeFeedGroundTruthOnly,
  buildDecodedContextFeed,
  contestantJudgeContexts,
  type ContestantCandidate,
  type DecodedContextFeedInput,
  type JudgeUnitInput,
} from "../../src/benchmark-stages/index.js";
import type { NarrativeStructure } from "../../src/structure/index.js";

const U_MAIN = "019ed010-0000-7000-8000-0000000000a1";
const U_BRANCH = "019ed010-0000-7000-8000-0000000000a2";

// A synthetic two-scene decode: scene 2031 (a select branching to scene 2040).
function syntheticStructure(): NarrativeStructure {
  return {
    schemaVersion: "utsushi.narrative-structure.v1",
    entryScene: 2031,
    sceneDispatchOrder: [2031, 2040],
    scenes: [
      {
        sceneId: 2031,
        selectionControl: "text-window",
        nextScene: 2040,
        messages: [
          { order: 0, speaker: "和人", text: "おはよう、りん。", textSurface: null },
          { order: 1, speaker: null, text: "朝の光が差し込む。", textSurface: null },
        ],
        choices: [
          {
            optionIndex: 0,
            label: "一緒に行く",
            branchEntryScene: 2040,
            branchMessages: [
              { order: 0, speaker: "りん", text: "じゃあ、行こっか。", textSurface: null },
            ],
          },
        ],
      },
      {
        sceneId: 2040,
        selectionControl: "none",
        nextScene: null,
        messages: [{ order: 0, speaker: "りん", text: "着いたよ。", textSurface: null }],
        choices: [],
      },
    ],
  };
}

function candidates(): ContestantCandidate[] {
  // Two units, three anonymized contestants each (blinded per §4.2).
  const contestants = ["contestant-alpha", "contestant-bravo", "contestant-charlie"];
  const out: ContestantCandidate[] = [];
  for (const contestantId of contestants) {
    out.push({ contestantId, unitId: U_MAIN, candidateText: `${contestantId}: Morning, Rin.` });
    out.push({ contestantId, unitId: U_BRANCH, candidateText: `${contestantId}: Let's go, then.` });
  }
  return out;
}

function baseInput(): DecodedContextFeedInput {
  return {
    structure: syntheticStructure(),
    unitRefs: [
      { unitId: U_MAIN, sceneId: 2031, messageOrder: 0 },
      { unitId: U_BRANCH, sceneId: 2031, messageOrder: 0, branchOptionIndex: 0 },
    ],
    candidates: candidates(),
  };
}

describe("buildDecodedContextFeed — decoded ground truth", () => {
  it("resolves speaker / scene / branch / source line from the decode", () => {
    const feed = buildDecodedContextFeed(baseInput());
    expect(feed).toHaveLength(2);

    const main = feed.find((u) => u.unitId === U_MAIN)!;
    expect(main.decodedContext.speaker).toBe("和人");
    expect(main.decodedContext.sourceLine).toBe("おはよう、りん。");
    expect(main.decodedContext.scene).toEqual({
      sceneId: 2031,
      dispatchPosition: 1,
      dispatchOrderLength: 2,
      nextScene: 2040,
    });
    expect(main.decodedContext.branch).toBeNull();

    const branch = feed.find((u) => u.unitId === U_BRANCH)!;
    expect(branch.decodedContext.speaker).toBe("りん");
    expect(branch.decodedContext.sourceLine).toBe("じゃあ、行こっか。");
    expect(branch.decodedContext.branch).toEqual({
      optionIndex: 0,
      label: "一緒に行く",
      branchEntryScene: 2040,
    });
  });

  it("attaches the IDENTICAL decoded context to every contestant on a unit", () => {
    const feed = buildDecodedContextFeed(baseInput());
    for (const unit of feed) {
      const perContestant = contestantJudgeContexts(unit);
      expect(perContestant.length).toBeGreaterThan(1);
      const [first, ...rest] = perContestant;
      for (const view of rest) {
        // Byte-identical context across contestants (deep + reference equal).
        expect(view.decodedContext).toBe(first.decodedContext);
        expect(JSON.stringify(view.decodedContext)).toBe(JSON.stringify(first.decodedContext));
      }
    }
  });
});

describe("anti-circularity boundary — no Itotori-interpretive leakage (§5)", () => {
  it("excludes Itotori interpretive context while keeping the decoded ground truth", () => {
    const structure = syntheticStructure();
    const feed = buildDecodedContextFeed(baseInput());

    const serializedFeed = JSON.stringify(feed);
    expect(structure.scenes).toHaveLength(2);
    expect(serializedFeed).not.toContain("structure:route-graph");
    expect(serializedFeed).not.toContain("structure:character:");
    // And the ground truth IS present.
    expect(serializedFeed).toContain("おはよう、りん。"); // source line
    expect(serializedFeed).toContain("和人"); // speaker

    // The typed/runtime boundary asserter passes for a real feed.
    expect(() => assertJudgeFeedGroundTruthOnly(feed)).not.toThrow();
  });

  it("assertJudgeFeedGroundTruthOnly THROWS when interpretive context is smuggled in", () => {
    const feed = buildDecodedContextFeed(baseInput());

    // (a) a non-ground-truth field grafted onto the context object.
    const withExtraField: JudgeUnitInput[] = [
      {
        ...feed[0],
        decodedContext: {
          ...feed[0].decodedContext,
          // The exact interpretive field Itotori's inject stage produces.
          sceneSummaryText: "Scene 2031: 2 play-order messages, speakers 和人.",
        } as never,
      },
    ];
    expect(() => assertJudgeFeedGroundTruthOnly(withExtraField)).toThrow(DecodedContextFeedError);

    // (b) an interpretive artifact MARKER hidden inside an allowed string field.
    const withMarker: JudgeUnitInput[] = [
      {
        ...feed[0],
        decodedContext: { ...feed[0].decodedContext, sourceLine: "character-arc:和人 leak" },
      },
    ];
    expect(() => assertJudgeFeedGroundTruthOnly(withMarker)).toThrow(
      /interpretive artifact marker/,
    );
  });
});

describe("buildDecodedContextFeed — structured refusals", () => {
  it("refuses an empty unit set", () => {
    expect(() => buildDecodedContextFeed({ ...baseInput(), unitRefs: [] })).toThrow(
      DecodedContextFeedError,
    );
  });

  it("refuses a unit referencing a scene absent from the decode", () => {
    const input = baseInput();
    input.unitRefs = [{ unitId: U_MAIN, sceneId: 9999, messageOrder: 0 }];
    expect(() => buildDecodedContextFeed(input)).toThrow(/scene 9999 not present/);
  });

  it("refuses a unit referencing a missing message order", () => {
    const input = baseInput();
    input.unitRefs = [{ unitId: U_MAIN, sceneId: 2031, messageOrder: 99 }];
    input.candidates = candidates().filter((c) => c.unitId === U_MAIN);
    expect(() => buildDecodedContextFeed(input)).toThrow(/message order 99 not present/);
  });

  it("refuses a unit with no contestant candidates", () => {
    const input = baseInput();
    input.candidates = candidates().filter((c) => c.unitId === U_MAIN);
    expect(() => buildDecodedContextFeed(input)).toThrow(/no contestant candidates/);
  });

  it("refuses duplicate contestants on a unit", () => {
    const input = baseInput();
    input.unitRefs = [{ unitId: U_MAIN, sceneId: 2031, messageOrder: 0 }];
    input.candidates = [
      { contestantId: "dup", unitId: U_MAIN, candidateText: "a" },
      { contestantId: "dup", unitId: U_MAIN, candidateText: "b" },
    ];
    expect(() => buildDecodedContextFeed(input)).toThrow(/duplicate contestant/);
  });
});
