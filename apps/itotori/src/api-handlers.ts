import * as contracts from "./api-handler-contracts.js";
import * as responses from "./api-handler-responses.js";
import * as routes from "./api-handler-routes.js";

export { apiMutationPermissionGates } from "./api-handler-contracts.js";
export type {
  ApiJsonResponse,
  ApiMutationPermissionGate,
  ItotoriApiRequest,
  ItotoriApiServices,
  ItotoriReadOnlyApiServices,
  PlayTesterResultRevisionApiPort,
} from "./api-handler-contracts.js";
export { readOnlyApiServices } from "./api-handler-contracts.js";

export function isItotoriApiPath(pathname: string): boolean {
  return pathname.startsWith("/api/");
}

export async function handleItotoriApiRequest(
  request: contracts.ItotoriApiRequest,
  services: contracts.ItotoriApiServices,
): Promise<contracts.ApiJsonResponse> {
  try {
    return await routes.routeItotoriApiRequest(request, services);
  } catch (error) {
    const draftRefusal = responses.draftProviderConfigurationResponse(request, error);
    if (draftRefusal !== null) return draftRefusal;
    return responses.errorResponse(error);
  }
}

export async function handleReadOnlyItotoriApiRequest(
  request: contracts.ItotoriApiRequest,
  services: contracts.ItotoriReadOnlyApiServices,
): Promise<contracts.ApiJsonResponse> {
  try {
    const response = await routes.routeReadOnlyItotoriApiRequest(request, services);
    return response ?? routes.readOnlyMutationPathResponse(request);
  } catch (error) {
    return responses.errorResponse(error);
  }
}
