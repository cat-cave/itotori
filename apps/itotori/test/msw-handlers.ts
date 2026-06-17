import { HttpResponse, http } from "msw";
import {
  assertItotoriApiResponse,
  type ItotoriApiResponseBody,
  type ItotoriApiRouteId,
} from "../src/api-schema.js";
import { dashboardStatusFixture, runtimeStatusFixture } from "./api-fixtures.js";

export const itotoriApiMswHandlers = [
  http.get("http://itotori.test/api/projects/status", () =>
    apiJson("projects.status", dashboardStatusFixture),
  ),
  http.get("http://itotori.test/api/projects", () =>
    apiJson("projects.list", { projects: [dashboardStatusFixture] }),
  ),
  http.get("http://itotori.test/api/hello/status", () =>
    apiJson("runtime.status", runtimeStatusFixture),
  ),
  http.get("http://itotori.test/api/runtime/v0.2/status", () =>
    apiJson("runtime.status", runtimeStatusFixture),
  ),
];

export function apiJson(routeId: ItotoriApiRouteId, body: ItotoriApiResponseBody): HttpResponse {
  assertItotoriApiResponse(routeId, body);
  return HttpResponse.json(body);
}
