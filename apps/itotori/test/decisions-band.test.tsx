import { describe, expect, it } from "vitest";
import type { DashboardPendingDecision } from "@itotori/db";
import { findingFollowupPath } from "../src/ui/screens/DecisionsBand.js";

function finding(overrides: Partial<DashboardPendingDecision>): DashboardPendingDecision {
  return {
    decisionId: "decision-1",
    decisionKind: "project_finding",
    projectId: "project-1",
    findingId: "finding-1",
    findingKind: "qa_finding",
    severity: "medium",
    qualityCategory: null,
    title: "Canonical wording is unclear",
    localeBranchId: null,
    targetLocale: null,
    branchStatus: null,
    runtimeRunId: null,
    runtimeStatus: null,
    createdAt: "2026-07-13T00:00:00.000Z",
    ...overrides,
  };
}

describe("findingFollowupPath", () => {
  it("routes an unscoped finding to Wiki instead of a targetless flag composer", () => {
    expect(findingFollowupPath(finding({}))).toBe("/wiki");
  });

  it("routes a branch-scoped finding to Wiki after patch iteration retirement", () => {
    expect(
      findingFollowupPath(
        finding({
          decisionKind: "locale_branch_finding",
          localeBranchId: "branch-fr-fr",
          targetLocale: "fr-FR",
        }),
      ),
    ).toBe("/wiki");
  });
});
