// @vitest-environment jsdom
// ITOTORI-082 — reviewer detail route loader tests.
//
// Exercises the loader's permission gate, missing-item path, stale
// source revision path, and per-kind diagnostic emission. The loader
// receives a pre-resolved permission view (resolved by the SPA
// bootstrap / JSON API layer via `auth.ts`) and an evidence loader
// port. Tests stub both with hand-rolled fakes so the behavior is
// observable without standing up Postgres.

import { describe, expect, it, vi } from "vitest";
import {
  AuthorizationError,
  permissionValues,
  reviewerQueueActionValues,
  reviewerQueueItemKindValues,
  reviewerQueueItemStateValues,
  type ReviewerQueueItemRecord,
  type ReviewerQueueTransitionRecord,
} from "@itotori/db";
import { resolveReviewerQueuePermissionView, type ItotoriAuthorizationPort } from "../src/auth.js";
import { assertItotoriApiResponse } from "../src/api-schema.js";
import {
  branchReferenceFixture,
  draftFixture,
  glossaryFixture,
  loadReviewerDetailContext,
  policyFixture,
  qaFindingFixture,
  rationaleFixture,
  repositoryTransitionFixture,
  reviewerDetailDiagnosticCodeValues,
  runtimeEvidenceItemFixture,
  runtimeTextTraceFixture,
  sourceUnitFixture,
  structureContextFeedFixture,
  type ReviewerDetailEvidenceLoaderPort,
  type ReviewerDetailEvidencePayload,
  type ReviewerDetailPermissionView,
} from "../src/reviewer/index.js";

type StubLoaderHandle = {
  loader: ReviewerDetailEvidenceLoaderPort;
  loadItem: ReturnType<typeof vi.fn>;
  loadTransitions: ReturnType<typeof vi.fn>;
  loadDetailEvidence: ReturnType<typeof vi.fn>;
};

function stubLoader(opts: {
  item?: ReviewerQueueItemRecord | null;
  transitions?: ReviewerQueueTransitionRecord[];
  payload?: Partial<ReviewerDetailEvidencePayload>;
}): StubLoaderHandle {
  const loadItem = vi.fn(async (_id: string) => opts.item ?? null);
  const loadTransitions = vi.fn(async (_id: string) => opts.transitions ?? []);
  const loadDetailEvidence = vi.fn(async (item: ReviewerQueueItemRecord) => {
    const payload: ReviewerDetailEvidencePayload = {
      loadedSourceRevisionId: opts.payload?.loadedSourceRevisionId ?? item.sourceRevisionId,
      source: opts.payload?.source ?? null,
      draft: opts.payload?.draft ?? null,
      policy: opts.payload?.policy ?? null,
      glossary: opts.payload?.glossary ?? [],
      branchReference: opts.payload?.branchReference ?? null,
      qaFindings: opts.payload?.qaFindings ?? [],
      runtimeEvidence: opts.payload?.runtimeEvidence ?? [],
      rationaleRefs: opts.payload?.rationaleRefs ?? [],
      structureContextFeed:
        opts.payload?.structureContextFeed !== undefined ? opts.payload.structureContextFeed : null,
      diagnostics: opts.payload?.diagnostics ?? [],
    };
    return payload;
  });
  return {
    loader: { loadItem, loadTransitions, loadDetailEvidence },
    loadItem,
    loadTransitions,
    loadDetailEvidence,
  };
}

function permissionView(
  overrides: Partial<ReviewerDetailPermissionView> = {},
): ReviewerDetailPermissionView {
  return {
    actorUserId: "local-user",
    canReadQueue: true,
    canManageQueue: true,
    denialReasons: [],
    ...overrides,
  };
}

describe("loadReviewerDetailContext — permission gate", () => {
  it("returns a denied context and skips the evidence loader entirely when queue.read is missing", async () => {
    const stub = stubLoader({ item: runtimeEvidenceItemFixture() });
    const context = await loadReviewerDetailContext(
      { reviewItemId: "reviewer-queue-1" },
      {
        permission: permissionView({
          actorUserId: "anon",
          canReadQueue: false,
          canManageQueue: false,
          denialReasons: ["user anon is missing permission queue.read"],
        }),
        evidenceLoader: stub.loader,
      },
    );

    expect(context.permission.canReadQueue).toBe(false);
    expect(context.permission.canManageQueue).toBe(false);
    expect(context.permission.denialReasons[0]).toContain("queue.read");
    expect(context.item).toBeNull();
    expect(context.source).toBeNull();
    expect(context.runtimeEvidence).toEqual([]);
    expect(context.diagnostics[0]?.code).toBe(reviewerDetailDiagnosticCodeValues.permissionDenied);

    // Audit guard: the evidence loader must never be consulted when the
    // permission view refuses queue.read.
    expect(stub.loadItem).not.toHaveBeenCalled();
    expect(stub.loadTransitions).not.toHaveBeenCalled();
    expect(stub.loadDetailEvidence).not.toHaveBeenCalled();
  });

  it("synthesizes a default denial reason when the view does not carry one", async () => {
    const stub = stubLoader({ item: runtimeEvidenceItemFixture() });
    const context = await loadReviewerDetailContext(
      { reviewItemId: "reviewer-queue-1" },
      {
        permission: permissionView({
          actorUserId: "anon",
          canReadQueue: false,
          canManageQueue: false,
          denialReasons: [],
        }),
        evidenceLoader: stub.loader,
      },
    );

    expect(context.diagnostics[0]?.message).toContain("queue.read");
  });

  it("loads evidence but disables manage actions when queue.read is granted and queue.manage is not", async () => {
    const item = runtimeEvidenceItemFixture();
    const stub = stubLoader({
      item,
      payload: {
        loadedSourceRevisionId: item.sourceRevisionId,
        source: sourceUnitFixture(),
        draft: draftFixture(),
        policy: policyFixture(),
        runtimeEvidence: [runtimeTextTraceFixture()],
        rationaleRefs: [rationaleFixture()],
      },
    });
    const context = await loadReviewerDetailContext(
      { reviewItemId: item.reviewItemId },
      {
        permission: permissionView({ canManageQueue: false }),
        evidenceLoader: stub.loader,
      },
    );

    expect(context.permission.canReadQueue).toBe(true);
    expect(context.permission.canManageQueue).toBe(false);
    expect(context.runtimeEvidence.length).toBe(1);
    expect(stub.loadItem).toHaveBeenCalledWith(item.reviewItemId);
    expect(stub.loadDetailEvidence).toHaveBeenCalledTimes(1);
  });
});

describe("loadReviewerDetailContext — missing item", () => {
  it("returns a stale-source diagnostic when the item is not found", async () => {
    const stub = stubLoader({ item: null });
    const context = await loadReviewerDetailContext(
      { reviewItemId: "reviewer-queue-missing" },
      {
        permission: permissionView(),
        evidenceLoader: stub.loader,
      },
    );

    expect(context.item).toBeNull();
    expect(context.diagnostics[0]?.code).toBe(
      reviewerDetailDiagnosticCodeValues.staleSourceRevision,
    );
    expect(stub.loadDetailEvidence).not.toHaveBeenCalled();
  });
});

describe("loadReviewerDetailContext — stale source revision", () => {
  it("blanks out the draft and policy and surfaces a stale_source_revision diagnostic", async () => {
    const item = runtimeEvidenceItemFixture({
      sourceRevisionId: "source-revision-itotori-082-newer",
    });
    const stub = stubLoader({
      item,
      payload: {
        loadedSourceRevisionId: "source-revision-itotori-082-older",
        source: sourceUnitFixture({ sourceRevisionId: "source-revision-itotori-082-older" }),
        draft: draftFixture(),
        policy: policyFixture(),
        runtimeEvidence: [runtimeTextTraceFixture()],
        rationaleRefs: [rationaleFixture()],
      },
    });
    const context = await loadReviewerDetailContext(
      { reviewItemId: item.reviewItemId },
      {
        permission: permissionView(),
        evidenceLoader: stub.loader,
      },
    );

    expect(context.draft).toBeNull();
    expect(context.policy).toBeNull();
    expect(context.source).not.toBeNull();
    expect(
      context.diagnostics.some(
        (d) => d.code === reviewerDetailDiagnosticCodeValues.staleSourceRevision,
      ),
    ).toBe(true);
  });
});

describe("loadReviewerDetailContext — missing context emits diagnostics, not silent empty panels", () => {
  it("emits missing_glossary_ref when a glossary item resolves zero terms", async () => {
    const item: ReviewerQueueItemRecord = {
      ...runtimeEvidenceItemFixture(),
      itemKind: reviewerQueueItemKindValues.glossary,
      evidenceTier: null,
      observationEventIds: null,
      artifactHashes: null,
    };
    const stub = stubLoader({
      item,
      payload: {
        loadedSourceRevisionId: item.sourceRevisionId,
        source: sourceUnitFixture(),
        draft: draftFixture(),
        policy: policyFixture(),
        rationaleRefs: [rationaleFixture()],
      },
    });
    const context = await loadReviewerDetailContext(
      { reviewItemId: item.reviewItemId },
      {
        permission: permissionView(),
        evidenceLoader: stub.loader,
      },
    );

    const codes = context.diagnostics.map((d) => d.code);
    expect(codes).toContain(reviewerDetailDiagnosticCodeValues.missingGlossaryRef);
  });

  it("emits missing_runtime_evidence when a runtime_evidence item resolves zero rows", async () => {
    const item = runtimeEvidenceItemFixture();
    const stub = stubLoader({
      item,
      payload: {
        loadedSourceRevisionId: item.sourceRevisionId,
        source: sourceUnitFixture(),
        draft: draftFixture(),
        policy: policyFixture(),
        glossary: [glossaryFixture()],
        qaFindings: [qaFindingFixture()],
        runtimeEvidence: [],
        rationaleRefs: [rationaleFixture()],
      },
    });
    const context = await loadReviewerDetailContext(
      { reviewItemId: item.reviewItemId },
      {
        permission: permissionView(),
        evidenceLoader: stub.loader,
      },
    );

    expect(context.diagnostics.map((d) => d.code)).toContain(
      reviewerDetailDiagnosticCodeValues.missingRuntimeEvidence,
    );
  });

  it("emits missing_rationale when no rationale refs were resolved", async () => {
    const item = runtimeEvidenceItemFixture();
    const stub = stubLoader({
      item,
      payload: {
        loadedSourceRevisionId: item.sourceRevisionId,
        source: sourceUnitFixture(),
        draft: draftFixture(),
        policy: policyFixture(),
        runtimeEvidence: [runtimeTextTraceFixture()],
        rationaleRefs: [],
      },
    });
    const context = await loadReviewerDetailContext(
      { reviewItemId: item.reviewItemId },
      {
        permission: permissionView(),
        evidenceLoader: stub.loader,
      },
    );
    expect(context.diagnostics.map((d) => d.code)).toContain(
      reviewerDetailDiagnosticCodeValues.missingRationale,
    );
  });

  // wiki-structure-context-feed — a draft without a structure feed is a
  // provenance gap: the reviewer cannot see WHY the draft chose its wording.
  it("emits missing_structure_context_feed when a draft has no structure feed", async () => {
    const item = runtimeEvidenceItemFixture();
    const stub = stubLoader({
      item,
      payload: {
        loadedSourceRevisionId: item.sourceRevisionId,
        source: sourceUnitFixture(),
        draft: draftFixture(),
        policy: policyFixture(),
        rationaleRefs: [rationaleFixture()],
        structureContextFeed: null,
      },
    });
    const context = await loadReviewerDetailContext(
      { reviewItemId: item.reviewItemId },
      {
        permission: permissionView(),
        evidenceLoader: stub.loader,
      },
    );
    expect(context.structureContextFeed).toBeNull();
    expect(context.diagnostics.map((d) => d.code)).toContain(
      reviewerDetailDiagnosticCodeValues.missingStructureContextFeed,
    );
  });

  it("surfaces the structure context feed that fed the draft wording", async () => {
    const item = runtimeEvidenceItemFixture();
    const feed = structureContextFeedFixture({
      sceneId: 6010,
      fedTheDraft: true,
    });
    const stub = stubLoader({
      item,
      payload: {
        loadedSourceRevisionId: item.sourceRevisionId,
        source: sourceUnitFixture(),
        draft: draftFixture(),
        policy: policyFixture(),
        rationaleRefs: [rationaleFixture()],
        structureContextFeed: feed,
      },
    });
    const context = await loadReviewerDetailContext(
      { reviewItemId: item.reviewItemId },
      {
        permission: permissionView(),
        evidenceLoader: stub.loader,
      },
    );
    expect(context.structureContextFeed).not.toBeNull();
    expect(context.structureContextFeed?.fedTheDraft).toBe(true);
    expect(context.structureContextFeed?.sceneId).toBe(6010);
    expect(context.structureContextFeed?.items.some((i) => i.kind === "scene_summary")).toBe(true);
    expect(context.diagnostics.map((d) => d.code)).not.toContain(
      reviewerDetailDiagnosticCodeValues.missingStructureContextFeed,
    );

    // Round-trip through the strict API response assert so the schema
    // accepts the new structureContextFeed field.
    expect(() => assertItotoriApiResponse("reviewer.detail", context)).not.toThrow();
  });

  it("hydrates the structure context feed from the agentic-loop decision record payload", async () => {
    const item: ReviewerQueueItemRecord = {
      ...runtimeEvidenceItemFixture(),
      payload: {
        source: "agentic_loop",
        decisionRecord: {
          schemaVersion: "itotori.agentic-loop-decision-record.v1",
          context: {
            contextArtifactIds: ["scene-summary:6010", "character-arc:Hero", "route-branch-map"],
            sceneId: 6010,
            structuredContext: {
              sceneId: 6010,
              sceneSummaryText: "Scene 6010: Hero greets Princess.",
              routePositionText: "Scene 6010 route position: entry scene.",
              characterArcsText: "Speaker arcs in this scene:\n- Hero: appears in scene 6010.",
              artifactRefs: ["scene-summary:6010", "route-branch-map", "character-arc:Hero"],
            },
          },
        },
      },
    };
    // Loader returns no structureContextFeed — the route falls back to the
    // decision-record payload on the item.
    const stub = stubLoader({
      item,
      payload: {
        loadedSourceRevisionId: item.sourceRevisionId,
        source: sourceUnitFixture(),
        draft: draftFixture(),
        policy: policyFixture(),
        rationaleRefs: [rationaleFixture()],
        structureContextFeed: null,
      },
    });
    const context = await loadReviewerDetailContext(
      { reviewItemId: item.reviewItemId },
      {
        permission: permissionView(),
        evidenceLoader: stub.loader,
      },
    );
    expect(context.structureContextFeed).not.toBeNull();
    expect(context.structureContextFeed?.fedTheDraft).toBe(true);
    expect(context.structureContextFeed?.items[0]?.body).toContain("Hero greets Princess");
    expect(context.diagnostics.map((d) => d.code)).not.toContain(
      reviewerDetailDiagnosticCodeValues.missingStructureContextFeed,
    );
  });

  it("emits stale_source + missing_draft + missing_policy when the source is missing", async () => {
    const item = runtimeEvidenceItemFixture();
    const stub = stubLoader({
      item,
      payload: {
        loadedSourceRevisionId: item.sourceRevisionId,
        source: null,
        draft: null,
        policy: null,
        rationaleRefs: [rationaleFixture()],
        runtimeEvidence: [runtimeTextTraceFixture()],
      },
    });
    const context = await loadReviewerDetailContext(
      { reviewItemId: item.reviewItemId },
      {
        permission: permissionView(),
        evidenceLoader: stub.loader,
      },
    );
    const codes = context.diagnostics.map((d) => d.code);
    expect(codes).toContain(reviewerDetailDiagnosticCodeValues.staleSourceRevision);
    expect(codes).toContain(reviewerDetailDiagnosticCodeValues.missingDraft);
    expect(codes).toContain(reviewerDetailDiagnosticCodeValues.missingPolicy);
  });
});

describe("loadReviewerDetailContext — transition history", () => {
  it("maps the transition rows into the detail context view", async () => {
    const item = runtimeEvidenceItemFixture();
    const stub = stubLoader({
      item,
      transitions: [
        repositoryTransitionFixture({
          action: reviewerQueueActionValues.approve,
          priorState: reviewerQueueItemStateValues.pending,
          nextState: reviewerQueueItemStateValues.accepted,
        }),
      ],
      payload: {
        loadedSourceRevisionId: item.sourceRevisionId,
        source: sourceUnitFixture(),
        draft: draftFixture(),
        policy: policyFixture(),
        rationaleRefs: [rationaleFixture()],
        runtimeEvidence: [runtimeTextTraceFixture()],
      },
    });
    const context = await loadReviewerDetailContext(
      { reviewItemId: item.reviewItemId },
      {
        permission: permissionView(),
        evidenceLoader: stub.loader,
      },
    );

    expect(context.transitions.length).toBe(1);
    const first = context.transitions[0]!;
    expect(first.action).toBe(reviewerQueueActionValues.approve);
    expect(first.nextState).toBe(reviewerQueueItemStateValues.accepted);
  });
});

describe("loadReviewerDetailContext — branch policy/glossary reference provenance (ITOTORI-139)", () => {
  it("carries the exact branch policy + glossary reference bound to the draft, observable by a non-DB consumer", async () => {
    const item = runtimeEvidenceItemFixture();
    const draft = draftFixture({ draftId: "draft-under-review-139" });
    // The exact reference the DB attached to this draft. A non-DB
    // consumer must be able to read + verify THIS reference — not merely
    // observe that "some" reference exists.
    const expectedReference = branchReferenceFixture({
      referenceId: "branch-ref-139",
      draftId: draft.draftId,
      versionSequence: 7,
      branchPolicyRef: "style-guide-version-139",
      glossaryRef: "sha256:glossary-content-hash-139",
      supersedesReferenceId: "branch-ref-139-prior",
      updateReason: "policy_approved",
    });
    const stub = stubLoader({
      item,
      payload: {
        loadedSourceRevisionId: item.sourceRevisionId,
        source: sourceUnitFixture(),
        draft,
        policy: policyFixture(),
        branchReference: expectedReference,
        rationaleRefs: [rationaleFixture()],
        runtimeEvidence: [runtimeTextTraceFixture()],
      },
    });

    const context = await loadReviewerDetailContext(
      { reviewItemId: item.reviewItemId },
      { permission: permissionView(), evidenceLoader: stub.loader },
    );

    // The review context is app-layer state (apps/itotori) — no DB
    // handle is involved in this test. A consumer OUTSIDE
    // packages/itotori-db observes the reference here.
    expect(context.branchReference).not.toBeNull();
    expect(context.branchReference).toEqual(expectedReference);

    // The binding is EXACT: the reference is bound to the draft under
    // review, and the branch POLICY + GLOSSARY refs match verbatim.
    expect(context.branchReference?.draftId).toBe(context.draft?.draftId);
    expect(context.branchReference?.branchPolicyRef).toBe("style-guide-version-139");
    expect(context.branchReference?.glossaryRef).toBe("sha256:glossary-content-hash-139");
    expect(context.branchReference?.referenceId).toBe("branch-ref-139");

    // A non-DB consumer receiving the `reviewer.detail` JSON body
    // validates it with the shared API schema and reads the reference
    // off the wire. The provenance fields are plain JSON (no Dates), so
    // they survive serialization intact.
    expect(() => assertItotoriApiResponse("reviewer.detail", context)).not.toThrow();
    const wireReference = JSON.parse(JSON.stringify(context.branchReference)) as unknown as Record<
      string,
      unknown
    >;
    expect(wireReference).toEqual(expectedReference);
    expect(wireReference.draftId).toBe(draft.draftId);

    // No diagnostic is raised: the provenance is present and bound.
    expect(context.diagnostics.map((d) => d.code)).not.toContain(
      reviewerDetailDiagnosticCodeValues.missingBranchReference,
    );
  });

  it("emits missing_branch_reference when a draft has no bound reference", async () => {
    const item = runtimeEvidenceItemFixture();
    const stub = stubLoader({
      item,
      payload: {
        loadedSourceRevisionId: item.sourceRevisionId,
        source: sourceUnitFixture(),
        draft: draftFixture(),
        policy: policyFixture(),
        branchReference: null,
        rationaleRefs: [rationaleFixture()],
        runtimeEvidence: [runtimeTextTraceFixture()],
      },
    });
    const context = await loadReviewerDetailContext(
      { reviewItemId: item.reviewItemId },
      { permission: permissionView(), evidenceLoader: stub.loader },
    );

    expect(context.branchReference).toBeNull();
    expect(context.diagnostics.map((d) => d.code)).toContain(
      reviewerDetailDiagnosticCodeValues.missingBranchReference,
    );
  });

  it("blanks the branch reference on a stale source revision (no unverifiable provenance)", async () => {
    const item = runtimeEvidenceItemFixture({
      sourceRevisionId: "source-revision-itotori-082-newer",
    });
    const stub = stubLoader({
      item,
      payload: {
        loadedSourceRevisionId: "source-revision-itotori-082-older",
        source: sourceUnitFixture({ sourceRevisionId: "source-revision-itotori-082-older" }),
        draft: draftFixture(),
        policy: policyFixture(),
        branchReference: branchReferenceFixture(),
        rationaleRefs: [rationaleFixture()],
        runtimeEvidence: [runtimeTextTraceFixture()],
      },
    });
    const context = await loadReviewerDetailContext(
      { reviewItemId: item.reviewItemId },
      { permission: permissionView(), evidenceLoader: stub.loader },
    );

    expect(context.draft).toBeNull();
    expect(context.branchReference).toBeNull();
    expect(context.diagnostics.map((d) => d.code)).toContain(
      reviewerDetailDiagnosticCodeValues.staleSourceRevision,
    );
  });
});

describe("resolveReviewerQueuePermissionView", () => {
  function authorization(
    grants: ReadonlyArray<string>,
    actorUserId = "local-user",
  ): ItotoriAuthorizationPort {
    const granted = new Set(grants);
    return {
      requirePermission: async (permission) => {
        if (!granted.has(permission)) {
          throw new AuthorizationError({ userId: actorUserId }, permission);
        }
      },
    };
  }

  it("flags canReadQueue=true and canManageQueue=true when both grants are present", async () => {
    const view = await resolveReviewerQueuePermissionView(
      authorization([permissionValues.queueRead, permissionValues.queueManage]),
      "local-user",
    );
    expect(view).toEqual({
      actorUserId: "local-user",
      canReadQueue: true,
      canManageQueue: true,
      denialReasons: [],
    });
  });

  it("returns the AuthorizationError messages verbatim when permissions are missing", async () => {
    const view = await resolveReviewerQueuePermissionView(authorization([], "anon"), "anon");
    expect(view.canReadQueue).toBe(false);
    expect(view.canManageQueue).toBe(false);
    expect(view.denialReasons).toEqual([
      "user anon is missing permission queue.read",
      "user anon is missing permission queue.manage",
    ]);
  });

  it("rethrows non-AuthorizationError failures from the underlying port", async () => {
    const exploding: ItotoriAuthorizationPort = {
      requirePermission: async () => {
        throw new Error("auth backend offline");
      },
    };
    await expect(resolveReviewerQueuePermissionView(exploding, "local-user")).rejects.toThrowError(
      "auth backend offline",
    );
  });
});
