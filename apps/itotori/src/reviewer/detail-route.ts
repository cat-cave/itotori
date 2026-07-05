// ITOTORI-082 — reviewer detail route loader.
//
// Resolves a `ReviewerDetailContext` for a given route param tuple and
// dispatches to `renderReviewerDetailView`. The loader is gated on
// `queue.read`: callers supply a pre-resolved
// `ReviewerDetailPermissionView` (the JSON API layer / SPA bootstrap
// resolves it via the central authorization port). If the actor lacks
// `queue.read`, the loader returns a denied-context WITHOUT consulting
// the evidence loader — the explicit guard for audit focus "Reviewer
// UI fetching evidence outside permission gates".
//
// The route loader intentionally does not call
// `authorization.requirePermission` itself: all `requirePermission`
// calls are confined to `auth.ts` / `api-handlers.ts` per the API
// mutation permission matrix audit. This keeps the matrix the single
// source of truth for permission gating, and the SPA route shares the
// same permission view it would have received from a typed API
// response.
//
// Stale / missing context surfaces as a typed diagnostic on the
// returned context; the renderer paints a banner + per-panel
// "missing context" cell so the operator is never silently shown a
// blank section (audit focus: "Missing context hidden by empty
// dashboard sections").

import {
  reviewerQueueItemKindValues,
  type ReviewerQueueItemRecord,
  type ReviewerQueueTransitionRecord,
} from "@itotori/db";
import {
  reviewerDetailDiagnosticCodeValues,
  type ReviewerDetailBranchReference,
  type ReviewerDetailContext,
  type ReviewerDetailDiagnostic,
  type ReviewerDetailDraft,
  type ReviewerDetailGlossaryEntry,
  type ReviewerDetailPermissionView,
  type ReviewerDetailPolicy,
  type ReviewerDetailQaFinding,
  type ReviewerDetailRationaleRef,
  type ReviewerDetailRuntimeEvidence,
  type ReviewerDetailSourceUnit,
  type ReviewerDetailTransition,
} from "./detail-fixtures.js";
import {
  parseReviewerDetailRoute,
  renderReviewerDetailView,
  reviewerDetailRoutePathRegex,
  type ReviewerDetailRouteParams,
} from "./detail-view.js";

export { parseReviewerDetailRoute, reviewerDetailRoutePathRegex };
export type { ReviewerDetailRouteParams };

/**
 * The empty-evidence scaffold every "no visible evidence" reviewer-detail
 * context shares: a permission-denied response and a not-found response
 * both carry a null item / source / draft / policy and empty evidence
 * arrays. This is REAL production code (NOT a test fixture): the denied
 * and not-found paths return it directly, and the JSON API layer reuses
 * it to build the permission-denied API response. Keeping it here means
 * no fixture builder is reachable from the production API/route surface.
 */
export function emptyReviewerDetailEvidence(): Pick<
  ReviewerDetailContext,
  | "item"
  | "source"
  | "draft"
  | "policy"
  | "glossary"
  | "branchReference"
  | "qaFindings"
  | "runtimeEvidence"
  | "rationaleRefs"
  | "transitions"
> {
  return {
    item: null,
    source: null,
    draft: null,
    policy: null,
    glossary: [],
    branchReference: null,
    qaFindings: [],
    runtimeEvidence: [],
    rationaleRefs: [],
    transitions: [],
  };
}

/**
 * Persistence port the loader queries for per-item evidence + draft +
 * policy. Concrete implementations are wired in
 * `services/database-services.ts`; tests pass a hand-rolled stub.
 */
export interface ReviewerDetailEvidenceLoaderPort {
  loadItem(reviewItemId: string): Promise<ReviewerQueueItemRecord | null>;
  loadTransitions(reviewItemId: string): Promise<ReviewerQueueTransitionRecord[]>;
  loadDetailEvidence(item: ReviewerQueueItemRecord): Promise<ReviewerDetailEvidencePayload>;
}

/**
 * Evidence payload returned by the loader port. Every field is
 * nullable / empty-by-default so missing references can be reported as
 * a diagnostic instead of throwing.
 *
 * `loadedSourceRevisionId` is the source revision id the loader
 * actually pulled bytes for; if it doesn't match the item's
 * `sourceRevisionId`, the loader records a `stale_source_revision`
 * diagnostic and the draft / policy panels render as missing.
 */
export type ReviewerDetailEvidencePayload = {
  loadedSourceRevisionId: string;
  source: ReviewerDetailSourceUnit | null;
  draft: ReviewerDetailDraft | null;
  policy: ReviewerDetailPolicy | null;
  glossary: ReviewerDetailGlossaryEntry[];
  /**
   * ITOTORI-139 — the exact branch policy + glossary reference the draft
   * was produced under (resolved from the `branch_policy_glossary_reference`
   * table by the live loader). Null when no reference is bound.
   */
  branchReference: ReviewerDetailBranchReference | null;
  qaFindings: ReviewerDetailQaFinding[];
  runtimeEvidence: ReviewerDetailRuntimeEvidence[];
  rationaleRefs: ReviewerDetailRationaleRef[];
  /**
   * Diagnostics the loader wants surfaced verbatim (e.g. policy
   * version flagged stale by the style-guide repository). The route
   * loader concatenates these with the diagnostics it derives locally.
   */
  diagnostics: ReviewerDetailDiagnostic[];
};

export type ReviewerDetailRouteDeps = {
  /**
   * Pre-resolved permission view for the current actor. Callers
   * resolve this via `auth.ts` / the JSON API layer so the route
   * loader does not own `requirePermission` semantics directly — the
   * API mutation permission matrix audit forbids ad-hoc
   * `requirePermission` callsites outside the canonical entry points.
   */
  permission: ReviewerDetailPermissionView;
  evidenceLoader: ReviewerDetailEvidenceLoaderPort;
};

/**
 * Load the reviewer detail context. Public surface for both the SPA
 * bootstrap and tests; routes call `renderReviewerDetailRoute` which
 * threads this loader's output through the renderer.
 */
export async function loadReviewerDetailContext(
  params: ReviewerDetailRouteParams,
  deps: ReviewerDetailRouteDeps,
): Promise<ReviewerDetailContext> {
  // Permission gate. Checked BEFORE any evidence query so the denial
  // path never touches the evidence loader (audit focus #1: "Reviewer
  // UI fetching evidence outside permission gates").
  if (!deps.permission.canReadQueue) {
    const denialReason =
      deps.permission.denialReasons[0] ??
      `user ${deps.permission.actorUserId} is missing permission queue.read`;
    return {
      ...emptyReviewerDetailEvidence(),
      reviewItemId: params.reviewItemId,
      permission: {
        ...deps.permission,
        denialReasons:
          deps.permission.denialReasons.length === 0
            ? [denialReason]
            : deps.permission.denialReasons,
      },
      diagnostics: [
        {
          code: reviewerDetailDiagnosticCodeValues.permissionDenied,
          message: denialReason,
        },
      ],
    };
  }

  const item = await deps.evidenceLoader.loadItem(params.reviewItemId);
  if (item === null) {
    return {
      ...emptyReviewerDetailEvidence(),
      reviewItemId: params.reviewItemId,
      permission: deps.permission,
      diagnostics: [
        {
          code: reviewerDetailDiagnosticCodeValues.staleSourceRevision,
          message: `Reviewer queue item ${params.reviewItemId} was not found; the item may have been deleted by a recent migration.`,
        },
      ],
    };
  }

  const [evidencePayload, transitionRecords] = await Promise.all([
    deps.evidenceLoader.loadDetailEvidence(item),
    deps.evidenceLoader.loadTransitions(item.reviewItemId),
  ]);

  const diagnostics: ReviewerDetailDiagnostic[] = [...evidencePayload.diagnostics];

  const isStaleSource =
    evidencePayload.loadedSourceRevisionId !== item.sourceRevisionId &&
    evidencePayload.source !== null;

  let source = evidencePayload.source;
  let draft = evidencePayload.draft;
  let policy = evidencePayload.policy;
  let branchReference = evidencePayload.branchReference;

  if (isStaleSource) {
    diagnostics.push({
      code: reviewerDetailDiagnosticCodeValues.staleSourceRevision,
      message: `Item references source_revision=${item.sourceRevisionId} but loaded source bytes are on ${evidencePayload.loadedSourceRevisionId}; refusing to render draft / policy until the reviewer reloads.`,
    });
    draft = null;
    policy = null;
    // The branch reference is the provenance of the draft; if we won't
    // show the draft, we won't claim which reference produced it.
    branchReference = null;
  }

  if (source === null && !isStaleSource) {
    diagnostics.push({
      code: reviewerDetailDiagnosticCodeValues.staleSourceRevision,
      message: `Source bytes for revision ${item.sourceRevisionId} could not be loaded.`,
    });
  }

  if (draft === null && !isStaleSource) {
    diagnostics.push({
      code: reviewerDetailDiagnosticCodeValues.missingDraft,
      message: "No draft attempt is associated with this reviewer-queue item; nothing to compare.",
    });
  }

  if (policy === null && !isStaleSource) {
    diagnostics.push({
      code: reviewerDetailDiagnosticCodeValues.missingPolicy,
      message:
        "Locale-branch style-guide policy version is missing; the reviewer cannot confirm policy adherence.",
    });
  }

  // A draft with no bound branch reference is a provenance gap: the
  // reviewer cannot verify WHICH policy/glossary version produced it.
  if (branchReference === null && draft !== null && !isStaleSource) {
    diagnostics.push({
      code: reviewerDetailDiagnosticCodeValues.missingBranchReference,
      message:
        "No branch policy/glossary reference is bound to this draft; the exact policy + glossary version it was produced under cannot be verified.",
    });
  }

  if (
    item.itemKind === reviewerQueueItemKindValues.glossary &&
    evidencePayload.glossary.length === 0
  ) {
    diagnostics.push({
      code: reviewerDetailDiagnosticCodeValues.missingGlossaryRef,
      message: `Glossary review item ${item.reviewItemId} did not resolve any term refs.`,
    });
  }

  if (
    item.itemKind === reviewerQueueItemKindValues.runtimeEvidence &&
    evidencePayload.runtimeEvidence.length === 0
  ) {
    diagnostics.push({
      code: reviewerDetailDiagnosticCodeValues.missingRuntimeEvidence,
      message: `Runtime-evidence review item ${item.reviewItemId} did not resolve any evidence rows.`,
    });
  }

  if (evidencePayload.rationaleRefs.length === 0) {
    diagnostics.push({
      code: reviewerDetailDiagnosticCodeValues.missingRationale,
      message: "No upstream rationale references (model run / agent attempt) were resolved.",
    });
  }

  const transitions: ReviewerDetailTransition[] = transitionRecords.map((record) => ({
    transitionId: record.transitionId,
    action: record.action,
    priorState: record.priorState,
    nextState: record.nextState,
    actorUserId: record.actorUserId,
    createdAt: record.createdAt,
  }));

  return {
    reviewItemId: item.reviewItemId,
    permission: deps.permission,
    item,
    source,
    draft,
    policy,
    glossary: evidencePayload.glossary,
    branchReference,
    qaFindings: evidencePayload.qaFindings,
    runtimeEvidence: evidencePayload.runtimeEvidence,
    rationaleRefs: evidencePayload.rationaleRefs,
    transitions,
    diagnostics,
  };
}

/**
 * SPA route handler. Renders a loading shell, fetches the context,
 * then swaps in the rendered view (or an error pane).
 */
export async function renderReviewerDetailRoute(
  root: HTMLElement,
  params: ReviewerDetailRouteParams,
  deps: ReviewerDetailRouteDeps,
): Promise<void> {
  renderLoading(root, params);
  try {
    const context = await loadReviewerDetailContext(params, deps);
    root.innerHTML = renderReviewerDetailView(context);
  } catch (error) {
    renderError(root, params, error);
  }
}

function renderLoading(root: HTMLElement, params: ReviewerDetailRouteParams): void {
  root.innerHTML = `
    <main class="itotori-shell reviewer-detail" data-state="loading"
      data-review-item-id="${escapeHtml(params.reviewItemId)}">
      <p role="status">Loading reviewer detail for ${escapeHtml(params.reviewItemId)}...</p>
    </main>
  `;
}

function renderError(root: HTMLElement, params: ReviewerDetailRouteParams, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  root.innerHTML = `
    <main class="itotori-shell reviewer-detail" data-state="error"
      data-review-item-id="${escapeHtml(params.reviewItemId)}">
      <h1>Reviewer detail unavailable</h1>
      <p role="alert">Could not load reviewer detail for ${escapeHtml(params.reviewItemId)}.</p>
      <pre>${escapeHtml(message)}</pre>
    </main>
  `;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
