import { renderDashboard } from "./dashboard.js";
import { renderStyleGuideBuilderRoute } from "./style-guide-builder.js";
import { parseAssetDecisionsRoute, renderAssetDecisionsRoute } from "./asset-decisions/route.js";
import {
  parseReviewerBatchRoute,
  parseReviewerDetailRoute,
  renderReviewerBatchRoute,
  renderReviewerDetailRoute,
  ReviewerBatchPreviewService,
  type ReviewerBatchActionRequest,
  type ReviewerBatchConsequenceResolverPort,
  type ReviewerDetailEvidenceLoaderPort,
  type ReviewerDetailEvidencePayload,
} from "./reviewer/index.js";
import { resolveReviewerQueuePermissionView, type ItotoriAuthorizationPort } from "./auth.js";
import { AuthorizationError, reviewerQueueActionValues, type Permission } from "@itotori/db";

const root = document.querySelector<HTMLDivElement>("#app")!;

const assetDecisionsParams = parseAssetDecisionsRoute(window.location.pathname);
const reviewerDetailParams = parseReviewerDetailRoute(window.location.pathname);
const reviewerBatchHit = parseReviewerBatchRoute(window.location.pathname);
if (assetDecisionsParams !== null) {
  await renderAssetDecisionsRoute(root, assetDecisionsParams);
} else if (reviewerBatchHit !== null) {
  // ITOTORI-083 — the SPA bootstrap resolves the actor's reviewer
  // queue permission view and renders the batch preview. The browser
  // shell has no real backend selection state today, so the request is
  // synthesized from the URL search params with `action=approve` +
  // empty selections; the renderer surfaces the empty-selection fixture
  // until a future spec wires a real dashboard checkbox state into the
  // request. `requirePermission` stays in `auth.ts`.
  const localActorUserId = "local-user";
  const authorization = makeStaticAuthorization(localActorUserId, []);
  const permission = await resolveReviewerQueuePermissionView(authorization, localActorUserId);
  const previewService = new ReviewerBatchPreviewService(makeStaticConsequenceResolver());
  const request: ReviewerBatchActionRequest = {
    action: reviewerQueueActionValues.approve,
    actorUserId: localActorUserId,
    selections: [],
  };
  await renderReviewerBatchRoute(root, request, {
    permission,
    previewService,
  });
} else if (reviewerDetailParams !== null) {
  // ITOTORI-082 — the SPA bootstrap resolves the actor's reviewer
  // queue permission view via the auth port, then passes it to the
  // detail route. The detail route never calls `requirePermission`
  // itself (the API mutation permission matrix audit confines those
  // calls to `auth.ts` / `api-handlers.ts`). The browser shell has no
  // grants today, so the route will render the denial UI until a
  // future spec wires a real evidence loader and a grant-aware
  // authorization port.
  const localActorUserId = "local-user";
  const authorization = makeStaticAuthorization(localActorUserId, []);
  const permission = await resolveReviewerQueuePermissionView(authorization, localActorUserId);
  const evidenceLoader = makeStaticEvidenceLoader();
  await renderReviewerDetailRoute(root, reviewerDetailParams, {
    permission,
    evidenceLoader,
  });
} else if (window.location.pathname === "/style-guide-builder") {
  await renderStyleGuideBuilderRoute(root);
} else {
  await renderDashboard(root);
}

function makeStaticAuthorization(
  actorUserId: string,
  grantedPermissions: Permission[],
): ItotoriAuthorizationPort {
  const granted = new Set<Permission>(grantedPermissions);
  return {
    requirePermission: async (permission) => {
      if (!granted.has(permission)) {
        throw new AuthorizationError({ userId: actorUserId }, permission);
      }
    },
  };
}

function makeStaticConsequenceResolver(): ReviewerBatchConsequenceResolverPort {
  // The browser-side bootstrap has no DB, so every batch preview
  // resolves to an empty per-item set. The renderer still surfaces
  // every requested id with its diagnostic — never silently empty.
  return {
    loadItem: async (_id) => null,
    resolveConsequences: async (_input) => [],
  };
}

function makeStaticEvidenceLoader(): ReviewerDetailEvidenceLoaderPort {
  // The browser-side bootstrap has no DB; the loader returns an empty
  // payload so the detail page renders the "missing context"
  // diagnostics if it is ever reached. (It will not be reached given
  // the static authorization denies queue.read, but the implementation
  // is kept honest so the renderer never silently shows an empty
  // section.)
  return {
    loadItem: async (_reviewItemId) => null,
    loadTransitions: async (_reviewItemId) => [],
    loadDetailEvidence: async (_item): Promise<ReviewerDetailEvidencePayload> => ({
      loadedSourceRevisionId: "",
      source: null,
      draft: null,
      policy: null,
      glossary: [],
      qaFindings: [],
      runtimeEvidence: [],
      rationaleRefs: [],
      diagnostics: [],
    }),
  };
}
