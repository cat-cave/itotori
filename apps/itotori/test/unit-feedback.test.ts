// Unit-bound feedback: submit against a real unit identity, retrieve against
// the same identity. Extends the play-flag mapping path (buildPlayFlagFeedbackInput)
// rather than inventing a parallel store.
//
// Gut-check: if listFeedbackForUnit stops filtering by bridgeUnitId (or the
// memory port keys by project only), the retrieval assertion fails.

import { describe, expect, it } from "vitest";
import {
  createMemoryUnitFeedbackPort,
  listFeedbackForUnit,
  submitUnitBoundFlag,
} from "../src/play/unit-feedback.js";

describe("unit-bound feedback — submit + retrieve by unit identity", () => {
  it("persists a flag against a unit and retrieves it against that same unit", async () => {
    const port = createMemoryUnitFeedbackPort({
      now: () => "2026-07-26T12:00:00.000Z",
    });

    const submitted = await submitUnitBoundFlag(port, {
      projectId: "project-1",
      localeBranchId: "locale-1",
      note: "This line attributes the wrong speaker.",
      severity: "warning",
      category: "context",
      bridgeUnitId: "unit-line-42",
      sceneId: "scene:0001",
      actorUserId: "reviewer-1",
      actorDisplayName: "Aoi",
    });

    expect(submitted.feedbackReportId).toMatch(/^feedback-report-/);
    expect(submitted.contextCorrection.correctionId).toContain(submitted.feedbackReportId);

    const notes = await listFeedbackForUnit(port, {
      projectId: "project-1",
      localeBranchId: "locale-1",
      bridgeUnitId: "unit-line-42",
    });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      bridgeUnitId: "unit-line-42",
      sceneId: "scene:0001",
      note: "This line attributes the wrong speaker.",
      severity: "warning",
      category: "context",
      feedbackReportId: submitted.feedbackReportId,
    });

    // A different unit must not see the note.
    const other = await listFeedbackForUnit(port, {
      projectId: "project-1",
      localeBranchId: "locale-1",
      bridgeUnitId: "unit-line-99",
    });
    expect(other).toEqual([]);
  });

  it("accumulates multiple notes for the same unit in arrival order", async () => {
    let tick = 0;
    const port = createMemoryUnitFeedbackPort({
      now: () => `2026-07-26T12:00:0${tick++}.000Z`,
    });

    await submitUnitBoundFlag(port, {
      projectId: "p",
      localeBranchId: "l",
      bridgeUnitId: "u1",
      note: "first note",
      severity: "note",
      actorUserId: "r",
    });
    await submitUnitBoundFlag(port, {
      projectId: "p",
      localeBranchId: "l",
      bridgeUnitId: "u1",
      note: "second note",
      severity: "critical",
      actorUserId: "r",
    });

    const notes = await listFeedbackForUnit(port, {
      projectId: "p",
      localeBranchId: "l",
      bridgeUnitId: "u1",
    });
    expect(notes.map((n) => n.note)).toEqual(["first note", "second note"]);
  });
});
