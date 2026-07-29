// fnd-api-client — the typed DATA LAYER the Studio screens consume.
//
// This façade preserves the public client entrypoint. Route typing, request
// execution, and pagination live in focused modules behind it.

export { ApiResource, ItotoriApiClient, parseTypedApiError } from "./api-client-core.js";
export type { ItotoriApiClientOptions } from "./api-client-core.js";
export { OffsetPager } from "./api-client-pagination.js";
export type {
  OffsetCursor,
  OffsetPagerOptions,
  OffsetPagerResult,
  OffsetPaginatedRouteId,
} from "./api-client-pagination.js";
export type {
  ApiCallSettledState,
  ApiCallState,
  ApiClientError,
  ApiRequestOptionsFor,
  ApiRoutePathParams,
  ApiRouteRequestBody,
  ApiRouteResponse,
  ItotoriApiRouteId,
} from "./api-client-types.js";
