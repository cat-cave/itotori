import { type IncomingMessage, type ServerResponse } from "node:http";
import { AuthorizationError } from "@itotori/db";
import { parseItotoriSessionCookie } from "../auth-session-cookie.js";
import { configuredServicePort } from "../services/configured-port.js";
import {
  ItotoriInvalidAuthSessionError,
  type ItotoriReadOnlyServiceFactory,
  type ItotoriServiceFactory,
} from "../services/database-services.js";

export async function servePatchIterationDeliveryArchiveRequest(input: {
  request: IncomingMessage;
  response: ServerResponse;
  patchVersionId: string;
  readOnlyServiceFactory: ItotoriReadOnlyServiceFactory;
}): Promise<void> {
  if (input.request.method !== "GET")
    return writeError(input.response, 405, "method_not_allowed", "method must be GET");
  try {
    const archive = await input.readOnlyServiceFactory(
      (services) =>
        services.playTesterResultRevision.loadExactPatchArchive({
          patchVersionId: input.patchVersionId,
        }),
      sessionOptions(input.request),
    );
    if (archive === null)
      return writeError(
        input.response,
        404,
        "not_found",
        `playable patch ${input.patchVersionId} was not found`,
      );
    writeArchive(input.response, archive);
  } catch (error) {
    writeRouteError(input.response, error);
  }
}

export async function servePatchbackProduceRequest(input: {
  request: IncomingMessage;
  response: ServerResponse;
  serviceFactory: ItotoriServiceFactory;
  readJson: (request: IncomingMessage) => Promise<unknown>;
}): Promise<void> {
  if (input.request.method !== "POST")
    return writeError(input.response, 405, "method_not_allowed", "method must be POST");
  try {
    const request = parsePatchbackProduceRequest(await input.readJson(input.request));
    const archive = await input.serviceFactory((services) => {
      const produce = configuredServicePort(services, "patchbackProduce");
      if (produce === undefined) throw new Error("patchback produce service is unavailable");
      return produce.produceArchive(request);
    }, sessionOptions(input.request));
    if (archive === null)
      return writeError(
        input.response,
        404,
        "not_found",
        "no produce-eligible run was found for the requested scope",
      );
    writeArchive(input.response, archive);
  } catch (error) {
    writeRouteError(input.response, error);
  }
}

export async function servePlayDeliveryArchiveRequest(input: {
  request: IncomingMessage;
  response: ServerResponse;
  runId: string;
  readOnlyServiceFactory: ItotoriReadOnlyServiceFactory;
}): Promise<void> {
  if (input.request.method !== "GET")
    return writeError(input.response, 405, "method_not_allowed", "method must be GET");
  try {
    const archive = await input.readOnlyServiceFactory(
      (services) => services.playTesterResultRevision.loadSelectedArchive({ runId: input.runId }),
      sessionOptions(input.request),
    );
    if (archive === null)
      return writeError(
        input.response,
        404,
        "not_found",
        `selected delivered patch for run ${input.runId} was not found`,
      );
    writeArchive(input.response, archive);
  } catch (error) {
    writeRouteError(input.response, error);
  }
}

export function isPatchbackProduceRoute(pathname: string): boolean {
  return /^\/api\/patchback\/produce\/?$/u.test(pathname);
}

export function parsePlayDeliveryArchiveRoute(pathname: string): { runId: string } | null {
  const match = /^\/api\/play\/runs\/([^/]+)\/delivery\/archive\/?$/u.exec(pathname);
  const runId = match === null ? null : decodeSafePathId(match[1]);
  return runId === null ? null : { runId };
}

export function parsePatchIterationDeliveryArchiveRoute(
  pathname: string,
): { patchVersionId: string } | null {
  const match = /^\/api\/play\/patch-versions\/([^/]+)\/delivery\/archive\/?$/u.exec(pathname);
  const patchVersionId = match === null ? null : decodeSafePathId(match[1]);
  return patchVersionId === null ? null : { patchVersionId };
}

function sessionOptions(request: IncomingMessage): { sessionId?: string } | undefined {
  const sessionId = parseItotoriSessionCookie(request.headers.cookie);
  return sessionId === undefined ? undefined : { sessionId };
}

function decodeSafePathId(value: string | undefined): string | null {
  try {
    const decoded = value === undefined ? "" : decodeURIComponent(value);
    return decoded.trim() === "" ||
      decoded.includes("/") ||
      decoded.includes("\\") ||
      decoded === "." ||
      decoded === ".."
      ? null
      : decoded;
  } catch {
    return null;
  }
}

function parsePatchbackProduceRequest(body: unknown): {
  projectId?: string;
  localeBranchId?: string;
  runId?: string;
} {
  if (body === undefined) return {};
  if (typeof body !== "object" || body === null || Array.isArray(body))
    throw new SyntaxError("patchback produce request body must be a JSON object");
  const record = body as Record<string, unknown>;
  const output: { projectId?: string; localeBranchId?: string; runId?: string } = {};
  for (const key of ["projectId", "localeBranchId", "runId"] as const) {
    const value = record[key];
    if (value === undefined) continue;
    if (typeof value !== "string")
      throw new SyntaxError(`patchback produce request '${key}' must be a string`);
    output[key] = value;
  }
  return output;
}

function writeArchive(
  response: ServerResponse,
  archive: { contentType: string; bytes: Uint8Array; fileName: string },
): void {
  response.writeHead(200, {
    "content-type": archive.contentType,
    "content-length": String(archive.bytes.byteLength),
    "content-disposition": `attachment; filename="${archive.fileName}"`,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(archive.bytes);
}

function writeRouteError(response: ServerResponse, error: unknown): void {
  if (error instanceof SyntaxError) return writeError(response, 400, "bad_request", error.message);
  if (error instanceof AuthorizationError || error instanceof ItotoriInvalidAuthSessionError)
    return writeError(response, 403, "forbidden", error.message);
  writeError(
    response,
    500,
    "internal_error",
    error instanceof Error ? error.message : String(error),
  );
}

function writeError(response: ServerResponse, status: number, code: string, error: string): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify({ error, code }));
}
