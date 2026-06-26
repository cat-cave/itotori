import { renderDashboard } from "./dashboard.js";
import { renderStyleGuideBuilderRoute } from "./style-guide-builder.js";
import { parseAssetDecisionsRoute, renderAssetDecisionsRoute } from "./asset-decisions/route.js";
import {
  parseReviewerDetailRoute,
  renderReviewerDetailRoute,
  type ReviewerDetailEvidenceLoaderPort,
  type ReviewerDetailEvidencePayload,
} from "./reviewer/index.js";
import { resolveReviewerQueuePermissionView, type ItotoriAuthorizationPort } from "./auth.js";
import { AuthorizationError, type Permission } from "@itotori/db";

const root = document.querySelector<HTMLDivElement>("#app")!;

const assetDecisionsParams = parseAssetDecisionsRoute(window.location.pathname);
const reviewerDetailParams = parseReviewerDetailRoute(window.location.pathname);
if (assetDecisionsParams !== null) {
  await renderAssetDecisionsRoute(root, assetDecisionsParams);
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
