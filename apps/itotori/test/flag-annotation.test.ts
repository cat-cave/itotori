// play-flag-composer — pure mapping unit tests for flag → ManualFeedbackImport.

import { describe, expect, it } from "vitest";
import { feedbackSourceKindValues, feedbackTypeValues } from "@itotori/db";
import {
  buildPlayFlagFeedbackInput,
  feedbackTypeForFlagCategory,
  PLAY_FLAG_SEVERITIES,
} from "../src/play/flag-annotation.js";

describe("play-flag-composer — flag annotation mapping", () => {
  it("exposes the closed annotation-severity ramp", () => {
    expect(PLAY_FLAG_SEVERITIES).toEqual(["blocker", "critical", "warning", "note"]);
  });

  it("maps categories onto the closed FeedbackType vocabulary", () => {
    expect(feedbackTypeForFlagCategory("tone")).toBe(feedbackTypeValues.stylePreference);
    expect(feedbackTypeForFlagCategory("glossary term")).toBe(
      feedbackTypeValues.glossaryCanonIssue,
    );
    expect(feedbackTypeForFlagCategory("layout overflow")).toBe(feedbackTypeValues.assetIssue);
    expect(feedbackTypeForFlagCategory("runtime crash")).toBe(feedbackTypeValues.runtimeIssue);
    expect(feedbackTypeForFlagCategory(undefined)).toBe(feedbackTypeValues.objectiveDefect);
  });

  it("builds a ManualFeedbackImportInput carrying severity + playtest origin", () => {
    const input = buildPlayFlagFeedbackInput({
      projectId: "project-1",
      localeBranchId: "locale-1",
      targetLocale: "en-US",
      note: "  Line overflows.  ",
      severity: "blocker",
      category: "layout",
      bridgeUnitId: "bridge-unit-1",
      sourceUnitKey: "unit.key",
      sceneId: "scene-a",
      actorUserId: "playtester-1",
      actorDisplayName: "Aoi",
    });

    expect(input.projectId).toBe("project-1");
    expect(input.localeBranchId).toBe("locale-1");
    expect(input.targetLocale).toBe("en-US");
    expect(input.reporterNote).toBe("Line overflows.");
    expect(input.feedbackType).toBe(feedbackTypeValues.assetIssue);
    expect(input.reporter).toEqual({
      role: "playtester",
      reporterId: "playtester-1",
      displayName: "Aoi",
    });
    expect(input.feedbackSource?.sourceKind).toBe(feedbackSourceKindValues.manualPlaytest);
    expect(input.lineReference).toEqual({
      bridgeUnitId: "bridge-unit-1",
      sourceUnitKey: "unit.key",
      sourceLocation: { sceneId: "scene-a" },
    });
    expect(input.metadata).toMatchObject({
      origin: "playtest",
      severity: "blocker",
      category: "layout",
      sceneId: "scene-a",
      source: "play-flag-composer",
    });
  });

  it("refuses an empty note", () => {
    expect(() =>
      buildPlayFlagFeedbackInput({
        projectId: "p",
        localeBranchId: "l",
        targetLocale: "en-US",
        note: "   ",
        severity: "note",
        actorUserId: "u",
      }),
    ).toThrow(/non-empty/);
  });
});
