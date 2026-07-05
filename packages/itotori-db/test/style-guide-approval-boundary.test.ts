import { describe, expect, it } from "vitest";
import {
  assertStyleGuideApprovalBoundary,
  assertStyleGuideVersionChangedPayload,
  buildStyleGuideApprovalEventPayload,
  buildStyleGuideVersionCreatedPayload,
  styleGuideVersionChangedPayloadSchemaVersion,
  type SourceRevisionReference,
  type StyleGuideVersionApprovedPayload,
  type StyleGuideVersionRecord,
} from "../src/repositories/style-guide-repository.js";
import { styleGuideVersionStatusValues } from "../src/schema.js";

/**
 * DB-less contract tests for ITOTORI-129: the PRIMARY style-guide approval event
 * payload must carry the complete approval boundary (approver id, locale branch
 * id, prior version id, approved version id, source-revision boundary) even when
 * there is no affected-work fanout.
 */

const priorSourceRevision: SourceRevisionReference = {
  sourceRevisionId: "source-revision:prior",
  revisionKind: "commit",
  value: "prior-value",
};

const approvedSourceRevision: SourceRevisionReference = {
  sourceRevisionId: "source-revision:approved",
  revisionKind: "commit",
  value: "approved-value",
};

function versionRecord(
  overrides: Partial<StyleGuideVersionRecord> & {
    styleGuideVersionId: string;
    sourceRevisionReference: SourceRevisionReference;
  },
): StyleGuideVersionRecord {
  return {
    styleGuideId: "style-guide:branch-129",
    projectId: "project-129",
    localeBranchId: "branch-129",
    previousVersionId: null,
    versionSequence: 1,
    authorUserId: "author-129",
    approverUserId: null,
    status: styleGuideVersionStatusValues.approved,
    contentHash: "sha256:fixture",
    policy: {},
    semanticDiagnostics: [],
    approvedAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

const approvedVersion = versionRecord({
  styleGuideVersionId: "style-guide-version:approved",
  sourceRevisionReference: approvedSourceRevision,
});

const priorVersion = versionRecord({
  styleGuideVersionId: "style-guide-version:prior",
  sourceRevisionReference: priorSourceRevision,
});

describe("style guide approval event boundary contract", () => {
  it("carries the full boundary for a first approval with no prior version and no fanout", () => {
    const payload = buildStyleGuideApprovalEventPayload({
      projectId: "project-129",
      localeBranchId: "branch-129",
      approverUserId: "approver-129",
      priorVersion: null,
      approvedVersion,
    });

    // No fanout is possible here (there is no prior approved version), yet the
    // primary approval event must still be audit-complete on its own.
    expect(() => assertStyleGuideVersionChangedPayload(payload)).not.toThrow();
    expect(payload.changeKind).toBe("version_approved");
    expect(payload.approvalBoundary).toEqual({
      approverUserId: "approver-129",
      localeBranchId: "branch-129",
      priorVersionId: null,
      approvedVersionId: "style-guide-version:approved",
      sourceRevisionBoundary: {
        prior: null,
        approved: approvedSourceRevision,
      },
    });
  });

  it("carries the full prior->approved boundary when a prior version exists but no work is affected", () => {
    const payload = buildStyleGuideApprovalEventPayload({
      projectId: "project-129",
      localeBranchId: "branch-129",
      approverUserId: "approver-129",
      priorVersion,
      approvedVersion,
    });

    expect(() => assertStyleGuideVersionChangedPayload(payload)).not.toThrow();
    expect(payload.approvalBoundary).toEqual({
      approverUserId: "approver-129",
      localeBranchId: "branch-129",
      priorVersionId: "style-guide-version:prior",
      approvedVersionId: "style-guide-version:approved",
      sourceRevisionBoundary: {
        prior: priorSourceRevision,
        approved: approvedSourceRevision,
      },
    });
  });

  it("exposes all five boundary fields at the top level of the approval event", () => {
    const payload = buildStyleGuideApprovalEventPayload({
      projectId: "project-129",
      localeBranchId: "branch-129",
      approverUserId: "approver-129",
      priorVersion,
      approvedVersion,
    });

    // approver id, locale branch id, prior version id, approved version id,
    // source-revision boundary.
    expect(payload.approvalBoundary.approverUserId).toBe("approver-129");
    expect(payload.approvalBoundary.localeBranchId).toBe("branch-129");
    expect(payload.approvalBoundary.priorVersionId).toBe("style-guide-version:prior");
    expect(payload.approvalBoundary.approvedVersionId).toBe("style-guide-version:approved");
    expect(payload.approvalBoundary.sourceRevisionBoundary.prior).toEqual(priorSourceRevision);
    expect(payload.approvalBoundary.sourceRevisionBoundary.approved).toEqual(
      approvedSourceRevision,
    );
  });

  it("rejects an approval payload that is missing any boundary field", () => {
    const complete: StyleGuideVersionApprovedPayload = buildStyleGuideApprovalEventPayload({
      projectId: "project-129",
      localeBranchId: "branch-129",
      approverUserId: "approver-129",
      priorVersion,
      approvedVersion,
    });

    const withoutBoundaryField = (
      mutate: (boundary: Record<string, unknown>) => void,
    ): Record<string, unknown> => {
      const clone = structuredClone(complete) as unknown as Record<string, unknown>;
      mutate(clone.approvalBoundary as Record<string, unknown>);
      return clone;
    };

    expect(() =>
      assertStyleGuideVersionChangedPayload(
        withoutBoundaryField((boundary) => delete boundary.approverUserId),
      ),
    ).toThrow(/approverUserId/);
    expect(() =>
      assertStyleGuideVersionChangedPayload(
        withoutBoundaryField((boundary) => delete boundary.localeBranchId),
      ),
    ).toThrow(/localeBranchId/);
    expect(() =>
      assertStyleGuideVersionChangedPayload(
        withoutBoundaryField((boundary) => delete boundary.priorVersionId),
      ),
    ).toThrow(/priorVersionId/);
    expect(() =>
      assertStyleGuideVersionChangedPayload(
        withoutBoundaryField((boundary) => delete boundary.approvedVersionId),
      ),
    ).toThrow(/approvedVersionId/);
    expect(() =>
      assertStyleGuideVersionChangedPayload(
        withoutBoundaryField((boundary) => delete boundary.sourceRevisionBoundary),
      ),
    ).toThrow(/sourceRevisionBoundary/);
    expect(() =>
      assertStyleGuideVersionChangedPayload(
        withoutBoundaryField((boundary) => {
          (boundary.sourceRevisionBoundary as Record<string, unknown>).approved = undefined;
        }),
      ),
    ).toThrow(/sourceRevisionBoundary\.approved/);
  });

  it("rejects an approval event that carries no approvalBoundary at all", () => {
    const withoutBoundary = {
      schemaVersion: styleGuideVersionChangedPayloadSchemaVersion,
      eventName: "StyleGuideVersionChanged",
      changeKind: "version_approved",
      projectId: "project-129",
      localeBranchId: "branch-129",
      previousVersionId: null,
      newVersionId: "style-guide-version:approved",
      sourceRevisionReference: approvedSourceRevision,
    };

    expect(() => assertStyleGuideVersionChangedPayload(withoutBoundary)).toThrow(
      /approvalBoundary/,
    );
    expect(() => assertStyleGuideApprovalBoundary(undefined)).toThrow(/approvalBoundary/);
  });

  it("accepts a version_created event without an approval boundary", () => {
    const payload = buildStyleGuideVersionCreatedPayload({
      projectId: "project-129",
      localeBranchId: "branch-129",
      previousVersionId: null,
      version: approvedVersion,
    });

    expect(() => assertStyleGuideVersionChangedPayload(payload)).not.toThrow();
    expect(payload.changeKind).toBe("version_created");
    expect(payload).not.toHaveProperty("approvalBoundary");
  });
});
