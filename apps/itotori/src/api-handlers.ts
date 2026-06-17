import type { ProjectDashboardStatus, RuntimeDashboardStatus } from "@itotori/db";
import type { ItotoriProjectWorkflowPort } from "./services/project-workflow.js";

export type ApiJsonResponse = {
  statusCode: number;
  body: ProjectDashboardStatus | RuntimeDashboardStatus | { error: string };
};

export type ProjectStatusService = Pick<
  ItotoriProjectWorkflowPort,
  "getDashboardStatus" | "getRuntimeStatus"
>;

export function isItotoriApiPath(pathname: string): boolean {
  return pathname === "/api/projects/status" || pathname === "/api/hello/status";
}

export async function handleItotoriApiRequest(
  pathname: string,
  service: ProjectStatusService,
): Promise<ApiJsonResponse> {
  switch (pathname) {
    case "/api/projects/status":
      return { statusCode: 200, body: await service.getDashboardStatus() };
    case "/api/hello/status":
      return { statusCode: 200, body: await service.getRuntimeStatus() };
    default:
      return { statusCode: 404, body: { error: `unknown API route: ${pathname}` } };
  }
}
