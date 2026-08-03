import * as contracts from "./api-handler-contracts.js";
import * as deps from "./api-handler-dependencies.js";
import * as mutations from "./api-handler-mutation-settings-auth.js";
import * as projectMutations from "./api-handler-mutation-project.js";
import * as wikiAndPlayMutations from "./api-handler-mutation-wiki-play.js";
import * as projectAndAuthReads from "./api-handler-read-project-auth.js";
import * as catalogAndPlayReads from "./api-handler-read-catalog-play.js";
import * as responses from "./api-handler-responses.js";

export async function routeReadOnlyItotoriApiRequest(
  request: contracts.ItotoriApiRequest,
  services: contracts.ItotoriReadOnlyApiServices,
): Promise<contracts.ApiJsonResponse | null> {
  const projectAndAuthResponse = await projectAndAuthReads.routeProjectAndAuthReads(
    request,
    services,
  );
  if (projectAndAuthResponse !== null) return projectAndAuthResponse;
  return catalogAndPlayReads.routeCatalogAndPlayReads(request, services);
}

export async function routeItotoriApiRequest(
  request: contracts.ItotoriApiRequest,
  services: contracts.ItotoriApiServices,
): Promise<contracts.ApiJsonResponse> {
  const readOnlyResponse = await routeReadOnlyItotoriApiRequest(
    request,
    contracts.readOnlyApiServices(services),
  );
  if (readOnlyResponse !== null) return readOnlyResponse;
  const wikiAndPlayResponse = await wikiAndPlayMutations.routeWikiAndPlayMutations(
    request,
    services,
  );
  if (wikiAndPlayResponse !== null) return wikiAndPlayResponse;
  const settingsAndAuthResponse = await mutations.routeSettingsAndAuthMutations(request, services);
  if (settingsAndAuthResponse !== null) return settingsAndAuthResponse;
  return projectMutations.routeProjectMutations(request, services);
}

export function readOnlyMutationPathResponse(
  request: contracts.ItotoriApiRequest,
): contracts.ApiJsonResponse {
  if (request.pathname === "/api/settings/security/sso")
    return responses.methodNotAllowed(["POST"]);
  if (request.pathname === "/api/settings/model-routing")
    return responses.methodNotAllowed(["GET", "POST"]);
  if (deps.parseBranchPolicySettingsApiRoute(request.pathname) !== null)
    return responses.methodNotAllowed(["GET", "POST"]);
  if (deps.parseTranslationScopeSettingsApiRoute(request.pathname) !== null)
    return responses.methodNotAllowed(["GET", "POST"]);
  if (deps.parseLocalizationRunConfigApiRoute(request.pathname) !== null)
    return responses.methodNotAllowed(["POST"]);
  if (deps.parseLocalizationPassControlApiRoute(request.pathname) !== null)
    return responses.methodNotAllowed(["POST"]);
  if (
    request.pathname === "/api/auth/members/invitations" ||
    deps.parseAuthMemberAcceptRoute(request.pathname) !== null ||
    deps.parseAuthMemberRemoveRoute(request.pathname) !== null
  )
    return responses.methodNotAllowed(["POST"]);
  if (
    deps.parseAuthPermissionSetGrantRoute(request.pathname) !== null ||
    deps.parseAuthPermissionSetRevokeRoute(request.pathname) !== null
  )
    return responses.methodNotAllowed(["POST"]);
  if (deps.parsePlayFlagApiRoute(request.pathname) !== null)
    return responses.methodNotAllowed(["POST"]);
  if (deps.parsePlayTargetEditApiRoute(request.pathname) !== null)
    return responses.methodNotAllowed(["POST"]);
  if (deps.parsePatchIterationApiRoute(request.pathname) !== null)
    return responses.methodNotAllowed(["POST"]);
  if (deps.parseCatalogContextPanelApiRoute(request.pathname) !== null)
    return responses.methodNotAllowed(["GET"]);
  if (responses.parseProjectRoute(request.pathname) !== null)
    return responses.methodNotAllowed(["POST"]);
  return responses.notFound(request.pathname);
}
