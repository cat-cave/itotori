// ITOTORI-084 — reviewer-triggered rerun fixtures.

import {
  reviewerQueueActionValues,
  reviewerQueueItemKindValues,
  reviewerQueueItemStateValues,
  type ReviewerQueueActionResult,
  type ReviewerQueueItemRecord,
  type ReviewerQueueTransitionRecord,
} from "@itotori/db";

export const itotori084FixtureProjectId = "project-itotori-084";
export const itotori084FixtureLocaleBranchId = "locale-branch-itotori-084";
export const itotori084FixtureSourceRevisionId = "source-revision-itotori-084";
export const itotori084FixturePolicyVersions = {
  styleGuideVersionId: "style-guide-version-itotori-084",
  glossaryVersionId: "glossary-version-itotori-084",
  pairPolicyVersionId: "pair-policy-v0.3",
  qaPolicyVersionId: "qa-policy-itotori-084",
  exportPolicyVersionId: "export-policy-itotori-084",
  runtimeValidationPolicyVersionId: "runtime-policy-itotori-084",
} as const;

const fixtureDate = new Date("2026-06-26T12:00:00Z");

function itemFixture(overrides: Partial<ReviewerQueueItemRecord> = {}): ReviewerQueueItemRecord {
  const itemKind = overrides.itemKind ?? reviewerQueueItemKindValues.qa;
  const isRuntime = itemKind === reviewerQueueItemKindValues.runtimeEvidence;
  return {
    reviewItemId: "reviewer-queue-084-1",
    projectId: itotori084FixtureProjectId,
    localeBranchId: itotori084FixtureLocaleBranchId,
    sourceRevisionId: itotori084FixtureSourceRevisionId,
    itemKind,
    sourceItemRef: "bridge-unit-itotori-084-a",
    state: reviewerQueueItemStateValues.repairRequested,
    priority: 0,
    summary: "ITOTORI-084 rerun fixture",
    affectedArtifactIds: ["artifact-itotori-084-draft"],
    evidenceTier: isRuntime ? "tier-2-trace" : null,
    observationEventIds: isRuntime ? ["runtime-observation-itotori-084"] : null,
    artifactHashes: isRuntime ? ["sha256:runtime-itotori-084"] : null,
    payload: {
      affectedUnitIds: ["bridge-unit-itotori-084-a"],
      policyVersions: itotori084FixturePolicyVersions,
    },
    metadata: {},
    createdByUserId: null,
    assignedToUserId: null,
    createdAt: fixtureDate,
    updatedAt: fixtureDate,
    resolvedAt: fixtureDate,
    ...overrides,
  };
}

function transitionFixture(
  overrides: Partial<ReviewerQueueTransitionRecord> = {},
): ReviewerQueueTransitionRecord {
  return {
    transitionId: "reviewer-transition-itotori-084-1",
    reviewItemId: "reviewer-queue-084-1",
    localeBranchId: itotori084FixtureLocaleBranchId,
    sourceRevisionId: itotori084FixtureSourceRevisionId,
    itemKind: reviewerQueueItemKindValues.qa,
    action: reviewerQueueActionValues.requestRepair,
    priorState: reviewerQueueItemStateValues.pending,
    nextState: reviewerQueueItemStateValues.repairRequested,
    actorUserId: "local-user",
    affectedArtifactIds: ["artifact-itotori-084-export"],
    diagnostics: [],
    metadata: {
      affectedUnitIds: ["bridge-unit-itotori-084-a"],
      policyVersions: itotori084FixturePolicyVersions,
      repairHint: "Repair the glossary-sensitive line only.",
    },
    createdAt: fixtureDate,
    ...overrides,
  };
}

export function fixtureSingleItemRepairRerun(): ReviewerQueueActionResult {
  return {
    item: itemFixture(),
    transition: transitionFixture(),
  };
}

export function fixtureBatchRepairRerun(): ReviewerQueueActionResult[] {
  return [
    fixtureSingleItemRepairRerun(),
    {
      item: itemFixture({
        reviewItemId: "reviewer-queue-084-2",
        sourceItemRef: "bridge-unit-itotori-084-b",
        affectedArtifactIds: ["artifact-itotori-084-draft-b"],
        payload: {
          affectedUnitIds: ["bridge-unit-itotori-084-b"],
          policyVersions: itotori084FixturePolicyVersions,
        },
      }),
      transition: transitionFixture({
        transitionId: "reviewer-transition-itotori-084-2",
        reviewItemId: "reviewer-queue-084-2",
        affectedArtifactIds: ["artifact-itotori-084-export-b"],
        metadata: {
          affectedUnitIds: ["bridge-unit-itotori-084-b"],
          policyVersions: itotori084FixturePolicyVersions,
          repairHint: "Repair the second rejected line only.",
        },
      }),
    },
  ];
}

export function fixturePolicyInvalidationRerun(): ReviewerQueueActionResult {
  return {
    item: itemFixture({
      reviewItemId: "reviewer-queue-084-style",
      itemKind: reviewerQueueItemKindValues.style,
      sourceItemRef: "bridge-unit-itotori-084-style",
      state: reviewerQueueItemStateValues.accepted,
    }),
    transition: transitionFixture({
      transitionId: "reviewer-transition-itotori-084-style",
      reviewItemId: "reviewer-queue-084-style",
      itemKind: reviewerQueueItemKindValues.style,
      action: reviewerQueueActionValues.updateStyle,
      nextState: reviewerQueueItemStateValues.accepted,
      metadata: {
        affectedUnitIds: ["bridge-unit-itotori-084-style"],
        policyVersions: itotori084FixturePolicyVersions,
        styleGuideVersionId: itotori084FixturePolicyVersions.styleGuideVersionId,
        glossaryVersionId: itotori084FixturePolicyVersions.glossaryVersionId,
        ruleLabel: "Honorifics: retain -san in voiced lines",
      },
    }),
  };
}

export function fixtureRuntimeFeedbackRerun(): ReviewerQueueActionResult {
  return {
    item: itemFixture({
      reviewItemId: "reviewer-queue-084-runtime",
      itemKind: reviewerQueueItemKindValues.runtimeEvidence,
      sourceItemRef: "bridge-unit-itotori-084-runtime",
      state: reviewerQueueItemStateValues.accepted,
      affectedArtifactIds: ["artifact-itotori-084-runtime"],
    }),
    transition: transitionFixture({
      transitionId: "reviewer-transition-itotori-084-runtime",
      reviewItemId: "reviewer-queue-084-runtime",
      itemKind: reviewerQueueItemKindValues.runtimeEvidence,
      action: reviewerQueueActionValues.importRuntimeFeedback,
      nextState: reviewerQueueItemStateValues.accepted,
      affectedArtifactIds: ["artifact-itotori-084-runtime-export"],
      metadata: {
        affectedUnitIds: ["bridge-unit-itotori-084-runtime"],
        policyVersions: itotori084FixturePolicyVersions,
        evidenceTier: "tier-2-trace",
        observationEventIds: ["runtime-observation-itotori-084"],
        artifactHashes: ["sha256:runtime-itotori-084"],
      },
    }),
  };
}
