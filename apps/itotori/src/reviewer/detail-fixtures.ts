// ITOTORI-082 — typed evidence fixtures for the reviewer detail UI.
//
// Every fixture mirrors the shape the detail view consumes when wired
// to live repositories. The fixtures are exported by name so tests can
// pin the rendered HTML against deterministic inputs, and so the route
// loader can swap a fake context in for screenshot / snapshot tests
// without standing up Postgres.
//
// Audit focus addressed by these fixtures:
//   - Runtime evidence rows always carry `evidenceTier`, `artifactHash`,
//     `runtimeTargetId`, and `observationEventIds` (acceptance #2). No
//     fixture surfaces a raw `localPath`; the runtime evidence view
//     intentionally has no such field.
//   - Stale and denied fixtures are first-class so detail UI tests can
//     pin the visible diagnostic copy (acceptance #4 / #3).

import {
  reviewerQueueActionValues,
  reviewerQueueItemKindValues,
  reviewerQueueItemStateValues,
  type ReviewerQueueAction,
  type ReviewerQueueItemKind,
  type ReviewerQueueItemRecord,
  type ReviewerQueueItemState,
  type ReviewerQueueTransitionRecord,
} from "@itotori/db";
import type { ReviewerDetailStructureContextFeed } from "./structure-context-feed.js";
import { structureContextFeedItemKindValues } from "./structure-context-feed.js";

/**
 * Source-unit panel data. Renders the bridge unit id, the source
 * revision id, and the source bytes that were translated. Matches the
 * shape carried by the localization-bridge unit catalog so the live
 * loader can pass this through unchanged.
 */
export type ReviewerDetailSourceUnit = {
  bridgeUnitId: string;
  sourceUnitKey: string;
  sourceRevisionId: string;
  sourceLocale: string;
  sourceText: string;
  contextNote: string | null;
};

/**
 * Draft panel data. The reviewer detail view renders the draft side-by-
 * side with the source so the reviewer can compare them at a glance.
 */
export type ReviewerDetailDraft = {
  draftId: string;
  draftAttemptId: string;
  targetLocale: string;
  draftText: string;
  approvedPatchText: string | null;
  draftStatus: "pending_review" | "accepted" | "rejected" | "repair_requested";
  attemptCount: number;
};

/**
 * Locale-branch style guide policy reference. The reviewer detail UI
 * shows the policy version id, status, and a short label so the
 * reviewer can decide if the draft followed the active policy.
 */
export type ReviewerDetailPolicy = {
  styleGuidePolicyVersionId: string;
  styleGuidePolicyStatus: "draft" | "approved" | "stale";
  policyLabel: string;
  approvedAt: Date | null;
  approverUserId: string | null;
};

/**
 * Glossary entry reference. The reviewer detail UI renders one row per
 * referenced term so the reviewer can confirm the draft used the
 * approved translation.
 */
export type ReviewerDetailGlossaryEntry = {
  termId: string;
  sourceTerm: string;
  preferredTranslation: string;
  glossaryEntryStatus: "approved" | "proposed" | "rejected";
};

/**
 * ITOTORI-139 — branch-scoped policy + glossary REFERENCE PROVENANCE.
 *
 * The exact `branch_policy_glossary_reference` version that was attached
 * to the draft under review. Previously this provenance was only
 * observable inside `packages/itotori-db`
 * (`BranchPolicyGlossaryReferenceRecord`); a consumer outside itotori-db
 * had no way to verify WHICH policy/glossary version a draft was
 * produced under. Surfacing it on the review context lets a non-DB
 * consumer read `draft → branchPolicyRef + glossaryRef` and assert it
 * matches the expected reference.
 *
 * Field mapping onto the DB record:
 *   - `referenceId`          ← reference identity (`referenceId`)
 *   - `versionSequence`      ← monotonic branch reference version
 *   - `branchPolicyRef`      ← the exact `styleGuideVersionId` (POLICY);
 *                              null when the branch has no approved policy
 *   - `glossaryRef`          ← the exact `glossaryContentHash` (GLOSSARY)
 *   - `supersedesReferenceId`← the reference this one replaced
 *
 * `draftId` binds the reference to the specific draft it was attached to,
 * so the binding proof is exact: the consumer confirms this reference
 * belongs to THIS draft, not merely that some reference exists.
 */
export type ReviewerDetailBranchReference = {
  referenceId: string;
  localeBranchId: string;
  versionSequence: number;
  draftId: string;
  branchPolicyRef: string | null;
  glossaryRef: string;
  supersedesReferenceId: string | null;
  updateReason: string;
};

/**
 * QA finding reference. Only includes typed refs (category, severity,
 * finding id) — the full finding payload lives behind the finding id so
 * the reviewer detail UI does not duplicate / drift QA copy.
 */
export type ReviewerDetailQaFinding = {
  findingId: string;
  category: "semantic_drift" | "style_adherence" | "tone_register" | "unresolved_terminology";
  severity: "blocker" | "major" | "minor" | "info";
  summary: string;
};

/**
 * Runtime evidence panel data. Carries the Utsushi evidence tier,
 * artifact hashes, runtime target id, and observation event ids
 * verbatim. No `localPath` field exists — that is the explicit
 * acceptance guarantee for ITOTORI-082 acceptance #2.
 */
export type ReviewerDetailRuntimeEvidence = {
  evidenceKind: "text_trace" | "screenshot_artifact" | "recording_artifact" | "benchmark_finding";
  evidenceTier: string;
  runtimeTargetId: string;
  observationEventIds: string[];
  artifactHashes: string[];
  /**
   * Optional provider proof refs (e.g. `provider:openrouter:run-id`).
   * Recorded verbatim — the reviewer UI does not derive these from
   * local file paths.
   */
  providerProofRefs: string[];
  summary: string;
};

/**
 * Rationale chain for the reviewer's decision. Carries refs to upstream
 * artifacts (model run ids, agent attempt ids, source revision id) so
 * the reviewer can audit why the draft was produced.
 */
export type ReviewerDetailRationaleRef = {
  refKind: "model_run" | "agent_attempt" | "source_revision" | "context_artifact";
  refId: string;
  label: string;
};

/**
 * Lightweight summary of one prior transition log row. Renders the
 * action, actor, prior/next state, and timestamp so reviewers see the
 * decision history without leaving the detail page.
 */
export type ReviewerDetailTransition = {
  transitionId: string;
  action: ReviewerQueueAction;
  priorState: ReviewerQueueItemState;
  nextState: ReviewerQueueItemState;
  actorUserId: string;
  createdAt: Date;
};

/**
 * Closed taxonomy of detail-level diagnostics the loader emits. Each
 * code maps to a visible block on the detail UI so missing or stale
 * context produces a banner instead of an empty panel (audit focus).
 */
export const reviewerDetailDiagnosticCodeValues = {
  staleSourceRevision: "reviewer_detail_stale_source_revision",
  missingDraft: "reviewer_detail_missing_draft",
  missingPolicy: "reviewer_detail_missing_policy",
  missingGlossaryRef: "reviewer_detail_missing_glossary_ref",
  missingBranchReference: "reviewer_detail_missing_branch_reference",
  missingRuntimeEvidence: "reviewer_detail_missing_runtime_evidence",
  missingRationale: "reviewer_detail_missing_rationale",
  /**
   * wiki-structure-context-feed — a draft is present but no structure-
   * informed context feed could be resolved (no decision-record context,
   * no structured-context injection, no citable artifact refs). The
   * reviewer cannot see WHY the draft chose its wording.
   */
  missingStructureContextFeed: "reviewer_detail_missing_structure_context_feed",
  permissionDenied: "reviewer_detail_permission_denied",
} as const;

export type ReviewerDetailDiagnosticCode =
  (typeof reviewerDetailDiagnosticCodeValues)[keyof typeof reviewerDetailDiagnosticCodeValues];

export type ReviewerDetailDiagnostic = {
  code: ReviewerDetailDiagnosticCode;
  message: string;
};

/**
 * Top-level reviewer detail context. Wraps every panel + the diagnostic
 * trail so the renderer can dispatch on a single typed value.
 *
 * `permission` is the only async piece the loader resolves up front;
 * when the actor lacks `queue.read`, every payload field is null and
 * the renderer emits the denial UI without touching evidence.
 */
export type ReviewerDetailContext = {
  reviewItemId: string;
  permission: ReviewerDetailPermissionView;
  item: ReviewerQueueItemRecord | null;
  source: ReviewerDetailSourceUnit | null;
  draft: ReviewerDetailDraft | null;
  policy: ReviewerDetailPolicy | null;
  glossary: ReviewerDetailGlossaryEntry[];
  /**
   * ITOTORI-139 — the exact branch policy + glossary reference the draft
   * was produced under. Null when no draft / reference is bound (e.g. a
   * stale source revision blanks it out alongside the draft + policy).
   */
  branchReference: ReviewerDetailBranchReference | null;
  qaFindings: ReviewerDetailQaFinding[];
  runtimeEvidence: ReviewerDetailRuntimeEvidence[];
  rationaleRefs: ReviewerDetailRationaleRef[];
  /**
   * wiki-structure-context-feed — the structure-informed context
   * (scene summary / character arcs / route map / glossary citations)
   * that fed this draft's wording. Null when no feed could be resolved;
   * the loader emits `missingStructureContextFeed` when a draft is
   * present without a feed so the gap is never a silent empty panel.
   */
  structureContextFeed: ReviewerDetailStructureContextFeed | null;
  transitions: ReviewerDetailTransition[];
  diagnostics: ReviewerDetailDiagnostic[];
};

/**
 * Reviewer permission view. The loader resolves the queue.read /
 * queue.manage grants for the current actor so the detail view can
 * disable the action buttons inline; the action buttons themselves are
 * still gated server-side by the action service.
 */
export type ReviewerDetailPermissionView = {
  actorUserId: string;
  canReadQueue: boolean;
  canManageQueue: boolean;
  denialReasons: string[];
};

const fixtureProjectId = "project-itotori-082";
const fixtureLocaleBranchId = "locale-branch-itotori-082";
const fixtureSourceRevisionId = "source-revision-itotori-082";
const fixtureCreatedAt = new Date("2026-06-24T00:00:00Z");

function makeItem(
  itemKind: ReviewerQueueItemKind,
  state: ReviewerQueueItemState,
  overrides: Partial<ReviewerQueueItemRecord> = {},
): ReviewerQueueItemRecord {
  const isRuntime = itemKind === reviewerQueueItemKindValues.runtimeEvidence;
  return {
    reviewItemId: "reviewer-queue-itotori-082",
    projectId: fixtureProjectId,
    localeBranchId: fixtureLocaleBranchId,
    sourceRevisionId: fixtureSourceRevisionId,
    itemKind,
    sourceItemRef: "fixture-source-ref",
    state,
    priority: 0,
    summary: "fixture reviewer queue item",
    affectedArtifactIds: [],
    evidenceTier: isRuntime ? "tier-2-trace" : null,
    observationEventIds: isRuntime ? ["observation-event-fixture-1"] : null,
    artifactHashes: isRuntime ? ["sha256:fixture-runtime-bytes"] : null,
    payload: {},
    metadata: {},
    createdByUserId: null,
    assignedToUserId: null,
    createdAt: fixtureCreatedAt,
    updatedAt: fixtureCreatedAt,
    resolvedAt: state === reviewerQueueItemStateValues.pending ? null : fixtureCreatedAt,
    ...overrides,
  };
}

export function sourceUnitFixture(
  overrides: Partial<ReviewerDetailSourceUnit> = {},
): ReviewerDetailSourceUnit {
  return {
    bridgeUnitId: "bridge-unit-itotori-082",
    sourceUnitKey: "scene.001.line.001",
    sourceRevisionId: fixtureSourceRevisionId,
    sourceLocale: "ja-JP",
    sourceText: "こんにちは、世界。",
    contextNote: "Greeting in scene 1.",
    ...overrides,
  };
}

export function draftFixture(overrides: Partial<ReviewerDetailDraft> = {}): ReviewerDetailDraft {
  return {
    draftId: "draft-itotori-082",
    draftAttemptId: "draft-attempt-itotori-082",
    targetLocale: "en-US",
    draftText: "Hello, world.",
    approvedPatchText: null,
    draftStatus: "pending_review",
    attemptCount: 1,
    ...overrides,
  };
}

export function policyFixture(overrides: Partial<ReviewerDetailPolicy> = {}): ReviewerDetailPolicy {
  return {
    styleGuidePolicyVersionId: "style-guide-version-itotori-082",
    styleGuidePolicyStatus: "approved",
    policyLabel: "Demo corpus — informal honorifics",
    approvedAt: fixtureCreatedAt,
    approverUserId: "local-user",
    ...overrides,
  };
}

export function glossaryFixture(
  overrides: Partial<ReviewerDetailGlossaryEntry> = {},
): ReviewerDetailGlossaryEntry {
  return {
    termId: "term-itotori-082",
    sourceTerm: "世界",
    preferredTranslation: "world",
    glossaryEntryStatus: "approved",
    ...overrides,
  };
}

export function branchReferenceFixture(
  overrides: Partial<ReviewerDetailBranchReference> = {},
): ReviewerDetailBranchReference {
  return {
    referenceId: "branch-policy-glossary-reference-itotori-082",
    localeBranchId: fixtureLocaleBranchId,
    versionSequence: 3,
    draftId: "draft-itotori-082",
    branchPolicyRef: "style-guide-version-itotori-082",
    glossaryRef: "sha256:branch-glossary-content-hash-itotori-082",
    supersedesReferenceId: "branch-policy-glossary-reference-itotori-082-prior",
    updateReason: "glossary_snapshot_refreshed",
    ...overrides,
  };
}

/**
 * wiki-structure-context-feed — a ready structure-context feed that mirrors
 * the translate-stage structure-informed injection (scene summary + route
 * position + character arcs) so the reviewer detail panel can show WHY the
 * draft chose its wording.
 */
export function structureContextFeedFixture(
  overrides: Partial<ReviewerDetailStructureContextFeed> = {},
): ReviewerDetailStructureContextFeed {
  return {
    whyHeading: "Structure-informed context that fed this draft's wording",
    sceneId: 6010,
    items: [
      {
        kind: structureContextFeedItemKindValues.sceneSummary,
        artifactRef: "scene-summary:6010",
        title: "Scene summary",
        body: "Scene 6010: 3 messages; speakers 勇者, 王女; opens with 勇者; no choices; dispatches to scene 6020.",
        feedRole: "Fed the draft's scene-aware wording (structure-informed injection).",
      },
      {
        kind: structureContextFeedItemKindValues.routeMap,
        artifactRef: "route-branch-map",
        title: "Route / branch position",
        body: "Scene 6010 route position: position 1 of 2 in the dispatch order [6010 -> 6020]; entry scene (no in-graph predecessor); dispatches to scene 6020.",
        feedRole: "Fed the draft's branch-aware wording (structure-informed injection).",
      },
      {
        kind: structureContextFeedItemKindValues.characterArc,
        artifactRef: "character-arc:勇者",
        title: "Character arcs",
        body: "Speaker arcs in this scene:\n- 勇者: appears in scenes 6010, 6020 (4 lines total).\n- 王女: appears in scenes 6010 (2 lines total).",
        feedRole: "Fed the draft's speaker voice consistency (structure-informed injection).",
      },
      {
        kind: structureContextFeedItemKindValues.glossaryTerm,
        artifactRef: "glossary-term:term-itotori-082",
        title: "Glossary term",
        body: "Cited glossary term term-itotori-082 constrained the preferred translation.",
        feedRole: "Cited context artifact available to the translate stage.",
      },
    ],
    contextArtifactIds: [
      "character-arc:勇者",
      "character-arc:王女",
      "glossary-term:term-itotori-082",
      "route-branch-map",
      "scene-summary:6010",
    ],
    citationRefs: ["glossary-term:term-itotori-082"],
    fedTheDraft: true,
    ...overrides,
  };
}

export function qaFindingFixture(
  overrides: Partial<ReviewerDetailQaFinding> = {},
): ReviewerDetailQaFinding {
  return {
    findingId: "qa-finding-itotori-082",
    category: "semantic_drift",
    severity: "major",
    summary: "Draft drops the greeting marker.",
    ...overrides,
  };
}

export function runtimeTextTraceFixture(
  overrides: Partial<ReviewerDetailRuntimeEvidence> = {},
): ReviewerDetailRuntimeEvidence {
  return {
    evidenceKind: "text_trace",
    evidenceTier: "tier-2-trace",
    runtimeTargetId: "utsushi-runtime-target-fixture",
    observationEventIds: ["observation-event-text-1", "observation-event-text-2"],
    artifactHashes: ["sha256:text-trace-bytes-1"],
    providerProofRefs: ["provider:openrouter:run-text-trace-1"],
    summary: "Text trace covering scene 1 greeting.",
    ...overrides,
  };
}

export function runtimeScreenshotFixture(
  overrides: Partial<ReviewerDetailRuntimeEvidence> = {},
): ReviewerDetailRuntimeEvidence {
  return {
    evidenceKind: "screenshot_artifact",
    evidenceTier: "tier-3-recording",
    runtimeTargetId: "utsushi-runtime-target-fixture",
    observationEventIds: ["observation-event-screenshot-1"],
    artifactHashes: ["sha256:screenshot-bytes-1"],
    providerProofRefs: [],
    summary: "Screenshot of greeting frame after draft applied.",
    ...overrides,
  };
}

export function runtimeBenchmarkFixture(
  overrides: Partial<ReviewerDetailRuntimeEvidence> = {},
): ReviewerDetailRuntimeEvidence {
  return {
    evidenceKind: "benchmark_finding",
    evidenceTier: "tier-2-trace",
    runtimeTargetId: "utsushi-runtime-target-benchmark",
    observationEventIds: ["observation-event-benchmark-1"],
    artifactHashes: ["sha256:benchmark-bytes-1"],
    providerProofRefs: [
      "provider:openrouter:run-benchmark-1",
      "provider:openrouter:run-benchmark-2",
    ],
    summary: "Benchmark run on scene 1.",
    ...overrides,
  };
}

export function runtimeProviderProofFixture(
  overrides: Partial<ReviewerDetailRuntimeEvidence> = {},
): ReviewerDetailRuntimeEvidence {
  return {
    evidenceKind: "recording_artifact",
    evidenceTier: "tier-3-recording",
    runtimeTargetId: "utsushi-runtime-target-fixture",
    observationEventIds: ["observation-event-recording-1"],
    artifactHashes: ["sha256:recording-bytes-1"],
    providerProofRefs: [
      "provider:openrouter:proof-recording-1",
      "provider:openai:proof-recording-2",
    ],
    summary: "Recording artifact with provider proof refs.",
    ...overrides,
  };
}

export function rationaleFixture(
  overrides: Partial<ReviewerDetailRationaleRef> = {},
): ReviewerDetailRationaleRef {
  return {
    refKind: "model_run",
    refId: "model-run-itotori-082",
    label: "Translation model run, attempt 1",
    ...overrides,
  };
}

export function transitionFixture(
  overrides: Partial<ReviewerDetailTransition> = {},
): ReviewerDetailTransition {
  return {
    transitionId: "reviewer-queue-transition-itotori-082",
    action: reviewerQueueActionValues.approve,
    priorState: reviewerQueueItemStateValues.pending,
    nextState: reviewerQueueItemStateValues.accepted,
    actorUserId: "local-user",
    createdAt: fixtureCreatedAt,
    ...overrides,
  };
}

export function repositoryTransitionFixture(
  overrides: Partial<ReviewerQueueTransitionRecord> = {},
): ReviewerQueueTransitionRecord {
  return {
    transitionId: "reviewer-queue-transition-itotori-082",
    reviewItemId: "reviewer-queue-itotori-082",
    localeBranchId: fixtureLocaleBranchId,
    sourceRevisionId: fixtureSourceRevisionId,
    itemKind: reviewerQueueItemKindValues.qa,
    action: reviewerQueueActionValues.approve,
    priorState: reviewerQueueItemStateValues.pending,
    nextState: reviewerQueueItemStateValues.accepted,
    actorUserId: "local-user",
    affectedArtifactIds: [],
    diagnostics: [],
    metadata: {},
    createdAt: fixtureCreatedAt,
    ...overrides,
  };
}

export function readyContextFixture(
  overrides: Partial<ReviewerDetailContext> = {},
): ReviewerDetailContext {
  const item = makeItem(reviewerQueueItemKindValues.qa, reviewerQueueItemStateValues.pending);
  return {
    reviewItemId: item.reviewItemId,
    permission: {
      actorUserId: "local-user",
      canReadQueue: true,
      canManageQueue: true,
      denialReasons: [],
    },
    item,
    source: sourceUnitFixture(),
    draft: draftFixture(),
    policy: policyFixture(),
    glossary: [glossaryFixture()],
    branchReference: branchReferenceFixture(),
    qaFindings: [qaFindingFixture()],
    runtimeEvidence: [
      runtimeTextTraceFixture(),
      runtimeScreenshotFixture(),
      runtimeBenchmarkFixture(),
      runtimeProviderProofFixture(),
    ],
    rationaleRefs: [
      rationaleFixture(),
      rationaleFixture({
        refKind: "source_revision",
        refId: fixtureSourceRevisionId,
        label: "Source revision in scope",
      }),
      rationaleFixture({
        refKind: "context_artifact",
        refId: "scene-summary:6010",
        label: "Structure-informed scene summary that fed the draft",
      }),
    ],
    structureContextFeed: structureContextFeedFixture(),
    transitions: [transitionFixture()],
    diagnostics: [],
    ...overrides,
  };
}

export function runtimeEvidenceItemFixture(
  overrides: Partial<ReviewerQueueItemRecord> = {},
): ReviewerQueueItemRecord {
  return makeItem(
    reviewerQueueItemKindValues.runtimeEvidence,
    reviewerQueueItemStateValues.pending,
    overrides,
  );
}

export function deniedContextFixture(actorUserId = "unauthorized-user"): ReviewerDetailContext {
  return {
    reviewItemId: "reviewer-queue-itotori-082",
    permission: {
      actorUserId,
      canReadQueue: false,
      canManageQueue: false,
      denialReasons: [`user ${actorUserId} is missing permission queue.read`],
    },
    item: null,
    source: null,
    draft: null,
    policy: null,
    glossary: [],
    branchReference: null,
    qaFindings: [],
    runtimeEvidence: [],
    rationaleRefs: [],
    structureContextFeed: null,
    transitions: [],
    diagnostics: [
      {
        code: reviewerDetailDiagnosticCodeValues.permissionDenied,
        message: `Reviewer detail blocked: user ${actorUserId} is missing permission queue.read.`,
      },
    ],
  };
}

export function staleContextFixture(): ReviewerDetailContext {
  const item = makeItem(reviewerQueueItemKindValues.qa, reviewerQueueItemStateValues.pending, {
    sourceRevisionId: "source-revision-itotori-082-newer",
  });
  return {
    reviewItemId: item.reviewItemId,
    permission: {
      actorUserId: "local-user",
      canReadQueue: true,
      canManageQueue: true,
      denialReasons: [],
    },
    item,
    source: sourceUnitFixture({
      sourceRevisionId: fixtureSourceRevisionId,
      contextNote: "Source revision in scope was superseded.",
    }),
    draft: null,
    policy: null,
    glossary: [],
    branchReference: null,
    qaFindings: [qaFindingFixture()],
    runtimeEvidence: [],
    rationaleRefs: [],
    structureContextFeed: null,
    transitions: [
      transitionFixture({
        action: reviewerQueueActionValues.escalate,
        nextState: reviewerQueueItemStateValues.escalated,
      }),
    ],
    diagnostics: [
      {
        code: reviewerDetailDiagnosticCodeValues.staleSourceRevision,
        message: `Item references source_revision=${item.sourceRevisionId} but loaded source bytes are on ${fixtureSourceRevisionId}; refusing to render draft / policy until the reviewer reloads.`,
      },
      {
        code: reviewerDetailDiagnosticCodeValues.missingDraft,
        message:
          "No draft attempt is associated with this reviewer-queue item; nothing to compare.",
      },
      {
        code: reviewerDetailDiagnosticCodeValues.missingPolicy,
        message:
          "Locale-branch style-guide policy version is missing; the reviewer cannot confirm policy adherence.",
      },
    ],
  };
}
