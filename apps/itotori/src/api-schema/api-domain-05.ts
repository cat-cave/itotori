import { ApiMemberRecord } from "./api-domain-04.js";

export type ApiRemoveMemberResponse = {
  schemaVersion: "itotori.auth.member-removed.v0";
  removedMember: ApiMemberRecord;
};

export type ApiPermissionSetRecord = {
  permissionSetId: string;
  accountId: string;
  name: string;
  permissions: string[];
};

export type ApiPermissionSetsListResponse = {
  schemaVersion: "itotori.auth.permission-sets.v0";
  accountId: string;
  permissionSets: ApiPermissionSetRecord[];
};

export type ApiPrincipalPermissionSetGrantRequest = {
  reason: string | null;
  requestId: string | null;
};

export type ApiPrincipalPermissionSetGrantResponse = {
  schemaVersion: "itotori.auth.permission-set-grant.v0";
  principalId: string;
  permissionSetId: string;
  action: "granted" | "revoked";
  updatedMember: ApiMemberRecord;
};

/**
 * ovw-launch-pass-action — request body for the launch-pass mutation. The
 * Overview action wires through the typed client. The body carries the locale
 * branch the next pass is scoped to; the server VERIFIES it against the
 * project's server-side ownership set (a forged branch is refused) before the
 * driver is touched. Cancellation is intentionally not part of this launch
 * endpoint; it needs a separate, cancellable worker control plane. The project
 * id lives on the URL path.
 */
export type ApiLaunchPassRequest = {
  /** The locale branch the next pass is scoped to (validated server-side). */
  localeBranchId: string;
};

/**
 * ovw-launch-pass-action — response body for the launch-pass mutation. A thin,
 * driver-agnostic confirmation the UI can render after a click: a typed
 * `outcome` (`started` / `refused`) plus the durable journal run identity +
 * start timestamp (on `started`) or a refusal reason (on `refused`). A refused
 * launch is surfaced in-band so the Overview strip renders it like any driver
 * response, never as a silent success.
 */
export type ApiLaunchPassResponse = {
  schemaVersion: "itotori.projects.launch-pass.v1";
  /** The driver outcome: the journal run was started, or the driver refused it. */
  outcome: "started" | "refused";
  /** The immutable journal run id on `started`; `null` on `refused`. */
  journalRunId: string | null;
  /** ISO timestamp the pass was started on `started`; `null` on `refused`. */
  startedAt: string | null;
  /** Refusal reason (non-empty) on `refused`; `null` on `started`. */
  refusalMessage: string | null;
};

// play-routemap-ui — route/choice tree read-model response. Coverage is derived
// from the route-choice map status (Fresh -> fresh, Stale -> stale).
export type ApiPlayRouteMapCoverageState = "fresh" | "stale";

export type ApiPlayRouteMapNode = {
  routeKey: string;
  routeMapId: string;
  label: string;
  summary: string;
  col: number;
  row: number;
  state: ApiPlayRouteMapCoverageState;
  coverage: ApiPlayRouteMapCoverageState;
  issues: number;
};

export type ApiPlayRouteMapEdge = {
  fromRouteKey: string;
  toRouteKey: string;
  choiceKey: string;
  choiceKind: string;
  label: string;
};

export type ApiPlayRouteMapCounts = {
  fresh: number;
  stale: number;
  total: number;
  choiceCount: number;
};

export type ApiPlayRouteMapResponse = {
  schemaVersion: "itotori.play.route-map.v0";
  generatedAt: string;
  projectId: string;
  localeBranchId: string;
  nodes: ApiPlayRouteMapNode[];
  edges: ApiPlayRouteMapEdge[];
  counts: ApiPlayRouteMapCounts;
};

/** Closed ordinal severity scale for play-flag-composer (annotation-severity tokens). */
export type ApiPlayFlagSeverity = "blocker" | "critical" | "warning" | "note";

export const API_PLAY_FLAG_SEVERITIES = [
  "blocker",
  "critical",
  "warning",
  "note",
] as const satisfies readonly ApiPlayFlagSeverity[];

/**
 * play-flag-composer — request body for composing an in-the-moment playtest
 * flag. projectId + localeBranchId live on the URL path.
 */
export type ApiPlayFlagAnnotationRequest = {
  note: string;
  severity: ApiPlayFlagSeverity;
  /** Free-form category (tone / layout / glossary / …). */
  category?: string;
  /** The persisted target unit required for the canonical correction. */
  bridgeUnitId: string;
  sourceUnitKey?: string;
  sourceBundleId?: string;
  sourceRevisionId?: string;
  sceneId?: string;
  suggestedEdit?: string;
  actorUserId?: string;
  actorDisplayName?: string;
};

/**
 * play-flag-composer — receipt for a completed canonical context correction.
 */
export type ApiPlayFlagAnnotationResponse = {
  schemaVersion: "itotori.play.flag-annotation.v0";
  projectId: string;
  localeBranchId: string;
  feedbackReportId: string;
  feedbackEvidenceId: string;
  severity: ApiPlayFlagSeverity;
  /** Null when the persisted feedback did not include a category. */
  category: string | null;
  note: string;
  triageLabel: string;
  contextStatus: string;
  /** Durable canonical-context write created by this successful flag. */
  contextCorrectionId: string;
  duplicate: boolean;
};

/** One unit-bound feedback note returned by play.unitFeedback. */
export type ApiPlayUnitFeedbackNote = {
  feedbackReportId: string;
  feedbackEvidenceId: string;
  bridgeUnitId: string;
  sceneId: string | null;
  note: string;
  severity: string;
  /** Null when the persisted feedback did not include a category. */
  category: string | null;
  triageLabel: string;
  contextStatus: string;
  contextCorrectionId: string;
  reportedAt: string;
  duplicate: boolean;
};

/**
 * Unit-bound feedback list — every note the flag path wrote against one unit.
 */
export type ApiPlayUnitFeedbackResponse = {
  schemaVersion: "itotori.play.unit-feedback.v0";
  projectId: string;
  localeBranchId: string;
  bridgeUnitId: string;
  notes: ApiPlayUnitFeedbackNote[];
};

/** A cited bridge unit resolved against the active imported bridge, never a
 * browser guess from an engine-specific source key. */
export type ApiPlayAddressableUnitResponse = {
  schemaVersion: "itotori.play.addressable-unit.v0";
  projectId: string;
  localeBranchId: string;
  unit:
    | { bridgeUnitId: string; state: "resolved"; sceneId: string; sourceUnitKey: string }
    | {
        bridgeUnitId: string;
        state: "unresolvable";
        reason: "not_imported_in_branch" | "scene_coordinate_missing";
      };
};

/**
 * p0-result-revision — the play-tester mutation accepts exactly one target
 * line. The parent delivered patch is the URL resource; actor provenance and
 * artifact roots are bound server-side and cannot be fabricated in the body.
 */
export type ApiPlayTargetEditRequest = {
  bridgeUnitId: string;
  targetBody: string;
};

/**
 * p0-result-revision — concise mutation confirmation. It identifies the new
 * result revision and selected child delivered patch without exposing source
 * text or server-local artifact paths.
 */
export type ApiPlayTargetEditResponse = {
  schemaVersion: "itotori.play.target-edit.v0";
  resultRevisionId: string;
  patchVersionId: string;
  runId: string;
  parentPatchVersionId: string;
  bridgeUnitId: string;
  targetBody: string;
  status: "playable";
  selectedAt: string;
  idempotentReplay: boolean;
};

/** p0-result-revision — one ordered delivered target unit in the export view. */
export type ApiPlayDeliveryUnit = {
  bridgeUnitId: string;
  unitOrdinal: number;
  targetBody: string;
};

/**
 * p0-result-revision — selected, deliverable patch export for a run. Artifact
 * references and hashes prove the production delivery artifact selected by the
 * mutation; units remain in their patch ordinal order.
 */
export type ApiPlayDeliveryResponse = {
  schemaVersion: "itotori.play.delivery.v0";
  patchVersionId: string;
  runId: string;
  parentPatchVersionId: string | null;
  status: string;
  selectedAt: string;
  artifactHashes: Record<string, string>;
  /** Authenticated binary delivery endpoint; never a server filesystem path. */
  downloadUrl: string;
  units: ApiPlayDeliveryUnit[];
};

// ---------------------------------------------------------------------------
// Node 11 — patch-version iteration wire shapes. These deliberately expose
// immutable identifiers and delivery hashes, never local artifact paths.
// ---------------------------------------------------------------------------

/**
 * Exact immutable-version delivery. Unlike `ApiPlayDeliveryResponse`, this
 * remains available after a newer version becomes the selected run delivery.
 */
export type ApiPatchIterationDeliveryResponse = {
  schemaVersion: "itotori.patch-iteration.delivery.v0";
  patchVersionId: string;
  runId: string;
  parentPatchVersionId: string | null;
  origin: "run_finalizer" | "play_tester_edit" | "refinement_run";
  status: "playable";
  playableAt: string;
  artifactHashes: Record<string, string>;
  /** Authenticated exact-version archive endpoint; never a server path. */
  downloadUrl: string;
  units: ApiPlayDeliveryUnit[];
};
