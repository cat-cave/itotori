// itotori-loop-to-review-queue-bridge (pre-pilot #2) — bridge tests.
//
// Proves the agentic loop creates a context-rich `reviewer_queue_items` callout
// when permanent QA annotations warrant attention, that this is the DEFAULT
// loop path (fires from `runAgenticLoopForUnit`, not a fixture/manual step),
// that the item surfaces via the reviewer-queue read carrying source / selected
// draft / context / evidence / annotations, that a clean run creates NOTHING,
// and that a re-run is idempotent (no duplicate for the same unit+revision).
//
// Driven with a FakeModelProvider + an in-memory reviewer-queue repository, so
// no live LLM and no Postgres are required. The DB-backed
// `ItotoriReviewerQueueRepository.createItem` path is exercised by
// packages/itotori-db/test/reviewer-queue-repository.test.ts under `ci-itotori`.

import { describe, expect, it } from "vitest";
import {
  STRUCTURED_QA_FINDING_OUTPUT_SCHEMA_VERSION,
  STRUCTURED_TRANSLATION_DRAFT_OUTPUT_SCHEMA_VERSION,
  SPEAKER_LABEL_OUTPUT_SCHEMA_VERSION,
  type LocalizationUnitV02,
  type QaFinding,
} from "@itotori/localization-bridge-schema";
import {
  DEV_POLICY,
  fakeSemanticContextContent,
  runAgenticLoopForUnit,
  type AgenticLoopPolicy,
  type AgenticLoopProviderFactory,
  type AgenticLoopUnitInput,
} from "../src/orchestrator/agentic-loop.js";
import { AGENTIC_LOOP_DECISION_RECORD_SCHEMA_VERSION } from "../src/orchestrator/reviewer-queue-bridge.js";
import { ReviewerQueueApiService } from "../src/reviewer/api-service.js";
import { FakeModelProvider } from "../src/providers/fake.js";
import type { ModelInvocationRequest } from "../src/providers/types.js";
import {
  ReviewerQueueRepositoryError,
  reviewerQueueItemKindValues,
  reviewerQueueItemStateValues,
  type AuthorizationActor,
  type CreateReviewerQueueItemInput,
  type ItotoriReviewerQueueRepositoryPort,
  type ReviewerQueueItemRecord,
  type ReviewerQueueTransitionRecord,
} from "@itotori/db";
import type { ReviewerQueuePermissionView } from "../src/auth.js";

const ACTOR: AuthorizationActor = { userId: "bridge-test-actor" };

const BRIDGE_UNIT_ID = "019ed079-0000-7000-8000-00000000bc01";
const PROJECT_ID = "019ed079-0000-7000-8000-000000000001";
const LOCALE_BRANCH_ID = "019ed079-0000-7000-8000-000000000002";
const REVISION_ID = "019ed079-0000-7000-8000-000000000003";
const RUN_SOURCE_REVISION_ID = "019ed079-0000-7000-8000-0000000000b3";
const ASSET_ID = "019ed079-0000-7000-8000-000000000004";

const SOURCE_TEXT = "ありがとう。";
const DRAFT_TEXT = "Thank you.";
const GLOSSARY_CITATION_REF = "glossary:term-yusha";

// --- In-memory reviewer-queue repository ------------------------------------
//
// Enforces the SAME unique key as the real table
// (locale_branch_id, source_revision_id, item_kind, source_item_ref) so the
// idempotency backstop (`reviewer_queue_item_duplicate`) is exercised.

class InMemoryReviewerQueue implements Pick<
  ItotoriReviewerQueueRepositoryPort,
  "createItem" | "loadItemsByBranch"
> {
  readonly items: ReviewerQueueItemRecord[] = [];
  private seq = 0;

  async createItem(
    _actor: AuthorizationActor,
    input: CreateReviewerQueueItemInput,
  ): Promise<ReviewerQueueItemRecord> {
    const clash = this.items.some(
      (item) =>
        item.localeBranchId === input.localeBranchId &&
        item.sourceRevisionId === input.sourceRevisionId &&
        item.itemKind === input.itemKind &&
        item.sourceItemRef === input.sourceItemRef,
    );
    if (clash) {
      throw new ReviewerQueueRepositoryError(
        "reviewer_queue_item_duplicate",
        `reviewer queue already has an item for locale_branch=${input.localeBranchId} source_revision=${input.sourceRevisionId} kind=${input.itemKind} ref=${input.sourceItemRef}`,
      );
    }
    this.seq += 1;
    const createdAt = input.createdAt ?? new Date();
    const record: ReviewerQueueItemRecord = {
      reviewItemId: `reviewer-queue-inmem-${this.seq}`,
      projectId: input.projectId,
      localeBranchId: input.localeBranchId,
      sourceRevisionId: input.sourceRevisionId,
      itemKind: input.itemKind,
      sourceItemRef: input.sourceItemRef,
      state: reviewerQueueItemStateValues.pending,
      priority: input.priority ?? 0,
      summary: input.summary,
      affectedArtifactIds: input.affectedArtifactIds ?? [],
      evidenceTier: input.evidenceTier ?? null,
      observationEventIds: input.observationEventIds ?? null,
      artifactHashes: input.artifactHashes ?? null,
      payload: input.payload ?? {},
      metadata: input.metadata ?? {},
      createdByUserId: input.createdByUserId ?? null,
      assignedToUserId: input.assignedToUserId ?? null,
      createdAt,
      updatedAt: createdAt,
      resolvedAt: null,
    };
    this.items.push(record);
    return record;
  }

  async loadItemsByBranch(
    _actor: AuthorizationActor,
    localeBranchId: string,
  ): Promise<ReviewerQueueItemRecord[]> {
    return this.items.filter((item) => item.localeBranchId === localeBranchId);
  }
}

// --- Loop fixtures ----------------------------------------------------------

function makeUnit(): LocalizationUnitV02 {
  return {
    bridgeUnitId: BRIDGE_UNIT_ID,
    surfaceId: ASSET_ID,
    surfaceKind: "dialogue",
    sourceUnitKey: "scene-001/line-001",
    occurrenceId: "occ-001",
    sourceLocale: "ja-JP",
    sourceText: SOURCE_TEXT,
    sourceHash: "src-hash-bridge-fixture",
    sourceRevision: { revisionId: REVISION_ID, revisionKind: "content_hash", value: "fixture-rev" },
    sourceAssetRef: { assetId: ASSET_ID, assetKey: "fixture-asset" },
    sourceLocation: { containerKey: "fixture-asset" },
    context: {},
    spans: [],
    patchRef: {
      assetId: ASSET_ID,
      writeMode: "replace",
      sourceUnitKey: "scene-001/line-001",
      sourceRevision: {
        revisionId: REVISION_ID,
        revisionKind: "content_hash",
        value: "fixture-rev",
      },
    },
    runtimeExpectation: { expectationKind: "metadata_only" },
  };
}

function makeInput(queue?: InMemoryReviewerQueue): AgenticLoopUnitInput {
  return {
    unit: makeUnit(),
    sourceRevisionId: RUN_SOURCE_REVISION_ID,
    sceneUnits: [],
    glossary: [
      {
        termId: GLOSSARY_CITATION_REF,
        preferredSourceForm: "ありがとう",
        preferredTargetForm: "thank you",
        policyAction: "localize",
      },
    ],
    protectedSpans: [],
    knownCharacters: [],
    actor: ACTOR,
    ...(queue !== undefined ? { reviewerQueue: { repository: queue } } : {}),
  };
}

function makePolicy(overrides: Partial<AgenticLoopPolicy> = {}): AgenticLoopPolicy {
  return {
    projectId: PROJECT_ID,
    localeBranchId: LOCALE_BRANCH_ID,
    sourceLocale: "ja-JP",
    targetLocale: "en-US",
    maxRepairAttempts: 1,
    now: deterministicClock(),
    ...overrides,
  };
}

function deterministicClock(): () => Date {
  let tick = 0;
  return () => {
    const date = new Date(Date.UTC(2026, 6, 4, 12, 0, 0));
    date.setUTCSeconds(tick);
    tick += 1;
    return date;
  };
}

function speakerLabelContent(): string {
  return JSON.stringify({
    schemaVersion: SPEAKER_LABEL_OUTPUT_SCHEMA_VERSION,
    labels: [
      {
        bridgeUnitId: BRIDGE_UNIT_ID,
        speakerId: { kind: "narration" },
        confidence: "high",
        evidenceRefs: [],
        agentRationale: "fixture-narration",
      },
    ],
  });
}

function translationContent(): string {
  return JSON.stringify({
    schemaVersion: STRUCTURED_TRANSLATION_DRAFT_OUTPUT_SCHEMA_VERSION,
    drafts: [
      {
        bridgeUnitId: BRIDGE_UNIT_ID,
        sourceLocale: "ja-JP",
        targetLocale: "en-US",
        draftText: DRAFT_TEXT,
        protectedSpanRefs: [],
        citationRefs: [GLOSSARY_CITATION_REF],
        agentRationale: "fixture-translation",
        confidenceFloor: "medium",
      },
    ],
  });
}

function qaContent(findings: ReadonlyArray<QaFinding>): string {
  return JSON.stringify({
    schemaVersion: STRUCTURED_QA_FINDING_OUTPUT_SCHEMA_VERSION,
    findings,
  });
}

/**
 * Provider factory whose first QA agent emits `firstQaFinding` (the other three
 * are clean) and whose translation always emits the same clean draft. Every
 * repair attempt re-emits the clean draft too, so the outcome is driven purely
 * by the finding + `maxRepairAttempts`.
 */
function providerFactory(firstQaFinding?: QaFinding): AgenticLoopProviderFactory {
  let qaCall = 0;
  return ({ stage, agentLabel }) =>
    new FakeModelProvider({
      providerName: `fake-${stage}-${agentLabel}`,
      generate: (request: ModelInvocationRequest) => {
        if (request.taskKind === "experiment" && agentLabel === "speaker-label") {
          return speakerLabelContent();
        }
        if (request.taskKind === "experiment") {
          return fakeSemanticContextContent(agentLabel);
        }
        if (request.taskKind === "draft_translation") {
          return translationContent();
        }
        if (request.taskKind === "llm_qa") {
          qaCall += 1;
          if (qaCall === 1 && firstQaFinding !== undefined) {
            return qaContent([firstQaFinding]);
          }
          return qaContent([]);
        }
        return "";
      },
    });
}

function criticalFinding(): QaFinding {
  return {
    findingId: "019ed079-0000-7000-8000-000000000f01",
    bridgeUnitId: BRIDGE_UNIT_ID,
    severity: "critical",
    category: "mistranslation",
    evidenceRefs: [],
    recommendation: "fixture: the draft mistranslates the source",
    agentRationale: "fixture-critical-finding",
  };
}

function majorFinding(): QaFinding {
  return {
    findingId: "019ed079-0000-7000-8000-000000000f02",
    bridgeUnitId: BRIDGE_UNIT_ID,
    // `other` routes to a non-repairable, non-critical root cause, so the loop
    // ACCEPTS the draft — yet the finding is above the review severity floor,
    // so the bridge must still surface it to a human.
    severity: "major",
    category: "other",
    evidenceRefs: [],
    recommendation: "fixture: reviewer should confirm the register",
    agentRationale: "fixture-major-finding",
  };
}

const PERMISSION: ReviewerQueuePermissionView = {
  actorUserId: ACTOR.userId,
  canReadQueue: true,
  canManageQueue: true,
  denialReasons: [],
};

// Adapter from the in-memory store to the api-service's actor-free read port.
function readRepository(queue: InMemoryReviewerQueue) {
  return {
    loadItemsByBranch: (localeBranchId: string): Promise<ReviewerQueueItemRecord[]> =>
      queue.loadItemsByBranch(ACTOR, localeBranchId),
    loadTransitionsByItem: (_reviewItemId: string): Promise<ReviewerQueueTransitionRecord[]> =>
      Promise.resolve([]),
    getItem: (reviewItemId: string): Promise<ReviewerQueueItemRecord | null> =>
      Promise.resolve(queue.items.find((item) => item.reviewItemId === reviewItemId) ?? null),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("agentic-loop reviewer-queue bridge (itotori-loop-to-review-queue-bridge)", () => {
  it("a critical QA callout retains a written draft in a context-rich reviewer_queue_items row", async () => {
    const queue = new InMemoryReviewerQueue();
    const bundle = await runAgenticLoopForUnit(
      makeInput(queue),
      DEV_POLICY,
      makePolicy({ maxRepairAttempts: 0 }),
      providerFactory(criticalFinding()),
    );
    expect(bundle.writtenOutcome.status).toBe("written");
    const selectedCandidate = bundle.writtenOutcome.candidates.find(
      (candidate) => candidate.id === bundle.writtenOutcome.selectedCandidateId,
    );
    expect(selectedCandidate?.body).toBe(DRAFT_TEXT);
    expect(bundle.writtenOutcome.qualityFlags).toEqual(
      expect.arrayContaining(["qa_unresolved", "repair_budget_exhausted"]),
    );

    expect(queue.items).toHaveLength(1);
    const item = queue.items[0]!;
    expect(item.itemKind).toBe(reviewerQueueItemKindValues.qa);
    expect(item.sourceItemRef).toBe(`agentic-loop:${BRIDGE_UNIT_ID}`);
    expect(item.sourceRevisionId).toBe(RUN_SOURCE_REVISION_ID);
    expect(item.sourceRevisionId).not.toBe(REVISION_ID);
    expect(item.state).toBe(reviewerQueueItemStateValues.pending);
    expect(item.createdByUserId).toBe(ACTOR.userId);

    // Full decision context: source / draft / context / evidence / reasoning / options.
    const record = item.payload.decisionRecord as Record<string, any>;
    expect(record.schemaVersion).toBe(AGENTIC_LOOP_DECISION_RECORD_SCHEMA_VERSION);
    expect(record.state).toBe("ready_for_human");
    expect(record.outcome).toBe("written");
    expect(record.source.sourceText).toBe(SOURCE_TEXT);
    expect(record.source.sourceHash).toBe("src-hash-bridge-fixture");
    expect(record.source.sourceRevision.revisionId).toBe(REVISION_ID);
    // The selected written draft is carried so the reviewer never judges an isolated line.
    expect(typeof record.draft.draftText).toBe("string");
    expect(record.draft.draftText).toBe(DRAFT_TEXT);
    expect(record.draft.draftStatus).toBe("written_with_qa_callout");
    expect(Array.isArray(record.context.contextArtifactRefs)).toBe(true);
    expect(record.context.citationRefs).toEqual([GLOSSARY_CITATION_REF]);
    // wiki-structure-context-feed — when a structured injection was available
    // it is persisted on the decision record so the reviewer detail UI can
    // show the same scene summary / character arcs that fed the draft.
    // (This fixture path may or may not supply narrativeStructure; the field
    // is optional and only asserted for shape when present.)
    if (record.context.structuredContext !== undefined) {
      expect(typeof record.context.structuredContext.sceneSummaryText).toBe("string");
      expect(typeof record.context.structuredContext.routePositionText).toBe("string");
      expect(typeof record.context.structuredContext.characterArcsText).toBe("string");
      expect(Array.isArray(record.context.structuredContext.artifactRefs)).toBe(true);
    }
    expect(record.reasoningAndFindings.qaFindings).toHaveLength(1);
    expect(record.reasoningAndFindings.qaFindings[0].severity).toBe("critical");
    expect(record.reasoningAndFindings.qualityFlags).toEqual(
      expect.arrayContaining(["qa_unresolved", "repair_budget_exhausted"]),
    );
    expect(record.reasoningAndFindings.repairHistory.repairStageOutcome).toBe(
      "repair_budget_exhausted",
    );
    expect(record.options.map((o: { optionId: string }) => o.optionId)).toEqual(["inspect"]);
  });

  it("the item surfaces via the reviewer-queue read (repository + dashboard)", async () => {
    const queue = new InMemoryReviewerQueue();
    await runAgenticLoopForUnit(
      makeInput(queue),
      DEV_POLICY,
      makePolicy({ maxRepairAttempts: 0 }),
      providerFactory(criticalFinding()),
    );

    // Repository read carries the full decision context.
    const branchItems = await queue.loadItemsByBranch(ACTOR, LOCALE_BRANCH_ID);
    expect(branchItems).toHaveLength(1);
    expect(
      (branchItems[0]!.payload.decisionRecord as { source: { sourceText: string } }).source
        .sourceText,
    ).toBe(SOURCE_TEXT);

    // Dashboard read (the `/api/reviewer/queue` read model) lists it as pending.
    const api = new ReviewerQueueApiService({ repository: readRepository(queue) });
    const dashboard = await api.loadDashboard({
      localeBranchId: LOCALE_BRANCH_ID,
      permission: PERMISSION,
    });
    expect(dashboard.rows).toHaveLength(1);
    expect(dashboard.rows[0]!.dashboardState).toBe("pending");
    expect(dashboard.rows[0]!.decisionId).toBe(`decision-agentic-loop-${BRIDGE_UNIT_ID}`);
    expect(dashboard.aggregate.pending).toBe(1);

    const detail = await api.loadDetailContext({
      reviewItemId: branchItems[0]!.reviewItemId,
      permission: PERMISSION,
    });
    expect(detail.structureContextFeed).not.toBeNull();
    expect(detail.structureContextFeed?.citationRefs).toEqual([GLOSSARY_CITATION_REF]);
    expect(
      detail.structureContextFeed?.items.some(
        (item) => item.kind === "glossary_term" && item.artifactRef === GLOSSARY_CITATION_REF,
      ),
    ).toBe(true);
  });

  it("a threshold-exceeding QA annotation on a written draft still creates a row", async () => {
    const queue = new InMemoryReviewerQueue();
    const bundle = await runAgenticLoopForUnit(
      makeInput(queue),
      DEV_POLICY,
      makePolicy({ maxRepairAttempts: 1 }),
      providerFactory(majorFinding()),
    );
    // The draft remains written while a major finding crosses the callout floor.
    expect(bundle.writtenOutcome.status).toBe("written");
    expect(bundle.writtenOutcome.selectedCandidateId).toBeDefined();

    expect(queue.items).toHaveLength(1);
    const record = queue.items[0]!.payload.decisionRecord as Record<string, any>;
    expect(record.outcome).toBe("written");
    expect(record.decisionType).toBe("qa_finding_review");
    expect(record.draft.draftStatus).toBe("written_with_qa_callout");
    expect(record.reasoningAndFindings.qaFindings[0].severity).toBe("major");
  });

  it("a clean written run with no floor-crossing finding creates NO item", async () => {
    const queue = new InMemoryReviewerQueue();
    const bundle = await runAgenticLoopForUnit(
      makeInput(queue),
      DEV_POLICY,
      makePolicy(),
      providerFactory(),
    );
    expect(bundle.writtenOutcome.status).toBe("written");
    expect(queue.items).toHaveLength(0);
  });

  it("re-running the same unit+revision is idempotent (no duplicate row)", async () => {
    const queue = new InMemoryReviewerQueue();
    for (let run = 0; run < 2; run += 1) {
      await runAgenticLoopForUnit(
        makeInput(queue),
        DEV_POLICY,
        makePolicy({ maxRepairAttempts: 0 }),
        providerFactory(criticalFinding()),
      );
    }
    expect(queue.items).toHaveLength(1);
  });

  it("without a wired sink the loop persists nothing (synthetic smoke path)", async () => {
    const bundle = await runAgenticLoopForUnit(
      makeInput(),
      DEV_POLICY,
      makePolicy({ maxRepairAttempts: 0 }),
      providerFactory(criticalFinding()),
    );
    // No throw, no sink — the loop still returns its required written outcome.
    expect(bundle.writtenOutcome.status).toBe("written");
    expect(bundle.writtenOutcome.selectedCandidateId).toBeDefined();
  });
});
